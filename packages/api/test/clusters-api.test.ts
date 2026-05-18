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

describe('POST /api/sessions/:id/clusters/:cluster_id/accept', () => {
  let h: Harness;
  beforeEach(async () => { h = await makeHarness(); });
  afterEach(async () => { await h.cleanup(); });

  // The Phase D mutation routes require captures to have shas (the
  // fan-out skips comparisons without them). The shared seed() above
  // doesn't set screenshot_sha256; patch in dummy shas before running
  // the accept/reject tests.
  function patchInShas(): void {
    h.db.exec(`
      UPDATE captures SET screenshot_sha256 = REPLACE(printf('%064d', CAST(SUBSTR(id, 4) AS INTEGER)), ' ', '0');
    `);
  }

  it('accepts a cluster and fans out into acceptances', async () => {
    const sessionId = seed(h.db);
    patchInShas();
    const list = await request(h.app).get(`/api/sessions/${sessionId}/clusters`);
    const cluster = list.body.clusters.find(
      (c: { signature: string }) => c.signature === 'sigA',
    );

    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/clusters/${cluster.id}/accept`)
      .send({ label: 'sidebar nav added', notes: 'expected change for sitewide rollout' });
    expect(res.status).toBe(200);
    expect(res.body.cluster.review_state).toBe('accepted');
    expect(res.body.cluster.review_notes).toBe('expected change for sitewide rollout');
    expect(res.body.rule.signature).toBe('sigA');
    expect(res.body.rule.label).toBe('sidebar nav added');
    expect(res.body.acceptances_created).toBe(2);
    expect(res.body.acceptances_preserved).toBe(0);

    // Acceptances exist with the rule id.
    const acceptances = h.db.prepare(
      `SELECT acceptance_rule_id FROM acceptances WHERE session_id = ?`,
    ).all(sessionId) as Array<{ acceptance_rule_id: string | null }>;
    expect(acceptances).toHaveLength(2);
    expect(acceptances.every((a) => a.acceptance_rule_id === res.body.rule.id)).toBe(true);
  });

  it('returns 409 on double-accept', async () => {
    const sessionId = seed(h.db);
    patchInShas();
    const list = await request(h.app).get(`/api/sessions/${sessionId}/clusters`);
    const cluster = list.body.clusters.find(
      (c: { signature: string }) => c.signature === 'sigA',
    );
    await request(h.app).post(`/api/sessions/${sessionId}/clusters/${cluster.id}/accept`).send({});
    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/clusters/${cluster.id}/accept`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_accepted');
  });

  it('returns 404 for an unknown cluster id', async () => {
    const sessionId = seed(h.db);
    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/clusters/no-such/accept`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('rejects an invalid body shape', async () => {
    const sessionId = seed(h.db);
    const list = await request(h.app).get(`/api/sessions/${sessionId}/clusters`);
    const clusterId = list.body.clusters[0].id;
    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/clusters/${clusterId}/accept`)
      .send({ label: 123 });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/sessions/:id/clusters/:cluster_id/reject', () => {
  let h: Harness;
  beforeEach(async () => { h = await makeHarness(); });
  afterEach(async () => { await h.cleanup(); });

  function patchInShas(): void {
    h.db.exec(`
      UPDATE captures SET screenshot_sha256 = REPLACE(printf('%064d', CAST(SUBSTR(id, 4) AS INTEGER)), ' ', '0');
    `);
  }

  it('revokes a previously-accepted cluster and deletes its rule-owned acceptances', async () => {
    const sessionId = seed(h.db);
    patchInShas();
    const list = await request(h.app).get(`/api/sessions/${sessionId}/clusters`);
    const cluster = list.body.clusters.find(
      (c: { signature: string }) => c.signature === 'sigA',
    );
    await request(h.app)
      .post(`/api/sessions/${sessionId}/clusters/${cluster.id}/accept`)
      .send({});

    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/clusters/${cluster.id}/reject`)
      .send({ notes: 'actually this is a regression' });
    expect(res.status).toBe(200);
    expect(res.body.cluster.review_state).toBe('rejected');
    expect(res.body.acceptances_revoked).toBe(2);
    expect(res.body.rules_deleted).toBe(1);

    const remaining = h.db.prepare(
      `SELECT COUNT(*) AS c FROM acceptances WHERE session_id = ?`,
    ).get(sessionId) as { c: number };
    expect(remaining.c).toBe(0);
  });

  it('rejects an open cluster directly (no rules to clean up)', async () => {
    const sessionId = seed(h.db);
    const list = await request(h.app).get(`/api/sessions/${sessionId}/clusters`);
    const clusterId = list.body.clusters[0].id;
    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/clusters/${clusterId}/reject`)
      .send({ notes: 'cosmetic only' });
    expect(res.status).toBe(200);
    expect(res.body.cluster.review_state).toBe('rejected');
    expect(res.body.acceptances_revoked).toBe(0);
    expect(res.body.rules_deleted).toBe(0);
  });

  it('returns 409 when rejecting an already-rejected cluster', async () => {
    const sessionId = seed(h.db);
    const list = await request(h.app).get(`/api/sessions/${sessionId}/clusters`);
    const clusterId = list.body.clusters[0].id;
    await request(h.app)
      .post(`/api/sessions/${sessionId}/clusters/${clusterId}/reject`)
      .send({});
    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/clusters/${clusterId}/reject`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_rejected');
  });
});

describe('POST /api/sessions/:id/clusters/category-accept', () => {
  let h: Harness;
  beforeEach(async () => { h = await makeHarness(); });
  afterEach(async () => { await h.cleanup(); });

  function patchInShas(): void {
    h.db.exec(`
      UPDATE captures SET screenshot_sha256 = REPLACE(printf('%064d', CAST(SUBSTR(id, 4) AS INTEGER)), ' ', '0');
    `);
  }

  it('creates a category rule and fans out across matching clusters', async () => {
    const sessionId = seed(h.db);
    patchInShas();

    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/clusters/category-accept`)
      .send({ region_role: 'nav_primary', change_type: 'element_added', label: 'all nav-added' });
    expect(res.status).toBe(200);
    expect(res.body.rule.scope).toBe('category');
    expect(res.body.rule.category_region_role).toBe('nav_primary');
    expect(res.body.rule.category_change_type).toBe('element_added');
    expect(res.body.clusters_accepted).toBe(1); // only sigA matches
    expect(res.body.acceptances_created).toBe(2);
  });

  it('rejects malformed body', async () => {
    const sessionId = seed(h.db);
    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/clusters/category-accept`)
      .send({ region_role: 'nav_primary' }); // missing change_type
    expect(res.status).toBe(400);
  });

  it('DELETE revokes the category rule', async () => {
    const sessionId = seed(h.db);
    patchInShas();
    const create = await request(h.app)
      .post(`/api/sessions/${sessionId}/clusters/category-accept`)
      .send({ region_role: 'nav_primary', change_type: 'element_added' });
    const ruleId = create.body.rule.id;

    const del = await request(h.app)
      .delete(`/api/sessions/${sessionId}/clusters/category-accept/${ruleId}`);
    expect(del.status).toBe(200);
    expect(del.body.acceptances_revoked).toBe(2);
    expect(del.body.clusters_reopened).toBe(1);
  });

  it('DELETE returns 404 for an unknown rule id', async () => {
    const sessionId = seed(h.db);
    const res = await request(h.app)
      .delete(`/api/sessions/${sessionId}/clusters/category-accept/no-such-rule`);
    expect(res.status).toBe(404);
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

describe('POST /api/sessions/:id/clusters/:cluster_id/split', () => {
  let h: Harness;
  beforeEach(async () => { h = await makeHarness(); });
  afterEach(async () => { await h.cleanup(); });

  it('extracts one member into a brand-new cluster; source keeps its remaining member', async () => {
    const sessionId = seed(h.db);
    // sigA cluster has d1 (cmp1/p1) and d2 (cmp2/p2). Split d2 off.
    const list = await request(h.app).get(`/api/sessions/${sessionId}/clusters`);
    const sigACluster = list.body.clusters.find(
      (c: { signature: string }) => c.signature === 'sigA',
    );
    expect(sigACluster.member_count).toBe(2);

    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/clusters/${sigACluster.id}/split`)
      .send({ member_difference_ids: ['d2'] });
    expect(res.status).toBe(200);
    expect(res.body.source_cluster.id).toBe(sigACluster.id);
    expect(res.body.source_cluster.member_count).toBe(1);
    expect(res.body.new_cluster.member_count).toBe(1);
    expect(res.body.new_cluster.signature).toMatch(/^sigA:split:/);
    // Taxonomy carries over (the differences themselves are unchanged
    // except for the synthetic signature suffix).
    expect(res.body.new_cluster.region_role).toBe('nav_primary');
    expect(res.body.new_cluster.change_type).toBe('element_added');
    expect(res.body.new_cluster.review_state).toBe('open');
  });

  it('returns 409 when the selection covers every member of the cluster', async () => {
    const sessionId = seed(h.db);
    const list = await request(h.app).get(`/api/sessions/${sessionId}/clusters`);
    const sigACluster = list.body.clusters.find(
      (c: { signature: string }) => c.signature === 'sigA',
    );
    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/clusters/${sigACluster.id}/split`)
      .send({ member_difference_ids: ['d1', 'd2'] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('all_selected');
  });

  it('returns 409 when a selected member id is not part of the cluster', async () => {
    const sessionId = seed(h.db);
    const list = await request(h.app).get(`/api/sessions/${sessionId}/clusters`);
    const sigACluster = list.body.clusters.find(
      (c: { signature: string }) => c.signature === 'sigA',
    );
    // d3 belongs to sigB, not sigA.
    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/clusters/${sigACluster.id}/split`)
      .send({ member_difference_ids: ['d3'] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('foreign_member');
  });

  it('returns 404 for an unknown cluster id', async () => {
    const sessionId = seed(h.db);
    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/clusters/no-such/split`)
      .send({ member_difference_ids: ['d1'] });
    expect(res.status).toBe(404);
  });

  it('returns 400 for empty selection', async () => {
    const sessionId = seed(h.db);
    const list = await request(h.app).get(`/api/sessions/${sessionId}/clusters`);
    const sigACluster = list.body.clusters.find(
      (c: { signature: string }) => c.signature === 'sigA',
    );
    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/clusters/${sigACluster.id}/split`)
      .send({ member_difference_ids: [] });
    expect(res.status).toBe(400);
  });
});
