import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { openDatabase } from '../src/db/client.js';
import type { Db } from '../src/db/client.js';
import { applySchema } from '../src/db/schema.js';
import { JobQueue } from '../src/services/queue.js';
import { createArtifactStore } from '../src/services/artifact-store.js';
import { createApp } from '../src/app.js';
import { Evaluator, resumeInterruptedEvaluations } from '../src/services/evaluator.js';
import { recoverInterruptedRuns } from '../src/db/recovery.js';
import type { CaptureWorker } from '../src/services/capture.js';
import type { ComparisonImagick } from '../src/services/comparison.js';
import type { LmClient } from '../src/services/lm.js';
import type { UrlPairRow, ViewportDef } from '../src/types.js';

/**
 * Restart resume covers the end-to-end story: an interrupted eval was
 * flipped to error by recovery; resume re-drives it without user
 * intervention; the new eval reaches `complete` once the queue drains.
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
      const dir = join(tmpdir(), 'vc-resume-test');
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
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-resume-itest-'));
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

async function uploadOnePair(h: Harness): Promise<{ sessionId: string; pair: UrlPairRow }> {
  const csv = 'url_a,url_b,label\nhttps://a.test,https://b.test,P1';
  const upload = await request(h.app)
    .post('/api/sessions')
    .field('name', 'resume')
    .attach('csv', Buffer.from(csv), 'p.csv');
  expect(upload.status).toBe(201);
  const sessionId = upload.body.session.id as string;
  await request(h.app)
    .put(`/api/sessions/${sessionId}/config`)
    .send({ default_viewports: [desktop] });
  return { sessionId, pair: upload.body.url_pairs[0] as UrlPairRow };
}

describe('resumeInterruptedEvaluations', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('starts a fresh evaluation per resumable + skips evals whose session was deleted', async () => {
    const { sessionId } = await uploadOnePair(h);

    // Simulate a process death mid-evaluation: insert a 'running' evaluation
    // row whose snapshot mirrors what the orchestrator would have stored.
    const priorEvalId = randomUUID();
    const snapshot = {
      viewports: [desktop],
      target_level: 'tolerant',
      invoke_lm: false,
      url_pair_ids: null,
      force_recapture: null,
    };
    h.db.prepare(
      `INSERT INTO evaluations
        (id, session_id, config_snapshot_json, enabled_pair_count, status, started_at)
        VALUES (?, ?, ?, 1, 'running', ?)`,
    ).run(priorEvalId, sessionId, JSON.stringify(snapshot), new Date().toISOString());

    // Also one tied to a session that no longer exists (the cascade would
    // normally handle this, but a dangling snapshot still passes through
    // recoverInterruptedRuns; resume must tolerate it).
    const orphanEvalId = randomUUID();
    const orphanSessionId = 'orphan-session-id';
    h.db.prepare(
      `INSERT INTO sessions (id, name, csv_filename, created_at)
         VALUES (?, 'orphan', 'o.csv', ?)`,
    ).run(orphanSessionId, new Date().toISOString());
    h.db.prepare(
      `INSERT INTO evaluations
        (id, session_id, config_snapshot_json, enabled_pair_count, status, started_at)
        VALUES (?, ?, ?, 0, 'running', ?)`,
    ).run(orphanEvalId, orphanSessionId, '{}', new Date().toISOString());
    // Now drop the session — leaves the eval row dangling momentarily for
    // the test. (In practice ON DELETE CASCADE removes the eval too, but
    // we want resume to be resilient anyway.)
    h.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(orphanSessionId);

    const recovery = recoverInterruptedRuns(h.db);
    // Orphan eval was cascade-deleted with its session, so only the real
    // one is resumable.
    expect(recovery.resumable).toHaveLength(1);
    expect(recovery.resumable[0]!.id).toBe(priorEvalId);

    const resumed = resumeInterruptedEvaluations(h.evaluator, recovery.resumable);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.session_id).toBe(sessionId);
    expect(resumed[0]!.prior_evaluation_id).toBe(priorEvalId);
    expect(resumed[0]!.evaluation_id).not.toBe(priorEvalId);
    expect(resumed[0]!.coalesced).toBe(false);

    await settle(h);

    // The new evaluation reaches `complete` — captures got queued, run, and
    // the comparison job followed via the standard orchestrator path.
    const newEval = h.db
      .prepare('SELECT status FROM evaluations WHERE id = ?')
      .get(resumed[0]!.evaluation_id) as { status: string };
    expect(newEval.status).toBe('complete');

    // The prior eval is still flagged interrupted_by_restart from recovery,
    // not overwritten by the resume.
    const prior = h.db
      .prepare('SELECT status, error_message FROM evaluations WHERE id = ?')
      .get(priorEvalId) as { status: string; error_message: string | null };
    expect(prior.status).toBe('error');
    expect(prior.error_message).toBe('interrupted_by_restart');
  });

  it('coalesces when a fresh evaluation is already running for the same session', async () => {
    const { sessionId } = await uploadOnePair(h);
    // Kick off a real eval that's mid-flight.
    const live = h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'tolerant',
    });
    // Resume a synthetic "prior" eval for the same session — should
    // coalesce onto the live one rather than start a duplicate.
    const priorEvalId = randomUUID();
    const resumed = resumeInterruptedEvaluations(h.evaluator, [
      {
        id: priorEvalId,
        session_id: sessionId,
        config_snapshot_json: JSON.stringify({ viewports: [desktop], target_level: 'tolerant' }),
      },
    ]);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.coalesced).toBe(true);
    expect(resumed[0]!.evaluation_id).toBe(live.evaluation_id);
    await settle(h);
  });
});
