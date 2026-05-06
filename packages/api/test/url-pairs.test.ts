import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { openDatabase } from '../src/db/client.js';
import type { Db } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';
import { JobQueue } from '../src/services/queue.js';
import { createArtifactStore } from '../src/services/artifact-store.js';
import { createApp } from '../src/app.js';
import type { CaptureWorker } from '../src/services/capture.js';
import type { ComparisonImagick } from '../src/services/comparison.js';

function noopCaptureWorker(): CaptureWorker {
  return {
    capture: async () => {
      throw new Error('not invoked in url-pairs tests');
    },
    shutdown: async () => {},
  };
}

function noopImagick(): ComparisonImagick {
  return {
    compareAe: async () => {
      throw new Error('not invoked');
    },
    compareSsim: async () => 1,
    extractConnectedComponents: async () => ({ format: 'json', raw: '[]' }),
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  db: Db;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-pairs-itest-'));
  const db = openDatabase({ path: ':memory:' });
  runMigrations(db);
  const queue = new JobQueue(db);
  const artifactStore = createArtifactStore(storeDir);
  const app = createApp({
    db,
    queue,
    artifactStore,
    captureWorker: noopCaptureWorker(),
    imagick: noopImagick(),
  });
  return {
    app,
    db,
    cleanup: async () => {
      await rm(storeDir, { recursive: true, force: true });
      db.close();
    },
  };
}

async function uploadSeed(app: Harness['app']): Promise<{ sessionId: string; pairId: string }> {
  const csv = [
    'url_a,url_b,label,language,category',
    'https://a1.test,https://b1.test,P1,en,top',
  ].join('\n');
  const upload = await request(app)
    .post('/api/sessions')
    .field('name', 'pairs-test')
    .attach('csv', Buffer.from(csv), 'p.csv');
  expect(upload.status).toBe(201);
  return {
    sessionId: upload.body.session.id as string,
    pairId: upload.body.url_pairs[0].id as string,
  };
}

describe('POST /api/sessions/:id/url-pairs', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('appends pairs at MAX(row_index)+1 with metadata persisted', async () => {
    const { sessionId } = await uploadSeed(h.app);

    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/url-pairs`)
      .send({
        pairs: [
          { url_a: 'https://a2.test', url_b: 'https://b2.test', label: 'P2', language: 'no' },
          { url_a: 'https://a3.test', url_b: 'https://b3.test' },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.url_pairs).toHaveLength(2);
    expect(res.body.url_pairs[0]).toMatchObject({
      row_index: 1,
      url_a: 'https://a2.test',
      label: 'P2',
      language: 'no',
    });
    expect(res.body.url_pairs[1].row_index).toBe(2);
    expect(res.body.url_pairs[1].label).toBeNull();
  });

  it('rejects malformed URLs', async () => {
    const { sessionId } = await uploadSeed(h.app);
    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/url-pairs`)
      .send({ pairs: [{ url_a: 'ftp://nope', url_b: 'https://ok.test' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });

  it('returns 404 for unknown session', async () => {
    const res = await request(h.app)
      .post('/api/sessions/missing/url-pairs')
      .send({ pairs: [{ url_a: 'https://a.test', url_b: 'https://b.test' }] });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/sessions/:id/url-pairs/:pair_id', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('updates metadata in place when URLs are unchanged', async () => {
    const { sessionId, pairId } = await uploadSeed(h.app);
    const res = await request(h.app)
      .patch(`/api/sessions/${sessionId}/url-pairs/${pairId}`)
      .send({ label: 'renamed', category: 'hjelp' });
    expect(res.status).toBe(200);
    expect(res.body.replaced_id).toBeNull();
    expect(res.body.pair).toMatchObject({
      id: pairId,
      label: 'renamed',
      category: 'hjelp',
      url_a: 'https://a1.test',
      disabled: 0,
    });
    // Still exactly one pair in this session.
    const detail = await request(h.app).get(`/api/sessions/${sessionId}`);
    expect(detail.body.url_pairs).toHaveLength(1);
  });

  it('add+disable when url_a changes', async () => {
    const { sessionId, pairId } = await uploadSeed(h.app);
    const res = await request(h.app)
      .patch(`/api/sessions/${sessionId}/url-pairs/${pairId}`)
      .send({ url_a: 'https://a1-v2.test' });
    expect(res.status).toBe(200);
    expect(res.body.replaced_id).toBe(pairId);
    expect(res.body.pair.id).not.toBe(pairId);
    expect(res.body.pair).toMatchObject({
      url_a: 'https://a1-v2.test',
      url_b: 'https://b1.test',
      label: 'P1',          // inherited from predecessor
      language: 'en',        // inherited
      row_index: 1,          // appended at end
      disabled: 0,
    });

    const detail = await request(h.app).get(`/api/sessions/${sessionId}`);
    expect(detail.body.url_pairs).toHaveLength(2);
    const oldRow = detail.body.url_pairs.find((p: { id: string }) => p.id === pairId);
    expect(oldRow.disabled).toBe(1);
  });

  it('disabled flag toggles in place', async () => {
    const { sessionId, pairId } = await uploadSeed(h.app);
    const off = await request(h.app)
      .patch(`/api/sessions/${sessionId}/url-pairs/${pairId}`)
      .send({ disabled: true });
    expect(off.body.pair.disabled).toBe(1);
    const on = await request(h.app)
      .patch(`/api/sessions/${sessionId}/url-pairs/${pairId}`)
      .send({ disabled: false });
    expect(on.body.pair.disabled).toBe(0);
  });

  it('disabled pair is excluded from /results plan', async () => {
    const { sessionId, pairId } = await uploadSeed(h.app);
    await request(h.app)
      .post(`/api/sessions/${sessionId}/url-pairs`)
      .send({ pairs: [{ url_a: 'https://a2.test', url_b: 'https://b2.test' }] });

    const before = await request(h.app).get(`/api/sessions/${sessionId}/results`);
    expect(before.body.plan.enabled_pair_count).toBe(2);

    await request(h.app)
      .patch(`/api/sessions/${sessionId}/url-pairs/${pairId}`)
      .send({ disabled: true });

    const after = await request(h.app).get(`/api/sessions/${sessionId}/results`);
    expect(after.body.plan.enabled_pair_count).toBe(1);
    expect(after.body.results.every((r: { url_pair_id: string }) => r.url_pair_id !== pairId)).toBe(true);
  });

  it('returns 404 for a pair_id that does not belong to the session', async () => {
    const { sessionId } = await uploadSeed(h.app);
    const res = await request(h.app)
      .patch(`/api/sessions/${sessionId}/url-pairs/not-a-real-id`)
      .send({ label: 'x' });
    expect(res.status).toBe(404);
  });
});
