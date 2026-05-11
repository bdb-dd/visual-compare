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
import type { CaptureWorker } from '../src/services/capture.js';
import type { ComparisonImagick } from '../src/services/comparison.js';
import type { LmClient } from '../src/services/lm.js';
import { createApp } from '../src/app.js';
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
    capture: async () => {
      const dir = join(tmpdir(), 'vc-missing-test-captures');
      await mkdir(dir, { recursive: true });
      const path = join(dir, `cap-${counter++}.png`);
      await writeFile(path, Buffer.from(`STUB-${counter}`));
      return { tempPath: path, durationMs: 1, httpStatus: 200, isMissing: false };
    },
    shutdown: async () => {},
  };
}

/**
 * Imagick stub that records when compareAe is called. The missing-page test
 * relies on it NOT being called for short-circuited comparisons.
 */
function recordingImagick(): ComparisonImagick & { compareAeCalls: number } {
  const out = {
    compareAeCalls: 0,
    compareAe: async (_a, _b, diffPath) => {
      out.compareAeCalls += 1;
      await mkdir(dirname(diffPath), { recursive: true });
      await writeFile(diffPath, Buffer.from('DIFF'));
      return {
        aePixels: 0,
        totalPixels: 100,
        changedPixelPercentage: 0,
        diffImagePath: diffPath,
        width: 10,
        height: 10,
      };
    },
    compareSsim: async () => 1,
    extractConnectedComponents: async () => ({ format: 'json' as const, raw: '[]' }),
  } satisfies ComparisonImagick & { compareAeCalls: number };
  return out;
}

interface Harness {
  app: ReturnType<typeof createApp>;
  db: Db;
  queue: JobQueue;
  imagick: ReturnType<typeof recordingImagick>;
  cleanup: () => Promise<void>;
}

function stubLm(): LmClient {
  // Tolerant has a non-zero ambiguity band, so the comparison-runs route
  // refuses to start a run unless an LM client is configured. The stub here
  // returns ok-preflight; the actual analyze path is unreachable in these
  // tests because missing-page rows short-circuit before LM gating.
  return {
    config: {
      baseURL: 'http://stub',
      apiKey: 'stub',
      model: 'stub-model',
      promptVersion: 'stub-prompt',
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
    }),
    analyze: async () => ({
      kind: 'error',
      message: 'unused in missing-page tests',
    }),
  };
}

async function makeHarness(): Promise<Harness> {
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-missing-itest-'));
  const db = openDatabase({ path: ':memory:' });
  applySchema(db);
  const queue = new JobQueue(db);
  const artifactStore = createArtifactStore(storeDir);
  const imagick = recordingImagick();
  const app = createApp({
    db,
    queue,
    artifactStore,
    captureWorker: stubCaptureWorker(),
    imagick,
    lm: stubLm(),
  });
  return {
    app,
    db,
    queue,
    imagick,
    cleanup: async () => {
      await rm(storeDir, { recursive: true, force: true });
      db.close();
    },
  };
}

async function uploadSession(app: Harness['app']): Promise<string> {
  const csv = [
    'url_a,url_b,label',
    'https://a.example.com/x,https://b.example.com/x,Pair 1',
  ].join('\n');
  const upload = await request(app)
    .post('/api/sessions')
    .field('name', 'missing-pages')
    .attach('csv', Buffer.from(csv), 'pairs.csv');
  expect(upload.status).toBe(201);
  return upload.body.session.id as string;
}

describe('missing-page pair_outcome', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('short-circuits the comparison when one capture is_missing=1', async () => {
    const sessionId = await uploadSession(h.app);
    const captureStart = await request(h.app)
      .post('/api/capture-runs')
      .send({ session_id: sessionId, options: { viewports: [desktop] } });
    expect(captureStart.status).toBe(202);
    await h.queue.drain();
    const captureRunId = captureStart.body.capture_run_id as string;

    // Mark the B-side capture as a missing page. Real capture pipeline does
    // this via http_status / title regex; here we stub the post-condition
    // directly so the comparison code sees the same state.
    h.db
      .prepare(`UPDATE captures SET is_missing = 1 WHERE side = 'b'`)
      .run();

    const compStart = await request(h.app)
      .post('/api/comparison-runs')
      .send({
        session_id: sessionId,
        capture_run_id: captureRunId,
        options: { targetLevel: 'tolerant' },
      });
    expect(compStart.status).toBe(202);
    await h.queue.drain();

    const compRow = h.db
      .prepare<
        unknown[],
        {
          status: string;
          pair_outcome: string;
          changed_pixel_percentage: number | null;
          im_diff_sha256: string | null;
        }
      >(
        `SELECT status, pair_outcome, changed_pixel_percentage, im_diff_sha256
           FROM comparisons`,
      )
      .all();
    expect(compRow).toHaveLength(1);
    expect(compRow[0]).toMatchObject({
      status: 'complete',
      pair_outcome: 'b_missing',
      changed_pixel_percentage: null,
      im_diff_sha256: null,
    });

    // compareAe must NOT have run for missing-page rows. The short-circuit
    // is the whole point — running it would defeat the optimization and
    // produce meaningless red-everywhere diffs.
    expect(h.imagick.compareAeCalls).toBe(0);

    // Pixel cache stays empty for missing-page rows; we don't want to serve
    // a "verdict" out of the cache for a pair where the diff was skipped.
    const pixelRows = h.db
      .prepare(`SELECT 1 FROM pixel_compare_cache`)
      .all();
    expect(pixelRows).toHaveLength(0);
  });

  it('classifies both_missing when both sides are missing', async () => {
    const sessionId = await uploadSession(h.app);
    const captureStart = await request(h.app)
      .post('/api/capture-runs')
      .send({ session_id: sessionId, options: { viewports: [desktop] } });
    await h.queue.drain();
    const captureRunId = captureStart.body.capture_run_id as string;

    h.db.prepare(`UPDATE captures SET is_missing = 1`).run();

    await request(h.app)
      .post('/api/comparison-runs')
      .send({
        session_id: sessionId,
        capture_run_id: captureRunId,
        options: { targetLevel: 'tolerant' },
      });
    await h.queue.drain();

    const compRow = h.db
      .prepare<unknown[], { pair_outcome: string }>(
        `SELECT pair_outcome FROM comparisons`,
      )
      .get();
    expect(compRow?.pair_outcome).toBe('both_missing');
  });

  it("planner doesn't re-queue missing-page pairs as comparison_misses on the next evaluate", async () => {
    // Repro for the production symptom: missing-page comparisons short-
    // circuit and skip the pixel_compare_cache write, so without the
    // planner-side guard every Evaluate forever reports the same pairs as
    // missing.
    const sessionId = await uploadSession(h.app);
    const captureStart = await request(h.app)
      .post('/api/capture-runs')
      .send({ session_id: sessionId, options: { viewports: [desktop] } });
    await h.queue.drain();
    const captureRunId = captureStart.body.capture_run_id as string;

    h.db.prepare(`UPDATE captures SET is_missing = 1 WHERE side = 'b'`).run();

    await request(h.app)
      .post('/api/comparison-runs')
      .send({
        session_id: sessionId,
        capture_run_id: captureRunId,
        options: { targetLevel: 'tolerant' },
      });
    await h.queue.drain();

    // Sanity: the comparison ran and was classified as b_missing — but the
    // missing-page short-circuit means no pixel_compare_cache entry exists.
    const cmpRow = h.db
      .prepare<unknown[], { pair_outcome: string }>(
        `SELECT pair_outcome FROM comparisons`,
      )
      .get();
    expect(cmpRow?.pair_outcome).toBe('b_missing');
    const cacheCount = h.db
      .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM pixel_compare_cache`)
      .get();
    expect(cacheCount?.n).toBe(0);

    // Now hit /results — the planner must NOT report this pair as
    // outstanding work, because there's nothing more to do for it.
    const results = await request(h.app).get(`/api/sessions/${sessionId}/results`);
    expect(results.status).toBe(200);
    expect(results.body.plan.comparison_misses).toBe(0);
  });

  it('runs the visual diff normally when neither side is missing', async () => {
    const sessionId = await uploadSession(h.app);
    const captureStart = await request(h.app)
      .post('/api/capture-runs')
      .send({ session_id: sessionId, options: { viewports: [desktop] } });
    await h.queue.drain();
    const captureRunId = captureStart.body.capture_run_id as string;

    await request(h.app)
      .post('/api/comparison-runs')
      .send({
        session_id: sessionId,
        capture_run_id: captureRunId,
        options: { targetLevel: 'tolerant' },
      });
    await h.queue.drain();

    const compRow = h.db
      .prepare<unknown[], { pair_outcome: string }>(
        `SELECT pair_outcome FROM comparisons`,
      )
      .get();
    expect(compRow?.pair_outcome).toBe('both_present');
    expect(h.imagick.compareAeCalls).toBe(1);
  });
});

describe('GET /sessions/:id/results ?outcome filter', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('filters results to the requested pair_outcome and reports unfiltered counts in summary', async () => {
    // Two pairs, B-side of pair 2 is missing.
    const csv = [
      'url_a,url_b,label',
      'https://a.example.com/1,https://b.example.com/1,present',
      'https://a.example.com/2,https://b.example.com/2,missing-on-b',
    ].join('\n');
    const upload = await request(h.app)
      .post('/api/sessions')
      .field('name', 'filter-test')
      .attach('csv', Buffer.from(csv), 'pairs.csv');
    expect(upload.status).toBe(201);
    const sessionId = upload.body.session.id as string;

    const captureStart = await request(h.app)
      .post('/api/capture-runs')
      .send({ session_id: sessionId, options: { viewports: [desktop] } });
    await h.queue.drain();
    const captureRunId = captureStart.body.capture_run_id as string;

    h.db
      .prepare(
        `UPDATE captures SET is_missing = 1
           WHERE side = 'b' AND url = 'https://b.example.com/2'`,
      )
      .run();

    await request(h.app)
      .post('/api/comparison-runs')
      .send({
        session_id: sessionId,
        capture_run_id: captureRunId,
        options: { targetLevel: 'tolerant' },
      });
    await h.queue.drain();

    const all = await request(h.app).get(`/api/sessions/${sessionId}/results`);
    expect(all.status).toBe(200);
    expect(all.body.results).toHaveLength(2);
    expect(all.body.summary.by_pair_outcome).toEqual({
      both_present: 1,
      a_missing: 0,
      b_missing: 1,
      both_missing: 0,
    });

    const filtered = await request(h.app)
      .get(`/api/sessions/${sessionId}/results`)
      .query({ outcome: 'b_missing' });
    expect(filtered.status).toBe(200);
    expect(filtered.body.results).toHaveLength(1);
    expect(filtered.body.results[0].pair_outcome).toBe('b_missing');
    expect(filtered.body.results[0].label).toBe('missing-on-b');
    // Summary still reflects the unfiltered totals so chip counts are stable.
    expect(filtered.body.summary.by_pair_outcome).toEqual({
      both_present: 1,
      a_missing: 0,
      b_missing: 1,
      both_missing: 0,
    });

    const bogus = await request(h.app)
      .get(`/api/sessions/${sessionId}/results`)
      .query({ outcome: 'nonsense' });
    // Unknown outcome param is ignored — fall back to the unfiltered list.
    expect(bogus.body.results).toHaveLength(2);
  });
});
