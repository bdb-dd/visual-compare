import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import request from 'supertest';
import { openDatabase } from '../src/db/client.js';
import type { Db } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';
import { JobQueue } from '../src/services/queue.js';
import { createArtifactStore } from '../src/services/artifact-store.js';
import type { CaptureWorker } from '../src/services/capture.js';
import type { ComparisonImagick } from '../src/services/comparison.js';
import type { LmClient } from '../src/services/lm.js';
import { createApp } from '../src/app.js';
import { Evaluator } from '../src/services/evaluator.js';
import { invalidateSessionCaptures } from '../src/services/cache-invalidation.js';
import type { ViewportDef, UrlPairRow } from '../src/types.js';

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
      const dir = join(tmpdir(), 'vc-inv-test-captures');
      await mkdir(dir, { recursive: true });
      const path = join(dir, `cap-${counter++}.png`);
      await writeFile(
        path,
        Buffer.from(`STUB-${counter}\nurl=${args.url}\nvw=${args.viewport.name}\n`),
      );
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
      parsed: { equivalent: false, confidence: 0.7, summary: 'stub', differences: [] },
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
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-inv-itest-'));
  const db = openDatabase({ path: ':memory:' });
  runMigrations(db);
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

const csv = [
  'url_a,url_b,label',
  'https://a1.test,https://b1.test,P1',
  'https://a2.test,https://b2.test,P2',
  'https://a3.test,https://b3.test,P3',
].join('\n');

async function uploadAndCapture(h: Harness): Promise<{ sessionId: string; pairs: UrlPairRow[] }> {
  const upload = await request(h.app)
    .post('/api/sessions')
    .field('name', 'inv-test')
    .attach('csv', Buffer.from(csv), 'p.csv');
  expect(upload.status).toBe(201);
  const sessionId = upload.body.session.id as string;
  const pairs = upload.body.url_pairs as UrlPairRow[];

  // Populate the cache with one round of captures.
  h.evaluator.start(sessionId, {
    viewports: [desktop],
    equivalence_levels: ['tolerant'],
  });
  for (let i = 0; i < 8; i += 1) {
    await h.evaluator.drainAll();
    await h.queue.drain();
  }
  return { sessionId, pairs };
}

function cacheCount(db: Db, where = '', params: unknown[] = []): number {
  return (
    db
      .prepare<unknown[], { c: number }>(`SELECT COUNT(*) AS c FROM capture_cache ${where}`)
      .get(...(params as never[]))?.c ?? 0
  );
}

describe('invalidateSessionCaptures (service)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('empty body wipes everything for the session', async () => {
    const { sessionId } = await uploadAndCapture(h);
    expect(cacheCount(h.db)).toBe(6); // 3 pairs × 2 sides
    const result = invalidateSessionCaptures(h.db, sessionId, {});
    expect(result.deleted_count).toBe(6);
    expect(cacheCount(h.db)).toBe(0);
  });

  it('side="b" only drops B-side rows', async () => {
    const { sessionId } = await uploadAndCapture(h);
    const result = invalidateSessionCaptures(h.db, sessionId, { side: 'b' });
    expect(result.deleted_count).toBe(3);
    expect(result.invalidated_urls).toEqual(
      ['https://b1.test', 'https://b2.test', 'https://b3.test'],
    );
    // A-side rows survive.
    expect(cacheCount(h.db, "WHERE url LIKE 'https://a%'")).toBe(3);
    expect(cacheCount(h.db, "WHERE url LIKE 'https://b%'")).toBe(0);
  });

  it('pair_ids drops both sides of those pairs', async () => {
    const { sessionId, pairs } = await uploadAndCapture(h);
    const result = invalidateSessionCaptures(h.db, sessionId, {
      pair_ids: [pairs[0]!.id],
    });
    expect(result.deleted_count).toBe(2); // p1 a + b
    expect(cacheCount(h.db)).toBe(4);
  });

  it('pair_ids + side="a" is the most specific gesture', async () => {
    const { sessionId, pairs } = await uploadAndCapture(h);
    const result = invalidateSessionCaptures(h.db, sessionId, {
      pair_ids: [pairs[0]!.id, pairs[1]!.id],
      side: 'a',
    });
    expect(result.deleted_count).toBe(2);
    expect(result.invalidated_urls).toEqual(['https://a1.test', 'https://a2.test']);
  });

  it('silently filters pair_ids that do not belong to the session', async () => {
    const { sessionId, pairs } = await uploadAndCapture(h);
    const result = invalidateSessionCaptures(h.db, sessionId, {
      pair_ids: [pairs[0]!.id, 'not-real'],
    });
    expect(result.unknown_pair_ids).toEqual(['not-real']);
    expect(result.deleted_count).toBe(2);
  });

  it('leaves pixel_compare_cache rows in place (orphaned but inert)', async () => {
    const { sessionId } = await uploadAndCapture(h);
    const before = h.db
      .prepare<unknown[], { c: number }>('SELECT COUNT(*) AS c FROM pixel_compare_cache')
      .get()?.c;
    expect(before).toBe(3);
    invalidateSessionCaptures(h.db, sessionId, {});
    const after = h.db
      .prepare<unknown[], { c: number }>('SELECT COUNT(*) AS c FROM pixel_compare_cache')
      .get()?.c;
    expect(after).toBe(3);
  });
});

describe('POST /api/sessions/:id/invalidate-captures', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('round-trips the result body', async () => {
    const { sessionId } = await uploadAndCapture(h);
    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/invalidate-captures`)
      .send({ side: 'b' });
    expect(res.status).toBe(200);
    expect(res.body.deleted_count).toBe(3);
    expect(res.body.invalidated_urls).toHaveLength(3);
  });

  it('triggers a recapture on the next evaluation, only for the invalidated subset', async () => {
    const { sessionId } = await uploadAndCapture(h);

    // Snapshot the original capture row ids.
    const before = h.db
      .prepare<unknown[], { url: string; capture_id: string }>(
        'SELECT url, capture_id FROM capture_cache ORDER BY url',
      )
      .all();

    await request(h.app)
      .post(`/api/sessions/${sessionId}/invalidate-captures`)
      .send({ side: 'b' });

    // After invalidation: B rows gone, A rows untouched.
    expect(cacheCount(h.db)).toBe(3);

    // Re-evaluate → captures only the B side.
    h.evaluator.start(sessionId, {
      viewports: [desktop],
      equivalence_levels: ['tolerant'],
    });
    for (let i = 0; i < 8; i += 1) {
      await h.evaluator.drainAll();
      await h.queue.drain();
    }

    const after = h.db
      .prepare<unknown[], { url: string; capture_id: string }>(
        'SELECT url, capture_id FROM capture_cache ORDER BY url',
      )
      .all();
    expect(after).toHaveLength(6);
    // A-side capture_ids unchanged.
    for (const row of after.filter((r) => r.url.startsWith('https://a'))) {
      const orig = before.find((b) => b.url === row.url);
      expect(row.capture_id).toBe(orig!.capture_id);
    }
    // B-side capture_ids replaced.
    for (const row of after.filter((r) => r.url.startsWith('https://b'))) {
      const orig = before.find((b) => b.url === row.url);
      expect(row.capture_id).not.toBe(orig!.capture_id);
    }
  });

  it('rejects invalid bodies', async () => {
    const { sessionId } = await uploadAndCapture(h);
    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/invalidate-captures`)
      .send({ side: 'c' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });

  it('returns 404 for unknown session', async () => {
    const res = await request(h.app)
      .post('/api/sessions/missing/invalidate-captures')
      .send({});
    expect(res.status).toBe(404);
  });
});
