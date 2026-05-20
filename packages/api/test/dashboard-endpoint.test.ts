import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import request from 'supertest';
import { openDatabase } from '../src/db/client.js';
import type { Db } from '../src/db/client.js';
import { applySchema } from '../src/db/schema.js';
import { JobQueue } from '../src/services/queue.js';
import { createArtifactStore } from '../src/services/artifact-store.js';
import { createApp } from '../src/app.js';
import { Evaluator } from '../src/services/evaluator.js';
import type { CaptureWorker } from '../src/services/capture.js';
import type { ComparisonImagick } from '../src/services/comparison.js';
import type { LmClient } from '../src/services/lm.js';
import type { ViewportDef } from '../src/types.js';

/**
 * Smoke coverage for the two new consolidated polling endpoints:
 *
 *   GET /api/sessions/:id/dashboard?since=&eval=
 *   GET /api/meta/system-status
 *
 * These fold what used to be six separate polls down to two. The tests
 * verify the response shapes match what the web hooks consume so the
 * client code stays correct.
 */

const desktop: ViewportDef = {
  name: 'desktop',
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  orientation: 'landscape',
};

function stubWorker(): CaptureWorker {
  let n = 0;
  return {
    capture: async (args) => {
      const dir = join(tmpdir(), 'vc-dashboard-test');
      await mkdir(dir, { recursive: true });
      const path = join(dir, `cap-${++n}.png`);
      await writeFile(path, Buffer.from(`STUB-${n}\nurl=${args.url}\n`));
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
    compareSsim: async () => 0.98,
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
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-dashboard-itest-'));
  const db = openDatabase({ path: ':memory:' });
  applySchema(db);
  const queue = new JobQueue(db);
  const artifactStore = createArtifactStore(storeDir);
  const captureWorker = stubWorker();
  const imagick = stubImagick();
  const lm = stubLm();
  const evaluator = new Evaluator({
    db,
    queue,
    artifactStore,
    worker: captureWorker,
    imagick,
    lm,
    pollIntervalMs: 10,
  });
  const app = createApp({ db, queue, artifactStore, captureWorker, imagick, lm, evaluator });
  return {
    app,
    db,
    queue,
    evaluator,
    cleanup: async () => {
      await rm(storeDir, { recursive: true, force: true });
      db.close();
    },
  };
}

async function settle(h: Harness): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await h.evaluator.drainAll();
    await h.queue.drain();
  }
}

async function uploadOnePair(h: Harness): Promise<{ sessionId: string }> {
  const csv = 'url_a,url_b,label\nhttps://a.test,https://b.test,P1';
  const upload = await request(h.app)
    .post('/api/sessions')
    .field('name', 'dash')
    .attach('csv', Buffer.from(csv), 'p.csv');
  expect(upload.status).toBe(201);
  const sessionId = upload.body.session.id as string;
  await request(h.app)
    .put(`/api/sessions/${sessionId}/config`)
    .send({ default_viewports: [desktop] });
  return { sessionId };
}

describe('GET /api/sessions/:id/dashboard', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('returns the per-session aggregate shape with capture_eta + evaluation; results_delta is null without ?since=', async () => {
    const { sessionId } = await uploadOnePair(h);
    h.evaluator.start(sessionId, { viewports: [desktop], target_level: 'tolerant' });
    await settle(h);

    const res = await request(h.app).get(`/api/sessions/${sessionId}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(sessionId);
    // The evaluator just finished; the dashboard's eval lookup falls back
    // to most-recent and surfaces it.
    expect(res.body.evaluation).not.toBeNull();
    expect(res.body.evaluation.status).toBe('complete');
    expect(res.body.results_delta).toBeNull();
    expect(res.body.capture_eta).toBeDefined();
    expect(res.body.capture_eta.members).toEqual({});
    expect(res.body.config).toBeNull();
  });

  it('returns results_delta + a fresh cursor when ?since= is provided', async () => {
    const { sessionId } = await uploadOnePair(h);
    h.evaluator.start(sessionId, { viewports: [desktop], target_level: 'tolerant' });
    await settle(h);

    const baseline = new Date(Date.now() - 60_000).toISOString();
    const res = await request(h.app).get(
      `/api/sessions/${sessionId}/dashboard?since=${encodeURIComponent(baseline)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.results_delta).not.toBeNull();
    expect(res.body.results_delta.cursor).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.results_delta.plan).toBeDefined();
    expect(res.body.results_delta.summary).toBeDefined();
    // Since the eval just completed, changed_pair_keys carries the
    // newly-decided comparison for our one pair.
    expect(Array.isArray(res.body.results_delta.changed_pair_keys)).toBe(true);
    expect(res.body.results_delta.latest_evaluation).not.toBeNull();
    expect(res.body.config).not.toBeNull();
  });

  it('honors ?eval= and returns the named evaluation rather than most-recent', async () => {
    const { sessionId } = await uploadOnePair(h);
    const first = h.evaluator.start(sessionId, { viewports: [desktop], target_level: 'tolerant' });
    await settle(h);

    const res = await request(h.app).get(
      `/api/sessions/${sessionId}/dashboard?eval=${first.evaluation_id}`,
    );
    expect(res.body.evaluation.id).toBe(first.evaluation_id);
  });

  it('404s when the session does not exist', async () => {
    const res = await request(h.app).get('/api/sessions/does-not-exist/dashboard');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/meta/system-status', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('returns lm + lm_activity + worker_activity in one response', async () => {
    const res = await request(h.app).get('/api/meta/system-status');
    expect(res.status).toBe(200);
    expect(res.body.lm).toBeDefined();
    expect(res.body.lm.ok).toBe(true);
    expect(res.body.lm.configured_model).toBe('stub-model');
    expect(res.body.lm_activity).toEqual({ samples: [], parallel: 0, interval_ms: 0 });
    expect(res.body.worker_activity).toEqual({ samples: [], capacity: 0, interval_ms: 0 });
  });
});
