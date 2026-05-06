import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { openDatabase } from '../src/db/client.js';
import type { Db } from '../src/db/client.js';
import { applySchema } from '../src/db/schema.js';
import { JobQueue } from '../src/services/queue.js';
import { createArtifactStore } from '../src/services/artifact-store.js';
import type { CaptureWorker } from '../src/services/capture.js';
import type { ComparisonImagick } from '../src/services/comparison.js';
import type { LmClient } from '../src/services/lm.js';
import { createApp } from '../src/app.js';
import { runCacheBackfill } from '../src/services/cache-backfill.js';
import { captureOptsHashFor } from '../src/services/capture-opts-hash.js';
import { captureRunOptionsSchema } from '../src/services/capture.js';
import { PIPELINE_VERSION } from '../src/constants/pipeline.js';
import type { ViewportDef } from '../src/types.js';

const desktop: ViewportDef = {
  name: 'desktop',
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  orientation: 'landscape',
};

function stubCaptureWorker(): CaptureWorker {
  let counter = 0;
  return {
    capture: async (args) => {
      const dir = join(tmpdir(), 'vc-cache-test-captures');
      await mkdir(dir, { recursive: true });
      const path = join(dir, `cap-${counter++}.png`);
      const payload = Buffer.from(
        `STUB\nurl=${args.url}\nvw=${args.viewport.name}\n`,
      );
      await writeFile(path, payload);
      return { tempPath: path, durationMs: 1, metadata: { stub: true } };
    },
    shutdown: async () => {},
  };
}

function stubImagick(diffBytes: Buffer): ComparisonImagick {
  return {
    compareAe: async (_a, _b, diffPath) => {
      await mkdir(join(diffPath, '..'), { recursive: true });
      await writeFile(diffPath, diffBytes);
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
      promptVersion: 'test-prompt',
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
      parsed: {
        equivalent: false,
        confidence: 0.7,
        summary: 'stub LM verdict',
        differences: [],
      },
      rawText: '{}',
      path: 'json_schema',
      promptVersion: 'test-prompt',
      model: 'stub-model',
    }),
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  db: Db;
  queue: JobQueue;
  storeDir: string;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-cache-itest-'));
  const db = openDatabase({ path: ':memory:' });
  applySchema(db);
  const queue = new JobQueue(db);
  const artifactStore = createArtifactStore(storeDir);
  const app = createApp({
    db,
    queue,
    artifactStore,
    captureWorker: stubCaptureWorker(),
    imagick: stubImagick(Buffer.from('STUB-DIFF')),
    lm: stubLm(),
  });
  return {
    app,
    db,
    queue,
    storeDir,
    cleanup: async () => {
      await rm(storeDir, { recursive: true, force: true });
      db.close();
    },
  };
}

async function uploadSession(app: Harness['app']): Promise<string> {
  const csv = [
    'url_a,url_b,label',
    'https://a1.example.com,https://b1.example.com,Pair 1',
  ].join('\n');
  const upload = await request(app)
    .post('/api/sessions')
    .field('name', 'cache-test')
    .attach('csv', Buffer.from(csv), 'pairs.csv');
  expect(upload.status).toBe(201);
  return upload.body.session.id as string;
}

describe('cache upserts', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('writes capture_cache rows when captures complete', async () => {
    const sessionId = await uploadSession(h.app);
    const optionsBody = {
      viewports: [desktop],
      hideSelectors: ['.banner'],
    };
    const start = await request(h.app)
      .post('/api/capture-runs')
      .send({ session_id: sessionId, options: optionsBody });
    expect(start.status).toBe(202);

    await h.queue.drain();

    const expectedHash = captureOptsHashFor(
      desktop,
      captureRunOptionsSchema.parse(optionsBody),
    );

    const rows = h.db
      .prepare<unknown[], { url: string; viewport_name: string; capture_opts_hash: string; screenshot_sha256: string }>(
        'SELECT url, viewport_name, capture_opts_hash, screenshot_sha256 FROM capture_cache ORDER BY url',
      )
      .all();

    expect(rows).toHaveLength(2); // 1 pair × 2 sides
    for (const r of rows) {
      expect(r.viewport_name).toBe('desktop');
      expect(r.capture_opts_hash).toBe(expectedHash);
      expect(r.screenshot_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const urls = rows.map((r) => r.url).sort();
    expect(urls).toEqual(['https://a1.example.com', 'https://b1.example.com']);
  });

  it('writes pixel and lm cache rows on a target_level_failure second pass', async () => {
    const sessionId = await uploadSession(h.app);
    const captureStart = await request(h.app)
      .post('/api/capture-runs')
      .send({ session_id: sessionId, options: { viewports: [desktop] } });
    await h.queue.drain();
    const captureRunId = captureStart.body.capture_run_id as string;

    // pct=1, ssim=0.97 → tolerant matches by pixel; target=strict misses;
    // invokeLm=true triggers target_level_failure LM call.
    const compStart = await request(h.app)
      .post('/api/comparison-runs')
      .send({
        session_id: sessionId,
        capture_run_id: captureRunId,
        options: { targetLevel: 'strict', invokeLm: true },
      });
    expect(compStart.status).toBe(202);
    await h.queue.drain();

    const pixelRows = h.db
      .prepare<unknown[], { capture_a_sha: string; capture_b_sha: string; pipeline_version: string; changed_pct: number; ssim: number }>(
        'SELECT capture_a_sha, capture_b_sha, pipeline_version, changed_pct, ssim FROM pixel_compare_cache',
      )
      .all();
    expect(pixelRows).toHaveLength(1);
    expect(pixelRows[0]!.pipeline_version).toBe(PIPELINE_VERSION);
    expect(pixelRows[0]!.changed_pct).toBe(1);
    expect(pixelRows[0]!.ssim).toBe(0.97);

    const lmRows = h.db
      .prepare<unknown[], { prompt_id: string; model_id: string; invocation_reason: string; pipeline_version: string; verdict: number }>(
        'SELECT prompt_id, model_id, invocation_reason, pipeline_version, verdict FROM lm_verdict_cache',
      )
      .all();
    expect(lmRows).toHaveLength(1);
    expect(lmRows[0]).toMatchObject({
      prompt_id: 'test-prompt',
      model_id: 'stub-model',
      invocation_reason: 'target_level_failure',
      pipeline_version: PIPELINE_VERSION,
      verdict: 0,
    });
  });

  it('does not write lm_verdict_cache when LM was not invoked', async () => {
    const sessionId = await uploadSession(h.app);
    const captureStart = await request(h.app)
      .post('/api/capture-runs')
      .send({ session_id: sessionId, options: { viewports: [desktop] } });
    await h.queue.drain();
    const captureRunId = captureStart.body.capture_run_id as string;

    // tolerant target with the stub metrics → pixel matches, no LM, no
    // ambiguity band hit. invokeLm omitted so no second pass either.
    await request(h.app)
      .post('/api/comparison-runs')
      .send({
        session_id: sessionId,
        capture_run_id: captureRunId,
        options: { targetLevel: 'tolerant' },
      });
    await h.queue.drain();

    const lmCount = h.db
      .prepare<unknown[], { c: number }>('SELECT COUNT(*) AS c FROM lm_verdict_cache')
      .get();
    expect(lmCount?.c).toBe(0);

    const pixelCount = h.db
      .prepare<unknown[], { c: number }>('SELECT COUNT(*) AS c FROM pixel_compare_cache')
      .get();
    expect(pixelCount?.c).toBe(1);
  });

  it('replaces capture_cache row when the same options re-capture', async () => {
    const sessionId = await uploadSession(h.app);
    const optionsBody = { viewports: [desktop] };

    await request(h.app)
      .post('/api/capture-runs')
      .send({ session_id: sessionId, options: optionsBody });
    await h.queue.drain();

    const firstRows = h.db
      .prepare<unknown[], { capture_id: string }>('SELECT capture_id FROM capture_cache ORDER BY url')
      .all();
    const firstIds = firstRows.map((r) => r.capture_id);

    await request(h.app)
      .post('/api/capture-runs')
      .send({ session_id: sessionId, options: optionsBody });
    await h.queue.drain();

    const cacheCount = h.db
      .prepare<unknown[], { c: number }>('SELECT COUNT(*) AS c FROM capture_cache')
      .get();
    expect(cacheCount?.c).toBe(2); // 1 pair × 2 sides — not 4

    const secondRows = h.db
      .prepare<unknown[], { capture_id: string }>('SELECT capture_id FROM capture_cache ORDER BY url')
      .all();
    const secondIds = secondRows.map((r) => r.capture_id);
    expect(secondIds).not.toEqual(firstIds);
  });
});

describe('runCacheBackfill', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('walks legacy complete rows and is idempotent', async () => {
    const sessionId = await uploadSession(h.app);
    const captureStart = await request(h.app)
      .post('/api/capture-runs')
      .send({ session_id: sessionId, options: { viewports: [desktop] } });
    await h.queue.drain();
    const captureRunId = captureStart.body.capture_run_id as string;

    // Force LM invocation via target_level_failure so backfill has an LM row
    // to copy.
    await request(h.app)
      .post('/api/comparison-runs')
      .send({
        session_id: sessionId,
        capture_run_id: captureRunId,
        options: { targetLevel: 'strict', invokeLm: true },
      });
    await h.queue.drain();

    // Wipe the cache tables to simulate a legacy database.
    h.db.exec('DELETE FROM capture_cache');
    h.db.exec('DELETE FROM pixel_compare_cache');
    h.db.exec('DELETE FROM lm_verdict_cache');

    const first = runCacheBackfill(h.db);
    expect(first.capture_cache_inserted).toBe(2);
    expect(first.pixel_compare_cache_inserted).toBe(1);
    expect(first.lm_verdict_cache_inserted).toBe(1);

    const second = runCacheBackfill(h.db);
    expect(second).toEqual({
      capture_cache_inserted: 0,
      pixel_compare_cache_inserted: 0,
      lm_verdict_cache_inserted: 0,
      capture_runs_skipped: 0,
    });

    expect(
      h.db.prepare<unknown[], { c: number }>('SELECT COUNT(*) AS c FROM capture_cache').get()?.c,
    ).toBe(2);
  });

  it('skips capture_runs whose options_json fails to parse', () => {
    const now = new Date().toISOString();
    const sessionId = randomUUID();
    h.db.prepare(
      'INSERT INTO sessions (id, name, csv_filename, created_at) VALUES (?, ?, ?, ?)',
    ).run(sessionId, 'legacy', 'legacy.csv', now);
    const jobId = randomUUID();
    h.db.prepare(
      `INSERT INTO jobs (id, type, status, progress_current, progress_total, created_at)
         VALUES (?, 'capture', 'complete', 1, 1, ?)`,
    ).run(jobId, now);
    const captureRunId = randomUUID();
    h.db.prepare(
      `INSERT INTO capture_runs (id, session_id, job_id, options_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(captureRunId, sessionId, jobId, '{"viewports":"not-a-list"}', now);

    const result = runCacheBackfill(h.db);
    expect(result.capture_runs_skipped).toBe(1);
    expect(result.capture_cache_inserted).toBe(0);
  });
});
