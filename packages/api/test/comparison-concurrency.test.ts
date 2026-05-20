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
import { comparisonRunOptionsSchema } from '../src/services/comparison.js';
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
      const dir = join(tmpdir(), 'vc-cc-test-captures');
      await mkdir(dir, { recursive: true });
      const path = join(dir, `cap-${counter++}.png`);
      await writeFile(path, Buffer.from(`STUB-${counter}`));
      return { tempPath: path, durationMs: 1, httpStatus: 200, isMissing: false };
    },
    shutdown: async () => {},
  };
}

/**
 * Imagick stub that holds compareAe open until released and tracks the
 * peak concurrent count. Lets the test assert the parallel comparison loop
 * respects the configured concurrency.
 */
function trackingImagick(): ComparisonImagick & {
  peakInFlight: number;
  inFlight: number;
  release: () => void;
  resolveCount: number;
} {
  let pending: Array<() => void> = [];
  const out = {
    inFlight: 0,
    peakInFlight: 0,
    resolveCount: 0,
    release: () => {
      const all = pending;
      pending = [];
      for (const r of all) r();
    },
    compareAe: async (_a: string, _b: string, diffPath: string) => {
      out.inFlight += 1;
      out.peakInFlight = Math.max(out.peakInFlight, out.inFlight);
      // Block until release() is called. The test fires release() after
      // verifying the peak; this lets us confirm "exactly N in flight at
      // once" without timing flakiness.
      await new Promise<void>((resolve) => {
        pending.push(resolve);
      });
      out.inFlight -= 1;
      out.resolveCount += 1;
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
  } satisfies ComparisonImagick & {
    peakInFlight: number;
    inFlight: number;
    release: () => void;
    resolveCount: number;
  };
  return out;
}

function stubLm(): LmClient {
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
    analyze: async () => ({ kind: 'error', message: 'unused' }),
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  db: Db;
  queue: JobQueue;
  imagick: ReturnType<typeof trackingImagick>;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-cc-itest-'));
  const db = openDatabase({ path: ':memory:' });
  applySchema(db);
  const queue = new JobQueue(db);
  const artifactStore = createArtifactStore(storeDir);
  const imagick = trackingImagick();
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

async function uploadSession(app: Harness['app'], pairs: number): Promise<string> {
  const rows = ['url_a,url_b,label'];
  for (let i = 1; i <= pairs; i++) {
    rows.push(`https://a.example.com/${i},https://b.example.com/${i},pair-${i}`);
  }
  const upload = await request(app)
    .post('/api/sessions')
    .field('name', 'concurrency-test')
    .attach('csv', Buffer.from(rows.join('\n')), 'pairs.csv');
  expect(upload.status).toBe(201);
  return upload.body.session.id as string;
}

async function startCaptures(h: Harness, sessionId: string): Promise<string> {
  const captureStart = await request(h.app)
    .post('/api/capture-runs')
    .send({ session_id: sessionId, options: { viewports: [desktop] } });
  await h.queue.drain();
  return captureStart.body.capture_run_id as string;
}

describe('comparison run concurrency', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
    // Ensure no dangling pending promises in the imagick stub.
    h.imagick.release();
  });

  it('processes up to `concurrency` comparisons in parallel and no more', async () => {
    const sessionId = await uploadSession(h.app, 6);
    const captureRunId = await startCaptures(h, sessionId);

    const comp = await request(h.app)
      .post('/api/comparison-runs')
      .send({
        session_id: sessionId,
        capture_run_id: captureRunId,
        options: { targetLevel: 'tolerant', concurrency: 3 },
      });
    expect(comp.status).toBe(202);
    // Don't drain yet — let the comparison job start, accumulate in-flight.
    const drainP = h.queue.drain();
    // Wait for all 3 worker slots to be saturated. The stub holds compareAe
    // open until release(), so once 3 are pending, peakInFlight is locked.
    await new Promise<void>((resolve) => {
      const tick = () => {
        if (h.imagick.inFlight >= 3) resolve();
        else setTimeout(tick, 5);
      };
      tick();
    });
    expect(h.imagick.peakInFlight).toBe(3);
    expect(h.imagick.inFlight).toBe(3);
    // Only 3 of 6 are blocked — the other 3 are sitting in the limit queue.
    h.imagick.release();
    // Need a couple of release passes since freed slots immediately pick up
    // the next batch of 3 (which then also block).
    await new Promise((r) => setTimeout(r, 10));
    h.imagick.release();
    await drainP;
    expect(h.imagick.resolveCount).toBe(6);
    expect(h.imagick.peakInFlight).toBe(3);
  });

  it('applies the schema default concurrency when omitted from the request', async () => {
    // The default is hardware-derived (availableParallelism() - 1), so read
    // it from the schema rather than hard-coding a number. The assertion
    // that matters is "the parsed default is the peak we observe" — i.e.
    // the default flows HTTP body → schema → comparison loop intact.
    const expectedDefault = comparisonRunOptionsSchema.parse({
      targetLevel: 'tolerant',
    }).concurrency;

    const sessionId = await uploadSession(h.app, expectedDefault * 2);
    const captureRunId = await startCaptures(h, sessionId);

    await request(h.app)
      .post('/api/comparison-runs')
      .send({
        session_id: sessionId,
        capture_run_id: captureRunId,
        options: { targetLevel: 'tolerant' },
      })
      .expect(202);

    const drainP = h.queue.drain();
    await new Promise<void>((resolve) => {
      const tick = () => {
        if (h.imagick.inFlight >= expectedDefault) resolve();
        else setTimeout(tick, 5);
      };
      tick();
    });
    expect(h.imagick.peakInFlight).toBe(expectedDefault);
    h.imagick.release();
    await new Promise((r) => setTimeout(r, 10));
    h.imagick.release();
    await drainP;
    expect(h.imagick.resolveCount).toBe(expectedDefault * 2);
  });

  it('completes all comparisons when concurrency=1 (regression guard)', async () => {
    const sessionId = await uploadSession(h.app, 3);
    const captureRunId = await startCaptures(h, sessionId);

    await request(h.app)
      .post('/api/comparison-runs')
      .send({
        session_id: sessionId,
        capture_run_id: captureRunId,
        options: { targetLevel: 'tolerant', concurrency: 1 },
      })
      .expect(202);

    const drainP = h.queue.drain();
    // Drain by releasing one slot at a time. Sequential in-flight = 1.
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve) => {
        const tick = () => {
          if (h.imagick.inFlight >= 1) resolve();
          else setTimeout(tick, 5);
        };
        tick();
      });
      h.imagick.release();
      await new Promise((r) => setTimeout(r, 5));
    }
    await drainP;
    expect(h.imagick.peakInFlight).toBe(1);
    expect(h.imagick.resolveCount).toBe(3);
  });

  it('rejects concurrency outside [1, 16]', async () => {
    const sessionId = await uploadSession(h.app, 1);
    const captureRunId = await startCaptures(h, sessionId);

    const tooHigh = await request(h.app)
      .post('/api/comparison-runs')
      .send({
        session_id: sessionId,
        capture_run_id: captureRunId,
        options: { targetLevel: 'tolerant', concurrency: 17 },
      });
    expect(tooHigh.status).toBe(400);

    const tooLow = await request(h.app)
      .post('/api/comparison-runs')
      .send({
        session_id: sessionId,
        capture_run_id: captureRunId,
        options: { targetLevel: 'tolerant', concurrency: 0 },
      });
    expect(tooLow.status).toBe(400);
  });
});
