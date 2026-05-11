import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { openDatabase, type Db } from '../src/db/client.js';
import { applySchema } from '../src/db/schema.js';
import { JobQueue } from '../src/services/queue.js';
import { createArtifactStore } from '../src/services/artifact-store.js';
import type { CaptureWorker } from '../src/services/capture.js';
import { recomputeClusters } from '../src/services/clusters.js';

function stubCaptureWorker(): CaptureWorker {
  return {
    capture: async () => ({ tempPath: '/dev/null', durationMs: 0, metadata: {} }),
    shutdown: async () => {},
  };
}

interface Harness {
  app: Express;
  db: Db;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-clusters-api-'));
  const db = openDatabase({ path: ':memory:' });
  applySchema(db);
  const queue = new JobQueue(db);
  const artifactStore = createArtifactStore(storeDir);
  const app = createApp({ db, queue, artifactStore, captureWorker: stubCaptureWorker() });
  return {
    app, db,
    cleanup: async () => {
      await rm(storeDir, { recursive: true, force: true });
      db.close();
    },
  };
}

function seed(db: Db): string {
  const now = new Date().toISOString();
  db.exec(`
    INSERT INTO sessions (id, name, csv_filename, created_at)
      VALUES ('s1', 'api-test', 't.csv', '${now}');
    INSERT INTO url_pairs (id, session_id, url_a, url_b, row_index, created_at)
      VALUES
        ('p1', 's1', 'https://a1', 'https://b1', 0, '${now}'),
        ('p2', 's1', 'https://a2', 'https://b2', 1, '${now}');
    INSERT INTO jobs (id, type, status, created_at)
      VALUES ('j1', 'comparison', 'complete', '${now}');
    INSERT INTO capture_runs (id, session_id, job_id, options_json, created_at)
      VALUES ('cr1', 's1', 'j1', '{}', '${now}');
    INSERT INTO captures (id, capture_run_id, url_pair_id, side, url, status, viewport_name, created_at)
      VALUES
        ('cap1', 'cr1', 'p1', 'a', 'https://a1', 'complete', 'desktop', '${now}'),
        ('cap2', 'cr1', 'p1', 'b', 'https://b1', 'complete', 'desktop', '${now}'),
        ('cap3', 'cr1', 'p2', 'a', 'https://a2', 'complete', 'desktop', '${now}'),
        ('cap4', 'cr1', 'p2', 'b', 'https://b2', 'complete', 'desktop', '${now}');
    INSERT INTO comparison_runs (id, session_id, capture_run_id, job_id, options_json, created_at)
      VALUES ('cmr1', 's1', 'cr1', 'j1', '{}', '${now}');
    INSERT INTO comparisons (id, comparison_run_id, url_pair_id, capture_a_id, capture_b_id, viewport_name, status, created_at)
      VALUES
        ('cmp1', 'cmr1', 'p1', 'cap1', 'cap2', 'desktop', 'complete', '${now}'),
        ('cmp2', 'cmr1', 'p2', 'cap3', 'cap4', 'desktop', 'complete', '${now}');
  `);
  const insertDiff = db.prepare(
    `INSERT INTO differences
       (id, comparison_id, source, description, severity, bounding_box_json,
        change_type, region_role, element_label, signature, signature_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Two v1 clusters across both pairs.
  insertDiff.run('d1', 'cmp1', 'lm', 'sidebar added', 'high',
    '{"x":0,"y":10,"width":25,"height":80}',
    'element_added', 'nav_primary', 'sidebar navigation',
    'sigA', 'v1', now);
  insertDiff.run('d2', 'cmp2', 'lm', 'sidebar added', 'high',
    '{"x":0,"y":10,"width":25,"height":80}',
    'element_added', 'nav_primary', 'sidebar navigation',
    'sigA', 'v1', now);
  insertDiff.run('d3', 'cmp1', 'lm', 'breadcrumb', 'low',
    '{"x":50,"y":15,"width":40,"height":5}',
    'text_changed', 'nav_secondary', 'breadcrumbs',
    'sigB', 'v1', now);
  recomputeClusters(db, 's1');
  return 's1';
}

describe('GET /api/sessions/:id/clusters', () => {
  let h: Harness;
  beforeEach(async () => { h = await makeHarness(); });
  afterEach(async () => { await h.cleanup(); });

  it('lists clusters sorted by pair_count desc with sample diffs', async () => {
    const sessionId = seed(h.db);
    const res = await request(h.app).get(`/api/sessions/${sessionId}/clusters`);
    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(sessionId);
    expect(res.body.total).toBe(2);
    expect(res.body.by_review_state).toEqual({ open: 2, accepted: 0, rejected: 0, split: 0, anomaly: 0 });

    const [first, second] = res.body.clusters as Array<{
      signature: string; pair_count: number; element_label: string;
      sample: { description: string; url_a: string } | null;
    }>;
    expect(first.signature).toBe('sigA'); // 2 pairs
    expect(first.pair_count).toBe(2);
    expect(first.element_label).toBe('sidebar navigation');
    expect(first.sample?.description).toBe('sidebar added');
    expect(first.sample?.url_a).toBe('https://a1');
    expect(second.signature).toBe('sigB'); // 1 pair
    expect(second.pair_count).toBe(1);
  });

  it('filters by review_state', async () => {
    const sessionId = seed(h.db);
    h.db.prepare(`UPDATE difference_clusters SET review_state = 'accepted' WHERE signature = 'sigB'`).run();

    const open = await request(h.app).get(`/api/sessions/${sessionId}/clusters?review_state=open`);
    expect(open.status).toBe(200);
    expect(open.body.clusters).toHaveLength(1);
    expect(open.body.clusters[0].signature).toBe('sigA');

    // by_review_state is unfiltered — the UI uses it to render tabs even when
    // a filter is active.
    expect(open.body.by_review_state).toEqual({ open: 1, accepted: 1, rejected: 0, split: 0, anomaly: 0 });
  });

  it('rejects unknown review_state values', async () => {
    const sessionId = seed(h.db);
    const res = await request(h.app).get(`/api/sessions/${sessionId}/clusters?review_state=bogus`);
    expect(res.status).toBe(400);
  });

  it('returns an empty list (not 404) for a session with no clusters', async () => {
    const now = new Date().toISOString();
    h.db.exec(
      `INSERT INTO sessions (id, name, csv_filename, created_at) VALUES ('s-empty', 'e', 'e.csv', '${now}')`,
    );
    const res = await request(h.app).get('/api/sessions/s-empty/clusters');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.clusters).toEqual([]);
  });
});

describe('GET /api/sessions/:id/clusters/:cluster_id', () => {
  let h: Harness;
  beforeEach(async () => { h = await makeHarness(); });
  afterEach(async () => { await h.cleanup(); });

  it('returns cluster detail with members', async () => {
    const sessionId = seed(h.db);
    const list = await request(h.app).get(`/api/sessions/${sessionId}/clusters`);
    const clusterId = list.body.clusters[0].id;

    const res = await request(h.app).get(`/api/sessions/${sessionId}/clusters/${clusterId}`);
    expect(res.status).toBe(200);
    expect(res.body.cluster.id).toBe(clusterId);
    expect(res.body.members).toHaveLength(2);
    for (const m of res.body.members as Array<{ viewport_name: string; bounding_box: unknown }>) {
      expect(m.viewport_name).toBe('desktop');
      expect(m.bounding_box).toEqual({ x: 0, y: 10, width: 25, height: 80 });
    }
    // Representative enriched with comparison data for inline rendering.
    expect(res.body.representative).not.toBeNull();
    expect(res.body.representative.comparison_id).toMatch(/^cmp/);
    expect(res.body.representative.url_a).toMatch(/^https:\/\/a/);
    expect(res.body.representative.bounding_box).toEqual({ x: 0, y: 10, width: 25, height: 80 });
  });

  it('returns 404 for an unknown cluster id', async () => {
    const sessionId = seed(h.db);
    const res = await request(h.app).get(`/api/sessions/${sessionId}/clusters/no-such`);
    expect(res.status).toBe(404);
  });
});
