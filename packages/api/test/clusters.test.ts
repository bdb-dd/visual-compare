import { describe, expect, it, beforeEach } from 'vitest';
import { openDatabase, type Db } from '../src/db/client.js';
import { applySchema } from '../src/db/schema.js';
import {
  getCluster,
  listClusterMembers,
  listClusters,
  recomputeClusters,
} from '../src/services/clusters.js';

/**
 * Minimal fixture builder — inserts the required rows for a session with
 * one capture run, two url pairs, four comparisons, six differences across
 * three signatures. Keeps the test focused on cluster aggregation logic,
 * not on the rest of the pipeline.
 */
function seed(db: Db, opts: {
  sigA?: number;
  sigB?: number;
  sigC?: number;
} = {}): { sessionId: string } {
  const a = opts.sigA ?? 4; // 4 diffs in cluster A, hits 2 pairs
  const b = opts.sigB ?? 1; // 1 diff in cluster B, hits 1 pair
  const c = opts.sigC ?? 1; // 1 diff in cluster C, hits 1 pair

  const sessionId = 's1';
  const captureRunId = 'cr1';
  const jobId = 'j1';
  const comparisonRunId = 'cmpr1';
  const now = new Date().toISOString();

  db.exec(`
    INSERT INTO sessions (id, name, csv_filename, created_at)
      VALUES ('${sessionId}', 'test', 'test.csv', '${now}');
    INSERT INTO url_pairs (id, session_id, url_a, url_b, row_index, created_at)
      VALUES
        ('p1', '${sessionId}', 'https://a1', 'https://b1', 0, '${now}'),
        ('p2', '${sessionId}', 'https://a2', 'https://b2', 1, '${now}');
    INSERT INTO jobs (id, type, status, created_at)
      VALUES ('${jobId}', 'comparison', 'complete', '${now}');
    INSERT INTO capture_runs (id, session_id, job_id, options_json, created_at)
      VALUES ('${captureRunId}', '${sessionId}', '${jobId}', '{}', '${now}');
    INSERT INTO captures (id, capture_run_id, url_pair_id, side, url, status, viewport_name, screenshot_sha256, created_at)
      VALUES
        ('cap1', '${captureRunId}', 'p1', 'a', 'https://a1', 'complete', 'desktop', '${'a'.repeat(64)}', '${now}'),
        ('cap2', '${captureRunId}', 'p1', 'b', 'https://b1', 'complete', 'desktop', '${'b'.repeat(64)}', '${now}'),
        ('cap3', '${captureRunId}', 'p2', 'a', 'https://a2', 'complete', 'desktop', '${'c'.repeat(64)}', '${now}'),
        ('cap4', '${captureRunId}', 'p2', 'b', 'https://b2', 'complete', 'desktop', '${'d'.repeat(64)}', '${now}');
    INSERT INTO comparison_runs (id, session_id, capture_run_id, job_id, options_json, created_at)
      VALUES ('${comparisonRunId}', '${sessionId}', '${captureRunId}', '${jobId}', '{}', '${now}');
    INSERT INTO comparisons (id, comparison_run_id, url_pair_id, capture_a_id, capture_b_id, viewport_name, status, im_diff_sha256, ssim, changed_pixel_percentage, lm_diff_summary, lm_confidence, created_at)
      VALUES
        ('cmp1', '${comparisonRunId}', 'p1', 'cap1', 'cap2', 'desktop', 'complete', '${'e'.repeat(64)}', 0.92, 1.5, 'nav added', 0.81, '${now}'),
        ('cmp2', '${comparisonRunId}', 'p2', 'cap3', 'cap4', 'desktop', 'complete', '${'f'.repeat(64)}', 0.88, 2.3, NULL, NULL, '${now}');
  `);

  const insertDiff = db.prepare(
    `INSERT INTO differences
       (id, comparison_id, source, description, severity, bounding_box_json,
        change_type, region_role, element_label, signature, signature_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Cluster A: signature 'sigA-v1', spans both pairs (under v1 prompt).
  for (let i = 0; i < a; i += 1) {
    const cmp = i % 2 === 0 ? 'cmp1' : 'cmp2';
    insertDiff.run(
      `d-a-${i}`, cmp, 'lm',
      'sidebar added',
      i === 0 ? 'high' : 'medium',
      '{"x":0,"y":10,"width":25,"height":80}',
      'element_added', 'nav_primary', 'sidebar navigation',
      'sigA-v1', 'v1',
      now,
    );
  }
  // Cluster B: signature 'sigB-v1', single pair.
  for (let i = 0; i < b; i += 1) {
    insertDiff.run(
      `d-b-${i}`, 'cmp1', 'lm',
      'breadcrumb changed',
      'low',
      '{"x":50,"y":15,"width":40,"height":5}',
      'text_changed', 'nav_secondary', 'breadcrumbs',
      'sigB-v1', 'v1',
      now,
    );
  }
  // Cluster C: v0 fallback, imagick source.
  for (let i = 0; i < c; i += 1) {
    insertDiff.run(
      `d-c-${i}`, 'cmp2', 'imagick',
      'pixel region',
      null,
      '{"x":80,"y":90,"width":5,"height":5}',
      null, null, null,
      'sigC-v0', 'v0',
      now,
    );
  }

  return { sessionId };
}

let db: Db;
beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  applySchema(db);
});

describe('recomputeClusters', () => {
  it('groups differences by signature and counts members + pairs', () => {
    const { sessionId } = seed(db);
    const result = recomputeClusters(db, sessionId);

    expect(result.session_id).toBe(sessionId);
    expect(result.clusters_upserted).toBe(3);
    expect(result.clusters_removed).toBe(0);
    expect(result.members_indexed).toBe(6);

    const clusters = listClusters(db, sessionId);
    expect(clusters.length).toBe(3);

    const a = clusters.find((c) => c.signature === 'sigA-v1')!;
    expect(a.member_count).toBe(4);
    expect(a.pair_count).toBe(2); // touches both pairs
    expect(a.region_role).toBe('nav_primary');
    expect(a.element_label).toBe('sidebar navigation');

    const b = clusters.find((c) => c.signature === 'sigB-v1')!;
    expect(b.member_count).toBe(1);
    expect(b.pair_count).toBe(1);
    expect(b.signature_version).toBe('v1');

    const c = clusters.find((c) => c.signature === 'sigC-v0')!;
    expect(c.member_count).toBe(1);
    expect(c.pair_count).toBe(1);
    expect(c.signature_version).toBe('v0');
    expect(c.region_role).toBeNull();
  });

  it('is idempotent — second run produces the same end state', () => {
    const { sessionId } = seed(db);
    recomputeClusters(db, sessionId);
    const first = listClusters(db, sessionId).map((c) => ({
      sig: c.signature, mc: c.member_count, pc: c.pair_count,
    }));
    recomputeClusters(db, sessionId);
    const second = listClusters(db, sessionId).map((c) => ({
      sig: c.signature, mc: c.member_count, pc: c.pair_count,
    }));
    expect(second).toEqual(first);
  });

  it('removes clusters whose members all disappear', () => {
    const { sessionId } = seed(db);
    recomputeClusters(db, sessionId);
    expect(listClusters(db, sessionId).length).toBe(3);

    // Delete every diff in cluster B.
    db.exec(`DELETE FROM differences WHERE signature = 'sigB-v1'`);
    const result = recomputeClusters(db, sessionId);
    expect(result.clusters_removed).toBe(1);
    expect(listClusters(db, sessionId).length).toBe(2);
  });

  it('preserves review_state across rebuilds', () => {
    const { sessionId } = seed(db);
    recomputeClusters(db, sessionId);
    const clusterA = listClusters(db, sessionId).find((c) => c.signature === 'sigA-v1')!;
    db.prepare(
      `UPDATE difference_clusters SET review_state = 'accepted', reviewed_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), clusterA.id);

    // Add a new member to the same signature and recompute.
    db.prepare(
      `INSERT INTO differences
         (id, comparison_id, source, description, severity, bounding_box_json,
          change_type, region_role, element_label, signature, signature_version, created_at)
       VALUES ('d-a-extra', 'cmp1', 'lm', 'more sidebar', 'high', '{"x":0,"y":10,"width":25,"height":80}',
               'element_added', 'nav_primary', 'sidebar navigation', 'sigA-v1', 'v1', ?)`,
    ).run(new Date().toISOString());
    recomputeClusters(db, sessionId);

    const after = listClusters(db, sessionId).find((c) => c.signature === 'sigA-v1')!;
    expect(after.review_state).toBe('accepted');
    expect(after.member_count).toBe(5);
  });

  it('picks a deterministic representative — highest severity, then lex id', () => {
    const { sessionId } = seed(db);
    recomputeClusters(db, sessionId);
    // Cluster A's first member has severity=high; subsequent members are medium.
    // d-a-0 has severity=high and the lex-smallest id, so it's the representative.
    const a = listClusters(db, sessionId).find((c) => c.signature === 'sigA-v1')!;
    expect(a.representative_difference_id).toBe('d-a-0');
  });
});

describe('listClusters', () => {
  it('orders by pair_count desc', () => {
    const { sessionId } = seed(db);
    recomputeClusters(db, sessionId);
    const clusters = listClusters(db, sessionId);
    for (let i = 1; i < clusters.length; i += 1) {
      expect(clusters[i - 1]!.pair_count).toBeGreaterThanOrEqual(clusters[i]!.pair_count);
    }
  });

  it('filters by review_state when requested', () => {
    const { sessionId } = seed(db);
    recomputeClusters(db, sessionId);
    const all = listClusters(db, sessionId);
    expect(all.length).toBe(3);
    db.prepare(`UPDATE difference_clusters SET review_state = 'accepted' WHERE id = ?`)
      .run(all[0]!.id);
    expect(listClusters(db, sessionId, { reviewState: 'open' }).length).toBe(2);
    expect(listClusters(db, sessionId, { reviewState: 'accepted' }).length).toBe(1);
  });
});

describe('listClusterMembers', () => {
  it('returns members with their pair URLs', () => {
    const { sessionId } = seed(db);
    recomputeClusters(db, sessionId);
    const a = listClusters(db, sessionId).find((c) => c.signature === 'sigA-v1')!;
    const members = listClusterMembers(db, sessionId, a.id);
    expect(members.length).toBe(4);
    expect(new Set(members.map((m) => m.url_pair_id))).toEqual(new Set(['p1', 'p2']));
    for (const m of members) {
      expect(m.viewport_name).toBe('desktop');
      expect(m.url_a).toMatch(/^https:\/\/a/);
    }
  });

  it('carries each member\'s capture shas + comparison metrics', () => {
    const { sessionId } = seed(db);
    recomputeClusters(db, sessionId);
    const a = listClusters(db, sessionId).find((c) => c.signature === 'sigA-v1')!;
    const members = listClusterMembers(db, sessionId, a.id);
    // Every member belongs to either cmp1 (p1) or cmp2 (p2); shas are
    // populated for both pairs in the fixture.
    for (const m of members) {
      expect(m.capture_a_sha).toMatch(/^[a-f]{64}$/);
      expect(m.capture_b_sha).toMatch(/^[a-f]{64}$/);
      expect(m.im_diff_sha).toMatch(/^[a-f]{64}$/);
      expect(typeof m.ssim).toBe('number');
      expect(typeof m.changed_pct).toBe('number');
    }
    // cmp1 has lm_diff_summary populated; cmp2 leaves it null. Both should
    // pass through faithfully.
    const cmp1Member = members.find((m) => m.comparison_id === 'cmp1')!;
    const cmp2Member = members.find((m) => m.comparison_id === 'cmp2')!;
    expect(cmp1Member.lm_summary).toBe('nav added');
    expect(cmp1Member.lm_confidence).toBeCloseTo(0.81);
    expect(cmp2Member.lm_summary).toBeNull();
    expect(cmp2Member.lm_confidence).toBeNull();
  });

  it('respects the limit parameter', () => {
    const { sessionId } = seed(db, { sigA: 10 });
    recomputeClusters(db, sessionId);
    const a = listClusters(db, sessionId).find((c) => c.signature === 'sigA-v1')!;
    expect(listClusterMembers(db, sessionId, a.id, 3).length).toBe(3);
  });

  it('returns empty for an unknown cluster', () => {
    seed(db);
    expect(listClusterMembers(db, 's1', 'no-such-cluster').length).toBe(0);
  });
});

describe('getCluster', () => {
  it('returns null for unknown id', () => {
    seed(db);
    expect(getCluster(db, 's1', 'no-such-cluster')).toBeNull();
  });
});
