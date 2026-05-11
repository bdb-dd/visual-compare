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
      const dir = join(tmpdir(), 'vc-fastpath-captures');
      await mkdir(dir, { recursive: true });
      const path = join(dir, `cap-${counter++}.png`);
      await writeFile(path, Buffer.from(`STUB-${counter}`));
      return { tempPath: path, durationMs: 1, httpStatus: 200, isMissing: false };
    },
    shutdown: async () => {},
  };
}

/**
 * Counts compareAe / extractCC calls so the test can assert the IM pipeline
 * was (or wasn't) re-run. compareAe always succeeds and writes a tiny diff.
 */
function countingImagick(): ComparisonImagick & {
  compareAeCalls: number;
  extractCcCalls: number;
} {
  const out = {
    compareAeCalls: 0,
    extractCcCalls: 0,
    compareAe: async (_a: string, _b: string, diffPath: string) => {
      out.compareAeCalls += 1;
      await mkdir(dirname(diffPath), { recursive: true });
      await writeFile(diffPath, Buffer.from('DIFF'));
      // Strict-target metrics: 1% changed, ssim 0.97. Won't match strict
      // (changed_pct > 0.5) so LM is invoked when invokeLm=true.
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
    extractConnectedComponents: async () => {
      out.extractCcCalls += 1;
      return { format: 'json' as const, raw: '[]' };
    },
  } satisfies ComparisonImagick & { compareAeCalls: number; extractCcCalls: number };
  return out;
}

interface AlwaysFailingLmConfig {
  shouldSucceed: () => boolean;
}

function configurableLm(opts: AlwaysFailingLmConfig): LmClient & { calls: number } {
  let calls = 0;
  return {
    calls,
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
    analyze: async () => {
      calls++;
      if (opts.shouldSucceed()) {
        return {
          parsed: {
            equivalent: true,
            confidence: 0.9,
            summary: 'visually equivalent',
            differences: [],
          },
          rawText: '{"equivalent":true}',
          path: 'json_schema',
          promptVersion: 'stub-prompt',
          model: 'stub-model',
        };
      }
      return {
        parsed: null,
        rawText: null,
        message: 'simulated context-exceeded',
        promptVersion: 'stub-prompt',
        model: 'stub-model',
      };
    },
    get callCount() {
      return calls;
    },
  } as LmClient & { calls: number };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  db: Db;
  queue: JobQueue;
  imagick: ReturnType<typeof countingImagick>;
  cleanup: () => Promise<void>;
}

async function makeHarness(
  shouldSucceed: () => boolean,
): Promise<Harness & { lm: LmClient & { calls: number } }> {
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-fastpath-itest-'));
  const db = openDatabase({ path: ':memory:' });
  applySchema(db);
  const queue = new JobQueue(db);
  const artifactStore = createArtifactStore(storeDir);
  const imagick = countingImagick();
  const lm = configurableLm({ shouldSucceed });
  const app = createApp({
    db,
    queue,
    artifactStore,
    captureWorker: stubCaptureWorker(),
    imagick,
    lm,
  });
  return {
    app,
    db,
    queue,
    imagick,
    lm,
    cleanup: async () => {
      await rm(storeDir, { recursive: true, force: true });
      db.close();
    },
  };
}

async function uploadSession(app: Harness['app']): Promise<string> {
  const csv = ['url_a,url_b,label', 'https://a.example.com/1,https://b.example.com/1,pair-1'].join('\n');
  const upload = await request(app)
    .post('/api/sessions')
    .field('name', 'fastpath')
    .attach('csv', Buffer.from(csv), 'pairs.csv');
  expect(upload.status).toBe(201);
  return upload.body.session.id as string;
}

async function startCaptures(h: Harness, sessionId: string): Promise<string> {
  const cap = await request(h.app)
    .post('/api/capture-runs')
    .send({ session_id: sessionId, options: { viewports: [desktop] } });
  await h.queue.drain();
  return cap.body.capture_run_id as string;
}

describe('pixel-cache fast path on rerun', () => {
  it('skips the IM pipeline when pixel_compare_cache already has the verdict', async () => {
    // First LM call fails (IM verdict cached, LM not). Second succeeds — that
    // second run is the LM-only retry that benefits from skipping IM.
    let lmShouldSucceed = false;
    const h = await makeHarness(() => lmShouldSucceed);
    try {
      const sessionId = await uploadSession(h.app);
      const captureRunId = await startCaptures(h, sessionId);

      // Pass 1: invokeLm=true on a strict target. compareAe runs once for
      // the single pair. LM gets called and fails — IM verdict is persisted
      // (split-persistence guarantee), no lm_verdict_cache entry written.
      await request(h.app)
        .post('/api/comparison-runs')
        .send({
          session_id: sessionId,
          capture_run_id: captureRunId,
          options: { targetLevel: 'strict', invokeLm: true },
        })
        .expect(202);
      await h.queue.drain();

      expect(h.imagick.compareAeCalls).toBe(1);
      expect(h.imagick.extractCcCalls).toBe(1);
      const pixelCount = h.db
        .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM pixel_compare_cache`)
        .get();
      expect(pixelCount?.n).toBe(1);
      const lmCount = h.db
        .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM lm_verdict_cache`)
        .get();
      expect(lmCount?.n).toBe(0);

      // Pass 2: same captures, same target, but now the LM stub succeeds.
      // The fast path means compareAe / extractCC must NOT fire again.
      lmShouldSucceed = true;
      await request(h.app)
        .post('/api/comparison-runs')
        .send({
          session_id: sessionId,
          capture_run_id: captureRunId,
          options: { targetLevel: 'strict', invokeLm: true },
        })
        .expect(202);
      await h.queue.drain();

      expect(h.imagick.compareAeCalls).toBe(1); // unchanged from pass 1
      expect(h.imagick.extractCcCalls).toBe(1); // unchanged from pass 1

      // The new run produced an LM verdict for the cached IM result.
      const lmAfter = h.db
        .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM lm_verdict_cache`)
        .get();
      expect(lmAfter?.n).toBe(1);

      // Latest comparison row was promoted to 'lm' (LM verdict overrode the
      // pixel-only assignment from the cached IM step).
      const latest = h.db
        .prepare<
          unknown[],
          {
            status: string;
            matched_decided_by: string | null;
            lm_determined_equivalent: number | null;
            changed_pixel_percentage: number | null;
          }
        >(
          `SELECT status, matched_decided_by, lm_determined_equivalent, changed_pixel_percentage
             FROM comparisons ORDER BY created_at DESC LIMIT 1`,
        )
        .get();
      expect(latest?.status).toBe('complete');
      expect(latest?.matched_decided_by).toBe('lm');
      expect(latest?.lm_determined_equivalent).toBe(1);
      // IM metrics flowed from cache through to the new comparison row.
      expect(latest?.changed_pixel_percentage).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  it('copies imagick differences from the prior comparison so the new row has bbox overlays', async () => {
    let lmShouldSucceed = true;
    const h = await makeHarness(() => lmShouldSucceed);
    try {
      const sessionId = await uploadSession(h.app);
      const captureRunId = await startCaptures(h, sessionId);

      // Pass 1: full pipeline. Manually insert a difference row so we can
      // assert it's copied across to the new comparison in pass 2 (the
      // counting stub returns no regions).
      await request(h.app)
        .post('/api/comparison-runs')
        .send({
          session_id: sessionId,
          capture_run_id: captureRunId,
          options: { targetLevel: 'tolerant' },
        })
        .expect(202);
      await h.queue.drain();
      const firstRow = h.db
        .prepare<unknown[], { id: string }>(
          `SELECT id FROM comparisons ORDER BY created_at DESC LIMIT 1`,
        )
        .get();
      h.db
        .prepare(
          `INSERT INTO differences (id, comparison_id, source, description, severity, bounding_box_json, created_at)
           VALUES ('seed-diff', ?, 'imagick', 'seeded region', NULL, '{"x":10,"y":20,"width":30,"height":40}', '2025-01-01')`,
        )
        .run(firstRow!.id);

      // Pass 2: cache hit path. Imagick differences from pass 1 should be
      // copied to the new comparison_id so detail-view bbox overlays still
      // render after a cache hit.
      await request(h.app)
        .post('/api/comparison-runs')
        .send({
          session_id: sessionId,
          capture_run_id: captureRunId,
          options: { targetLevel: 'tolerant' },
        })
        .expect(202);
      await h.queue.drain();

      const newRow = h.db
        .prepare<unknown[], { id: string }>(
          `SELECT id FROM comparisons ORDER BY created_at DESC LIMIT 1`,
        )
        .get();
      const newDiffs = h.db
        .prepare<
          [string],
          { description: string; bounding_box_json: string }
        >(
          `SELECT description, bounding_box_json FROM differences
            WHERE comparison_id = ? AND source = 'imagick'`,
        )
        .all(newRow!.id);
      expect(newDiffs).toHaveLength(1);
      expect(newDiffs[0]!.description).toBe('seeded region');
      expect(newDiffs[0]!.bounding_box_json).toBe(
        '{"x":10,"y":20,"width":30,"height":40}',
      );
    } finally {
      await h.cleanup();
    }
  });
});
