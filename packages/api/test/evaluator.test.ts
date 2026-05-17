import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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
import { Evaluator } from '../src/services/evaluator.js';
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
      const dir = join(tmpdir(), 'vc-eval-test-captures');
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
  evaluator: Evaluator;
  artifactStore: ReturnType<typeof createArtifactStore>;
  storeDir: string;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-eval-itest-'));
  const db = openDatabase({ path: ':memory:' });
  applySchema(db);
  const queue = new JobQueue(db);
  const artifactStore = createArtifactStore(storeDir);
  const captureWorker = stubCaptureWorker();
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
    artifactStore,
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
    'https://a2.example.com,https://b2.example.com,Pair 2',
  ].join('\n');
  const upload = await request(app)
    .post('/api/sessions')
    .field('name', 'eval-test')
    .attach('csv', Buffer.from(csv), 'pairs.csv');
  expect(upload.status).toBe(201);
  return upload.body.session.id as string;
}

async function settle(h: Harness): Promise<void> {
  // Orchestration enqueues new queue work as it progresses (capture run, then
  // comparison run). Loop draining both layers until they're stable.
  for (let i = 0; i < 8; i += 1) {
    await h.evaluator.drainAll();
    await h.queue.drain();
  }
}

describe('evaluator', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('first evaluation runs captures + comparisons; second is all cache hits', async () => {
    const sessionId = await uploadSession(h.app);

    const first = await request(h.app)
      .post(`/api/sessions/${sessionId}/evaluate`)
      .send({ config: { viewports: [desktop], target_level: 'tolerant' } });
    expect(first.status).toBe(202);
    expect(first.body.coalesced).toBe(false);
    const evalId1 = first.body.evaluation_id as string;

    await settle(h);

    const detail1 = await request(h.app).get(`/api/evaluations/${evalId1}`);
    expect(detail1.status).toBe(200);
    expect(detail1.body.evaluation.status).toBe('complete');
    expect(detail1.body.evaluation.capture_run_id).toBeTruthy();
    expect(detail1.body.evaluation.comparison_run_id).toBeTruthy();
    expect(detail1.body.evaluation.cache_hits.captures).toBe(4); // 2 pairs × 2 sides
    expect(detail1.body.evaluation.cache_hits.pixel).toBe(2); // 2 comparisons cached

    const second = await request(h.app)
      .post(`/api/sessions/${sessionId}/evaluate`)
      .send({ config: { viewports: [desktop], target_level: 'tolerant' } });
    expect(second.status).toBe(202);
    expect(second.body.coalesced).toBe(false);
    const evalId2 = second.body.evaluation_id as string;
    expect(evalId2).not.toBe(evalId1);

    await settle(h);

    const detail2 = await request(h.app).get(`/api/evaluations/${evalId2}`);
    expect(detail2.body.evaluation.status).toBe('complete');
    // No new capture run because all captures hit the cache.
    expect(detail2.body.evaluation.capture_run_id).toBeNull();
    // No new comparison run because pixel cache covered everything.
    expect(detail2.body.evaluation.comparison_run_id).toBeNull();
    expect(detail2.body.evaluation.cache_hits.pixel).toBe(2);
  });

  it('coalesces concurrent evaluations on the same session', async () => {
    const sessionId = await uploadSession(h.app);

    const first = h.evaluator.start(sessionId);
    expect(first.coalesced).toBe(false);

    const second = h.evaluator.start(sessionId);
    expect(second.coalesced).toBe(true);
    expect(second.evaluation_id).toBe(first.evaluation_id);

    await settle(h);

    // After the first one finishes, a fresh start is *not* coalesced.
    const third = h.evaluator.start(sessionId);
    expect(third.coalesced).toBe(false);
    expect(third.evaluation_id).not.toBe(first.evaluation_id);
    await settle(h);
  });

  it('LM second pass: invokeLm=true on a target the pixel walk misses populates the LM cache and is reused', async () => {
    const sessionId = await uploadSession(h.app);

    // The stub imagick reports pct=1, ssim=0.97 → tolerant matches by pixel.
    // Force LM second pass by picking a stricter target the pixel walk misses
    // (strict requires pct≤0.5).
    h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'strict',
      invoke_lm: true,
    });
    await settle(h);

    const lmRows = h.db
      .prepare<unknown[], { invocation_reason: string }>(
        'SELECT invocation_reason FROM lm_verdict_cache',
      )
      .all();
    expect(lmRows).toHaveLength(2);
    expect(lmRows.every((r) => r.invocation_reason === 'target_level_failure')).toBe(true);

    const second = h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'strict',
      invoke_lm: true,
    });
    await settle(h);
    const detail = await request(h.app).get(`/api/evaluations/${second.evaluation_id}`);
    expect(detail.body.evaluation.cache_hits.lm).toBe(2);
    expect(detail.body.evaluation.comparison_run_id).toBeNull();
  });

  it('GET /results returns per-(pair, viewport) verdicts with matched_at_level', async () => {
    const sessionId = await uploadSession(h.app);

    // Empty cache → all rows pending.
    const empty = await request(h.app).get(`/api/sessions/${sessionId}/results`);
    expect(empty.status).toBe(200);
    expect(empty.body.results).toHaveLength(2); // 2 pairs × 1 viewport
    for (const r of empty.body.results) expect(r.status).toBe('pending');
    expect(empty.body.plan.capture_misses).toBe(4);
    expect(empty.body.plan.comparison_misses).toBe(2);
    // Summary on the empty side: everything is pending.
    expect(empty.body.summary.total).toBe(2);
    expect(empty.body.summary.by_level.pending).toBe(2);
    expect(empty.body.summary.by_target_status.pending).toBe(2);

    h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'tolerant',
    });
    await settle(h);

    const populated = await request(h.app).get(`/api/sessions/${sessionId}/results`);
    expect(populated.body.plan.capture_misses).toBe(0);
    expect(populated.body.plan.comparison_misses).toBe(0);
    // Both rows resolved at tolerant by pixel.
    expect(populated.body.summary.total).toBe(2);
    expect(populated.body.summary.by_level.tolerant).toBe(2);
    expect(populated.body.summary.by_target_status.reached_target).toBe(2);
    expect(populated.body.summary.by_decided_by.pixel).toBe(2);
    expect(populated.body.summary.by_acceptance_status.unaccepted).toBe(2);
    for (const r of populated.body.results) {
      expect(r.status).toBe('cached');
      // pct=1 with ssim=0.97 → tolerant matches (pct≤5, ssim≥0.95).
      expect(r.matched_at_level).toBe('tolerant');
      expect(r.matched_decided_by).toBe('pixel');
      expect(r.pixel.changed_pct).toBe(1);
    }
  });

  it('GET /sessions/:id/evaluations lists past evaluations newest first', async () => {
    const sessionId = await uploadSession(h.app);

    h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'tolerant',
    });
    await settle(h);
    h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'tolerant',
    });
    await settle(h);

    const list = await request(h.app).get(`/api/sessions/${sessionId}/evaluations`);
    expect(list.status).toBe(200);
    expect(list.body.evaluations).toHaveLength(2);
    expect(
      new Date(list.body.evaluations[0].started_at).getTime(),
    ).toBeGreaterThanOrEqual(
      new Date(list.body.evaluations[1].started_at).getTime(),
    );
  });

  it('rejects invalid evaluate config bodies', async () => {
    const sessionId = await uploadSession(h.app);
    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/evaluate`)
      .send({ config: { target_level: 'nonsense' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_config');
  });

  it('returns 404 for evaluate on unknown session', async () => {
    const res = await request(h.app)
      .post('/api/sessions/does-not-exist/evaluate')
      .send({ config: {} });
    expect(res.status).toBe(404);
  });
});

describe('evaluator cancel', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('cancel before orchestration runs marks the evaluation cancelled', async () => {
    const sessionId = await uploadSession(h.app);
    const start = h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'tolerant',
    });
    // Cancel synchronously after start() — the orchestrator is queued but
    // hasn't run yet. The pre-phase abort check should short-circuit and
    // finalize as 'cancelled' without any capture work.
    const disposition = h.evaluator.cancel(start.evaluation_id);
    expect(disposition).toBe('cancelled');

    await settle(h);

    const detail = await request(h.app).get(`/api/evaluations/${start.evaluation_id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.evaluation.status).toBe('cancelled');
    expect(detail.body.evaluation.completed_at).toBeTruthy();

    // No captures were dispatched (stub would have written rows otherwise).
    const captureRows = h.db
      .prepare<unknown[], { count: number }>(
        `SELECT COUNT(*) AS count FROM captures WHERE status = 'complete'`,
      )
      .get();
    expect(captureRows?.count ?? 0).toBe(0);
  });

  it('cancel mid-flight skips unstarted captures and marks cancelled', async () => {
    const sessionId = await uploadSession(h.app);

    // Build a controllable capture worker so we can race the cancel against
    // the limit-loop. Each capture blocks until released; we let one through
    // before cancelling so the abort path is observed by the loop.
    const gateA = makeGate();
    const gateB = makeGate();
    let counter = 0;
    const blockingWorker: CaptureWorker = {
      capture: async (args) => {
        const idx = counter++;
        // The two-pair test fixture has 4 captures; we hold all but the first
        // by gate, so #2-#4 won't run before cancel takes effect.
        if (idx === 0) await gateA.released;
        else await gateB.released;
        const dir = join(tmpdir(), 'vc-eval-cancel-test');
        await mkdir(dir, { recursive: true });
        const path = join(dir, `cap-${idx}.png`);
        await writeFile(path, Buffer.from(`url=${args.url}\n`));
        return { tempPath: path, durationMs: 1, metadata: { idx } };
      },
      shutdown: async () => {},
    };
    // Replace the harness's worker. The evaluator captured the original by
    // closure, so build a new one against the same db/queue/store.
    const evaluator = new Evaluator({
      db: h.db,
      queue: h.queue,
      artifactStore: h.artifactStore,
      worker: blockingWorker,
      imagick: stubImagick(),
      lm: stubLm(),
      pollIntervalMs: 10,
    });
    const start = evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'tolerant',
    });

    // Release one capture so the limit-loop progresses past its first slot.
    gateA.release();
    // Wait a tick to let the loop dispatch + observe the released capture.
    await new Promise((r) => setTimeout(r, 20));

    const disposition = evaluator.cancel(start.evaluation_id);
    expect(disposition).toBe('cancelled');

    // Release the remaining gates so any in-flight slots can finish; the
    // limit loop should skip them on signal.aborted.
    gateB.release();
    while (evaluator.waitFor(start.evaluation_id)) {
      await evaluator.drainAll();
      await h.queue.drain();
    }

    const row = h.db
      .prepare<[string], { status: string }>(
        `SELECT status FROM evaluations WHERE id = ?`,
      )
      .get(start.evaluation_id);
    expect(row?.status).toBe('cancelled');
  });

  it('streams comparisons in multiple batches under one comparison_run as captures land', async () => {
    const sessionId = await uploadSession(h.app);

    // Per-pair gates: hold pair 2's captures until after pair 1's land so
    // the orchestrator has the opportunity to dispatch pair 1 in a first
    // comparison batch before pair 2's captures complete.
    const gatePair2 = makeGate();
    let counter = 0;
    const stagedWorker: CaptureWorker = {
      capture: async (args) => {
        const idx = counter++;
        // uploadSession seeds 2 url pairs × 2 sides = 4 captures.
        // Indices 0,1 belong to pair 1; 2,3 belong to pair 2.
        if (idx >= 2) await gatePair2.released;
        const dir = join(tmpdir(), 'vc-eval-stream-test');
        await mkdir(dir, { recursive: true });
        const path = join(dir, `cap-${idx}.png`);
        await writeFile(path, Buffer.from(`url=${args.url}\n`));
        return { tempPath: path, durationMs: 1, metadata: { idx } };
      },
      shutdown: async () => {},
    };
    const evaluator = new Evaluator({
      db: h.db,
      queue: h.queue,
      artifactStore: h.artifactStore,
      worker: stagedWorker,
      imagick: stubImagick(),
      lm: stubLm(),
      pollIntervalMs: 10,
    });
    const start = evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'tolerant',
    });

    // Let pair 1's two captures finish + the poll loop dispatch batch #1.
    // The poll cadence is 10 ms (test override), so 60 ms is plenty.
    await new Promise((r) => setTimeout(r, 60));

    // Release pair 2 so the rest of the run can complete.
    gatePair2.release();
    while (evaluator.waitFor(start.evaluation_id)) {
      await evaluator.drainAll();
      await h.queue.drain();
    }

    // One comparison_run.
    const runRow = h.db
      .prepare<[string], { id: string }>(
        `SELECT id FROM comparison_runs WHERE session_id = ?`,
      )
      .all(sessionId);
    expect(runRow).toHaveLength(1);
    const comparisonRunId = runRow[0]!.id;

    // Two comparison rows (one per pair) attached to that run.
    const compCount = h.db
      .prepare<[string], { n: number }>(
        `SELECT COUNT(*) AS n FROM comparisons WHERE comparison_run_id = ?`,
      )
      .get(comparisonRunId);
    expect(compCount?.n).toBe(2);

    // At least two comparison jobs landed — proof of batching.
    // (The exact count is timing-dependent: 2 is the staging-intended case,
    // but a slow CI box can produce 3 when the poll ticks split work
    // finer-grained. The contract is "more than one".)
    const jobCount = h.db
      .prepare<unknown[], { n: number }>(
        `SELECT COUNT(*) AS n FROM jobs WHERE type = 'comparison'`,
      )
      .get();
    expect(jobCount?.n ?? 0).toBeGreaterThan(1);

    // Evaluation finalized successfully.
    const evalRow = h.db
      .prepare<[string], { status: string; comparison_run_id: string | null }>(
        `SELECT status, comparison_run_id FROM evaluations WHERE id = ?`,
      )
      .get(start.evaluation_id);
    expect(evalRow?.status).toBe('complete');
    expect(evalRow?.comparison_run_id).toBe(comparisonRunId);
  });

  it('POST /cancel returns 404 for an unknown evaluation', async () => {
    const res = await request(h.app).post(`/api/evaluations/no-such-id/cancel`);
    expect(res.status).toBe(404);
  });

  it('POST /cancel returns 409 when evaluation is already complete', async () => {
    const sessionId = await uploadSession(h.app);
    const start = await request(h.app)
      .post(`/api/sessions/${sessionId}/evaluate`)
      .send({ config: { viewports: [desktop], target_level: 'tolerant' } });
    expect(start.status).toBe(202);
    await settle(h);

    const res = await request(h.app).post(`/api/evaluations/${start.body.evaluation_id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_cancellable');
  });
});

function makeGate(): { released: Promise<void>; release: () => void } {
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  return { released, release };
}
