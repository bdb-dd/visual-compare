import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { openDatabase } from '../src/db/client.js';
import type { Db } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';
import { JobQueue } from '../src/services/queue.js';
import { createArtifactStore } from '../src/services/artifact-store.js';
import { createApp } from '../src/app.js';
import { Evaluator } from '../src/services/evaluator.js';
import type { CaptureWorker } from '../src/services/capture.js';
import type { ComparisonImagick } from '../src/services/comparison.js';
import type { LmClient } from '../src/services/lm.js';
import type { SessionResultRow, UrlPairRow, ViewportDef } from '../src/types.js';

const desktop: ViewportDef = {
  name: 'desktop',
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  orientation: 'landscape',
};

/**
 * A capture worker that records each invocation and lets a test seed
 * `failNext` to make the next call throw. The orchestrator catches the
 * throw and marks the capture row 'error' with the message — exactly the
 * scenario where Phase 6's results UI was showing only "pending".
 */
function controllableWorker(state: { failNext: string | null }): CaptureWorker {
  let counter = 0;
  return {
    capture: async (args) => {
      if (state.failNext !== null) {
        const msg = state.failNext;
        state.failNext = null;
        throw new Error(msg);
      }
      const dir = join(tmpdir(), 'vc-pending-test');
      await mkdir(dir, { recursive: true });
      const path = join(dir, `cap-${counter++}.png`);
      await writeFile(path, Buffer.from(`STUB\nurl=${args.url}\n`));
      return { tempPath: path, durationMs: 1, metadata: { stub: true } };
    },
    shutdown: async () => {},
  };
}

function stubImagick(): ComparisonImagick {
  return {
    compareAe: async (_a, _b, diffPath) => {
      await mkdir(dirname(diffPath), { recursive: true });
      await writeFile(diffPath, Buffer.from('STUB-DIFF'));
      return {
        aePixels: 100,
        totalPixels: 10_000,
        changedPixelPercentage: 1,
        diffImagePath: diffPath,
        width: 100,
        height: 100,
      };
    },
    compareSsim: async () => 0.97,
    extractConnectedComponents: async () => ({
      format: 'json',
      raw: JSON.stringify([
        { id: 1, area: 80, geometry: '40x20+10+20', color: 'srgba(255,0,0,1)' },
      ]),
    }),
  };
}

function stubLm(): LmClient {
  return {
    config: {
      baseURL: 'http://stub',
      apiKey: 'stub',
      model: 'stub-model',
      promptVersion: 'env-fallback',
      autoStart: false,
      autoLoad: false,
      preflightCacheSeconds: 0,
    },
    preflight: async () => ({
      ok: true,
      serverReachable: true,
      modelLoaded: true,
      configuredModel: 'stub-model',
      loadedModels: ['stub-model'],
      startedServer: false,
      loadedModel: false,
      durationMs: 0,
    }),
    invalidatePreflight: () => undefined,
    analyze: async () => ({
      parsed: { equivalent: true, confidence: 1, summary: 's', differences: [] },
      rawText: '{}',
      path: 'json_schema',
      promptVersion: 'env-fallback',
      model: 'stub-model',
    }),
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  db: Db;
  queue: JobQueue;
  evaluator: Evaluator;
  workerState: { failNext: string | null };
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-pending-itest-'));
  const db = openDatabase({ path: ':memory:' });
  runMigrations(db);
  const queue = new JobQueue(db);
  const artifactStore = createArtifactStore(storeDir);
  const workerState = { failNext: null as string | null };
  const captureWorker = controllableWorker(workerState);
  const imagick = stubImagick();
  const lm = stubLm();
  const evaluator = new Evaluator({
    db,
    queue,
    artifactStore,
    worker: captureWorker,
    imagick,
    lm,
  });
  const app = createApp({ db, queue, artifactStore, captureWorker, imagick, lm, evaluator });
  return {
    app,
    db,
    queue,
    evaluator,
    workerState,
    cleanup: async () => {
      await rm(storeDir, { recursive: true, force: true });
      db.close();
    },
  };
}

async function uploadOnePair(app: Harness['app']): Promise<{ sessionId: string; pair: UrlPairRow }> {
  const csv = ['url_a,url_b,label', 'https://a.test,https://b.test,P1'].join('\n');
  const upload = await request(app)
    .post('/api/sessions')
    .field('name', 'pending')
    .attach('csv', Buffer.from(csv), 'p.csv');
  expect(upload.status).toBe(201);
  return {
    sessionId: upload.body.session.id as string,
    pair: upload.body.url_pairs[0] as UrlPairRow,
  };
}

async function settle(h: Harness): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await h.evaluator.drainAll();
    await h.queue.drain();
  }
}

describe('SessionResultRow capture statuses', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('reports complete on both sides when captures succeed', async () => {
    const { sessionId } = await uploadOnePair(h.app);
    h.evaluator.start(sessionId, {
      viewports: [desktop],
      equivalence_levels: ['tolerant'],
    });
    await settle(h);

    const res = await request(h.app).get(`/api/sessions/${sessionId}/results`);
    expect(res.status).toBe(200);
    const row = res.body.results[0] as SessionResultRow;
    expect(row.capture_a_status).toEqual({ status: 'complete', error_message: null });
    expect(row.capture_b_status).toEqual({ status: 'complete', error_message: null });
    expect(row.status).toBe('cached');
  });

  it('surfaces the capture error message when one side failed', async () => {
    const { sessionId } = await uploadOnePair(h.app);

    // Inject one failure via a pre-seeded errored capture row instead of
    // racing the worker's failNext (the orchestrator captures both sides
    // in parallel under the bounded limit).
    const captureRunId = randomUUID();
    const jobId = randomUUID();
    const now = new Date().toISOString();
    h.db.prepare(
      `INSERT INTO jobs (id, type, status, progress_current, progress_total, created_at)
         VALUES (?, 'capture', 'complete', 1, 1, ?)`,
    ).run(jobId, now);
    h.db.prepare(
      `INSERT INTO capture_runs (id, session_id, job_id, options_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(
      captureRunId,
      sessionId,
      jobId,
      JSON.stringify({ viewports: [desktop] }),
      now,
    );
    const detail = await request(h.app).get(`/api/sessions/${sessionId}`);
    const pair = detail.body.url_pairs[0] as UrlPairRow;
    h.db.prepare(
      `INSERT INTO captures
         (id, capture_run_id, url_pair_id, side, url, status, viewport_name,
          error_message, created_at)
         VALUES (?, ?, ?, 'a', ?, 'error', 'desktop', ?, ?)`,
    ).run(
      randomUUID(),
      captureRunId,
      pair.id,
      pair.url_a,
      'navigation timeout 30000ms exceeded',
      now,
    );

    const res = await request(h.app).get(`/api/sessions/${sessionId}/results`);
    const row = res.body.results[0] as SessionResultRow;
    expect(row.capture_a_status).toEqual({
      status: 'error',
      error_message: 'navigation timeout 30000ms exceeded',
    });
    expect(row.capture_b_status.status).toBe('missing');
    expect(row.status).toBe('pending');
  });

  it('reports missing when no capture has been attempted', async () => {
    const { sessionId } = await uploadOnePair(h.app);
    const res = await request(h.app).get(`/api/sessions/${sessionId}/results`);
    const row = res.body.results[0] as SessionResultRow;
    expect(row.capture_a_status.status).toBe('missing');
    expect(row.capture_b_status.status).toBe('missing');
  });
});
