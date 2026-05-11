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
import type { SessionResultsDto, ViewportDef } from '../src/types.js';

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
      const dir = join(tmpdir(), 'vc-delta-test-captures');
      await mkdir(dir, { recursive: true });
      const path = join(dir, `cap-${counter++}.png`);
      await writeFile(path, Buffer.from(`STUB-${counter}`));
      return { tempPath: path, durationMs: 1, httpStatus: 200, isMissing: false };
    },
    shutdown: async () => {},
  };
}

function stubImagick(): ComparisonImagick {
  return {
    compareAe: async (_a, _b, diffPath) => {
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
  };
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
    analyze: async () => ({
      kind: 'error',
      message: 'unused',
    }),
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  db: Db;
  queue: JobQueue;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-delta-itest-'));
  const db = openDatabase({ path: ':memory:' });
  applySchema(db);
  const queue = new JobQueue(db);
  const artifactStore = createArtifactStore(storeDir);
  const app = createApp({
    db,
    queue,
    artifactStore,
    captureWorker: stubCaptureWorker(),
    imagick: stubImagick(),
    lm: stubLm(),
  });
  return {
    app,
    db,
    queue,
    cleanup: async () => {
      await rm(storeDir, { recursive: true, force: true });
      db.close();
    },
  };
}

async function uploadSession(app: Harness['app'], pairs: number = 2): Promise<string> {
  const rows = ['url_a,url_b,label'];
  for (let i = 1; i <= pairs; i++) {
    rows.push(`https://a.example.com/${i},https://b.example.com/${i},pair-${i}`);
  }
  const upload = await request(app)
    .post('/api/sessions')
    .field('name', 'delta-test')
    .attach('csv', Buffer.from(rows.join('\n')), 'pairs.csv');
  expect(upload.status).toBe(201);
  return upload.body.session.id as string;
}

async function captureAndCompare(h: Harness, sessionId: string): Promise<void> {
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
}

describe('GET /sessions/:id/results delta params', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('?since with no new changes returns empty changed_pair_keys but still includes plan/summary/cursor', async () => {
    const sessionId = await uploadSession(h.app, 2);
    await captureAndCompare(h, sessionId);
    // Pin since to "now" — comparisons completed BEFORE this point.
    const since = new Date(Date.now() + 1000).toISOString();
    const res = await request(h.app)
      .get(`/api/sessions/${sessionId}/results`)
      .query({ since });
    expect(res.status).toBe(200);
    const body = res.body as SessionResultsDto;
    expect(body.results).toEqual([]);
    expect(body.changed_pair_keys).toEqual([]);
    expect(typeof body.cursor).toBe('string');
    // Plan + summary still populated so the polling client can update header
    // counts on every tick.
    expect(body.plan).toBeDefined();
    expect(body.summary).toBeDefined();
    expect(body.summary.total).toBe(2);
  });

  it('?since reports compound keys for comparisons completed after the timestamp', async () => {
    const sessionId = await uploadSession(h.app, 2);
    // Snapshot the cursor BEFORE the captures run so all subsequent
    // comparisons appear as "changed since".
    const since = new Date(Date.now() - 1000).toISOString();
    await captureAndCompare(h, sessionId);
    const res = await request(h.app)
      .get(`/api/sessions/${sessionId}/results`)
      .query({ since });
    expect(res.status).toBe(200);
    const body = res.body as SessionResultsDto;
    expect(body.results).toEqual([]);
    expect(body.changed_pair_keys).toBeDefined();
    expect(body.changed_pair_keys!.length).toBe(2);
    // Each entry is `<url_pair_id>::<viewport_name>`. The exact uuids vary
    // per run; assert the shape rather than the values.
    for (const k of body.changed_pair_keys!) {
      expect(k).toMatch(/^[0-9a-f-]+::desktop$/);
    }
  });

  it('?since reports a key when an acceptance is created after the timestamp', async () => {
    const sessionId = await uploadSession(h.app, 1);
    await captureAndCompare(h, sessionId);

    // Take the row to know the url_pair_id, then mark the cursor BEFORE the
    // acceptance so creating it produces a delta.
    const full = await request(h.app).get(`/api/sessions/${sessionId}/results`);
    const row = (full.body as SessionResultsDto).results[0]!;
    const since = new Date(Date.now() - 1000).toISOString();

    await request(h.app)
      .post(`/api/sessions/${sessionId}/acceptances`)
      .send({
        url_pair_id: row.url_pair_id,
        viewport_name: row.viewport_name,
        accepted_level: row.matched_at_level,
        accepted_pixel_pct: row.pixel?.changed_pct ?? null,
        accepted_ssim: row.pixel?.ssim ?? null,
        accepted_diff_regions: [],
        accepted_capture_a_sha: row.capture_a_sha,
        accepted_capture_b_sha: row.capture_b_sha,
        accept_any: false,
        label: null,
      })
      .expect(201);

    const delta = await request(h.app)
      .get(`/api/sessions/${sessionId}/results`)
      .query({ since });
    expect(delta.status).toBe(200);
    const body = delta.body as SessionResultsDto;
    expect(body.changed_pair_keys).toContain(`${row.url_pair_id}::${row.viewport_name}`);
  });

  it('?keys returns only the requested rows; summary is still over the unfiltered set', async () => {
    const sessionId = await uploadSession(h.app, 3);
    await captureAndCompare(h, sessionId);

    const full = await request(h.app).get(`/api/sessions/${sessionId}/results`);
    const allRows = (full.body as SessionResultsDto).results;
    expect(allRows).toHaveLength(3);

    const target = allRows[1]!;
    const keyToFetch = `${target.url_pair_id}::${target.viewport_name}`;
    const filtered = await request(h.app)
      .get(`/api/sessions/${sessionId}/results`)
      .query({ keys: keyToFetch });
    expect(filtered.status).toBe(200);
    const body = filtered.body as SessionResultsDto;
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.url_pair_id).toBe(target.url_pair_id);
    // Summary computed over all rows so chip counts stay stable.
    expect(body.summary.total).toBe(3);
  });

  it('?keys with unknown keys silently returns empty results', async () => {
    const sessionId = await uploadSession(h.app, 1);
    await captureAndCompare(h, sessionId);
    const filtered = await request(h.app)
      .get(`/api/sessions/${sessionId}/results`)
      .query({ keys: 'bogus-uuid::desktop' });
    expect(filtered.status).toBe(200);
    expect((filtered.body as SessionResultsDto).results).toHaveLength(0);
  });

  it('no params keeps the full-dump behavior (regression check)', async () => {
    const sessionId = await uploadSession(h.app, 2);
    await captureAndCompare(h, sessionId);
    const res = await request(h.app).get(`/api/sessions/${sessionId}/results`);
    expect(res.status).toBe(200);
    const body = res.body as SessionResultsDto;
    expect(body.results).toHaveLength(2);
    expect(body.changed_pair_keys).toBeUndefined();
    expect(body.cursor).toBeUndefined();
    expect(body.latest_evaluation).toBeUndefined();
  });
});
