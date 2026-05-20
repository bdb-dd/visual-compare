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
import type { SessionResultRow, UrlPairRow, ViewportDef } from '../src/types.js';

/**
 * End-to-end coverage for the recapture flow: kicking off a new capture run
 * leaves the existing capture_cache rows in place so the UI keeps showing
 * the prior captures with `is_stale: true` until the new captures complete.
 * Once they complete, the cache rolls forward and the rows flip back to
 * fresh. Recapture errors leave the prior sha visible alongside a stale +
 * error status.
 */

const desktop: ViewportDef = {
  name: 'desktop',
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  orientation: 'landscape',
};

interface WorkerState {
  /** When non-null, the worker throws this on the next call and then clears. */
  failNext: string | null;
  /** When set, the worker awaits this promise before completing each call. */
  gate: Promise<void> | null;
  callCount: number;
}

/**
 * A capture worker that yields a fresh sha on every call (counter-stamped
 * content) and optionally throws or stalls so the test can interleave a
 * recapture with assertions while captures are in flight.
 */
function controllableWorker(state: WorkerState): CaptureWorker {
  return {
    capture: async (args) => {
      state.callCount += 1;
      // Snapshot the counter synchronously so concurrent captures each get
      // a unique path; reading state.callCount after an await would race.
      const n = state.callCount;
      if (state.failNext !== null) {
        const msg = state.failNext;
        state.failNext = null;
        throw new Error(msg);
      }
      if (state.gate) await state.gate;
      const dir = join(tmpdir(), 'vc-recapture-test');
      await mkdir(dir, { recursive: true });
      const path = join(dir, `cap-${n}.png`);
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
  workerState: WorkerState;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-recapture-itest-'));
  const db = openDatabase({ path: ':memory:' });
  applySchema(db);
  const queue = new JobQueue(db);
  const artifactStore = createArtifactStore(storeDir);
  const workerState: WorkerState = { failNext: null, gate: null, callCount: 0 };
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
    pollIntervalMs: 10,
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

async function uploadPairs(
  app: Harness['app'],
  rows: Array<{ url_a: string; url_b: string; label: string }>,
): Promise<{ sessionId: string; pairs: UrlPairRow[] }> {
  const csv = ['url_a,url_b,label', ...rows.map((r) => `${r.url_a},${r.url_b},${r.label}`)].join('\n');
  const upload = await request(app)
    .post('/api/sessions')
    .field('name', 'recap')
    .attach('csv', Buffer.from(csv), 'p.csv');
  expect(upload.status).toBe(201);
  const sessionId = upload.body.session.id as string;
  // Pin the session's default viewports to a single 'desktop' so the
  // recapture endpoint (which reads session config) plans the same scope
  // as the baseline evaluator.start({ viewports: [desktop] }).
  await request(app)
    .put(`/api/sessions/${sessionId}/config`)
    .send({ default_viewports: [desktop] });
  return {
    sessionId,
    pairs: upload.body.url_pairs as UrlPairRow[],
  };
}

async function settle(h: Harness): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await h.evaluator.drainAll();
    await h.queue.drain();
  }
}

async function readResults(h: Harness, sessionId: string): Promise<SessionResultRow[]> {
  const res = await request(h.app).get(`/api/sessions/${sessionId}/results`);
  expect(res.status).toBe(200);
  return res.body.results as SessionResultRow[];
}

describe('Recapture flow', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('returns 202 with an evaluation_id, kicks off a new capture_run, and the evaluation reaches "complete"', async () => {
    const { sessionId } = await uploadPairs(h.app, [
      { url_a: 'https://a.test/x', url_b: 'https://b.test/x', label: 'P1' },
    ]);
    // Initial evaluation so a baseline capture_run and cache rows exist.
    h.evaluator.start(sessionId, { viewports: [desktop], target_level: 'tolerant' });
    await settle(h);
    const baselineRuns = h.db
      .prepare('SELECT COUNT(*) AS n FROM capture_runs')
      .get() as { n: number };
    expect(baselineRuns.n).toBe(1);

    const recap = await request(h.app).post(`/api/sessions/${sessionId}/recapture`).send({});
    expect(recap.status).toBe(202);
    expect(recap.body.evaluation_id).toBeDefined();
    expect(recap.body.coalesced).toBe(false);
    expect(recap.body.unknown_pair_ids).toEqual([]);

    await settle(h);

    // The recapture's orchestrated work created a second capture_run.
    const runs = h.db
      .prepare('SELECT id FROM capture_runs ORDER BY created_at')
      .all() as { id: string }[];
    expect(runs).toHaveLength(2);

    // The evaluation row terminated successfully.
    const ev = h.db
      .prepare('SELECT status FROM evaluations WHERE id = ?')
      .get(recap.body.evaluation_id) as { status: string };
    expect(ev.status).toBe('complete');
  });

  it('marks prior captures stale while the new run is in flight, then flips back to fresh', async () => {
    const { sessionId } = await uploadPairs(h.app, [
      { url_a: 'https://a.test/x', url_b: 'https://b.test/x', label: 'P1' },
    ]);
    h.evaluator.start(sessionId, { viewports: [desktop], target_level: 'tolerant' });
    await settle(h);
    const before = (await readResults(h, sessionId))[0]!;
    expect(before.capture_a_status.is_stale).toBe(false);
    expect(before.capture_b_status.is_stale).toBe(false);
    const priorASha = before.capture_a_sha;
    expect(priorASha).toMatch(/^[0-9a-f]{64}$/);

    // Stall the worker so the recaptured captures stay pending.
    let release!: () => void;
    h.workerState.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recap = await request(h.app).post(`/api/sessions/${sessionId}/recapture`).send({});
    expect(recap.status).toBe(202);

    // While captures are pending, the cache still points at the prior shas
    // but is_stale is true and status is in_progress.
    const inFlight = (await readResults(h, sessionId))[0]!;
    expect(inFlight.capture_a_sha).toBe(priorASha);
    expect(inFlight.capture_a_status).toEqual({
      status: 'in_progress',
      error_message: null,
      is_stale: true,
    });
    expect(inFlight.capture_b_status.is_stale).toBe(true);

    // Release the stall, drain, and assert the cache has rolled forward.
    release();
    h.workerState.gate = null;
    await settle(h);

    const after = (await readResults(h, sessionId))[0]!;
    expect(after.capture_a_sha).not.toBe(priorASha);
    expect(after.capture_a_status).toEqual({
      status: 'complete',
      error_message: null,
      is_stale: false,
    });
    expect(after.capture_b_status.is_stale).toBe(false);
  });

  it('keeps the prior sha visible when a recapture errors, with status=error + is_stale=true', async () => {
    const { sessionId } = await uploadPairs(h.app, [
      { url_a: 'https://a.test/x', url_b: 'https://b.test/x', label: 'P1' },
    ]);
    h.evaluator.start(sessionId, { viewports: [desktop], target_level: 'tolerant' });
    await settle(h);
    const before = (await readResults(h, sessionId))[0]!;
    const priorASha = before.capture_a_sha;

    // Fail the very next worker call; the other side captures normally.
    h.workerState.failNext = 'network unreachable';
    const recap = await request(h.app).post(`/api/sessions/${sessionId}/recapture`).send({});
    expect(recap.status).toBe(202);
    await settle(h);

    const after = (await readResults(h, sessionId))[0]!;
    // The errored side keeps the prior sha and reports stale+error.
    const erroredSide =
      after.capture_a_status.status === 'error'
        ? after.capture_a_status
        : after.capture_b_status;
    const erroredSha =
      after.capture_a_status.status === 'error' ? after.capture_a_sha : after.capture_b_sha;
    expect(erroredSide).toEqual({
      status: 'error',
      error_message: 'network unreachable',
      is_stale: true,
    });
    expect(erroredSha).toBe(
      after.capture_a_status.status === 'error' ? priorASha : before.capture_b_sha,
    );
  });

  it('scopes recapture to the supplied pair_ids', async () => {
    const { sessionId, pairs } = await uploadPairs(h.app, [
      { url_a: 'https://a.test/x', url_b: 'https://b.test/x', label: 'P1' },
      { url_a: 'https://a.test/y', url_b: 'https://b.test/y', label: 'P2' },
    ]);
    h.evaluator.start(sessionId, { viewports: [desktop], target_level: 'tolerant' });
    await settle(h);

    const recap = await request(h.app)
      .post(`/api/sessions/${sessionId}/recapture`)
      .send({ pair_ids: [pairs[0]!.id] });
    expect(recap.status).toBe(202);
    expect(recap.body.evaluation_id).toBeDefined();
    await settle(h);

    const rows = await readResults(h, sessionId);
    const p1 = rows.find((r) => r.url_pair_id === pairs[0]!.id)!;
    const p2 = rows.find((r) => r.url_pair_id === pairs[1]!.id)!;

    // P1 has fresh shas from the recapture; P2 is untouched.
    expect(p1.capture_a_status.is_stale).toBe(false);
    expect(p2.capture_a_status.is_stale).toBe(false);
    // The worker stamps a counter into the sha, so a re-captured pair
    // produces a different sha than its baseline. A non-recaptured pair
    // keeps its baseline sha.
    const seen = new Set([p1.capture_a_sha, p1.capture_b_sha, p2.capture_a_sha, p2.capture_b_sha]);
    expect(seen.size).toBe(4);
  });

  it('side: only recaptures that side', async () => {
    const { sessionId } = await uploadPairs(h.app, [
      { url_a: 'https://a.test/x', url_b: 'https://b.test/x', label: 'P1' },
    ]);
    h.evaluator.start(sessionId, { viewports: [desktop], target_level: 'tolerant' });
    await settle(h);
    const before = (await readResults(h, sessionId))[0]!;

    const recap = await request(h.app)
      .post(`/api/sessions/${sessionId}/recapture`)
      .send({ side: 'b' });
    expect(recap.status).toBe(202);
    expect(recap.body.evaluation_id).toBeDefined();
    await settle(h);

    const after = (await readResults(h, sessionId))[0]!;
    expect(after.capture_a_sha).toBe(before.capture_a_sha);
    expect(after.capture_b_sha).not.toBe(before.capture_b_sha);
    expect(after.capture_a_status.is_stale).toBe(false);
    expect(after.capture_b_status.is_stale).toBe(false);
  });

  it('reports unknown_pair_ids and ignores them rather than failing', async () => {
    const { sessionId, pairs } = await uploadPairs(h.app, [
      { url_a: 'https://a.test/x', url_b: 'https://b.test/x', label: 'P1' },
    ]);
    const recap = await request(h.app)
      .post(`/api/sessions/${sessionId}/recapture`)
      .send({ pair_ids: [pairs[0]!.id, 'not-a-real-pair-id'] });
    expect(recap.status).toBe(202);
    expect(recap.body.evaluation_id).toBeDefined();
    expect(recap.body.unknown_pair_ids).toEqual(['not-a-real-pair-id']);
    await settle(h);
  });

  it('400s when every supplied pair_id is unknown', async () => {
    const { sessionId } = await uploadPairs(h.app, [
      { url_a: 'https://a.test/x', url_b: 'https://b.test/x', label: 'P1' },
    ]);
    const recap = await request(h.app)
      .post(`/api/sessions/${sessionId}/recapture`)
      .send({ pair_ids: ['nope-1', 'nope-2'] });
    expect(recap.status).toBe(400);
  });

  it('404s when the session does not exist', async () => {
    const recap = await request(h.app)
      .post('/api/sessions/does-not-exist/recapture')
      .send({});
    expect(recap.status).toBe(404);
  });

  it('runs captures and comparisons under one evaluation so the cache rolls forward and a fresh comparison lands', async () => {
    const { sessionId } = await uploadPairs(h.app, [
      { url_a: 'https://a.test/x', url_b: 'https://b.test/x', label: 'P1' },
    ]);
    h.evaluator.start(sessionId, { viewports: [desktop], target_level: 'tolerant' });
    await settle(h);
    const baselineComparisonRuns = (h.db
      .prepare('SELECT COUNT(*) AS n FROM comparison_runs')
      .get() as { n: number }).n;
    const baselineComparisons = (h.db
      .prepare('SELECT COUNT(*) AS n FROM comparisons')
      .get() as { n: number }).n;
    expect(baselineComparisons).toBe(1);

    const recap = await request(h.app).post(`/api/sessions/${sessionId}/recapture`).send({});
    expect(recap.status).toBe(202);
    await settle(h);

    // A new comparison_run was created and a new comparisons row written
    // against the fresh shas — proving the same evaluation drove both
    // phases, not just captures.
    const afterComparisonRuns = (h.db
      .prepare('SELECT COUNT(*) AS n FROM comparison_runs')
      .get() as { n: number }).n;
    const afterComparisons = (h.db
      .prepare('SELECT COUNT(*) AS n FROM comparisons')
      .get() as { n: number }).n;
    expect(afterComparisonRuns).toBe(baselineComparisonRuns + 1);
    expect(afterComparisons).toBe(baselineComparisons + 1);

    // The new comparison points at the captures from the recapture's run,
    // not the baseline ones.
    const ev = h.db
      .prepare('SELECT capture_run_id, comparison_run_id FROM evaluations WHERE id = ?')
      .get(recap.body.evaluation_id) as { capture_run_id: string; comparison_run_id: string };
    const cmp = h.db
      .prepare(
        `SELECT capture_a_id, capture_b_id FROM comparisons
            WHERE comparison_run_id = ?`,
      )
      .get(ev.comparison_run_id) as { capture_a_id: string; capture_b_id: string };
    const capRunIds = h.db
      .prepare('SELECT capture_run_id FROM captures WHERE id IN (?, ?)')
      .all(cmp.capture_a_id, cmp.capture_b_id) as { capture_run_id: string }[];
    for (const r of capRunIds) {
      expect(r.capture_run_id).toBe(ev.capture_run_id);
    }
  });
});
