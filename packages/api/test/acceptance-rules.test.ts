import { describe, expect, it, beforeEach } from 'vitest';
import { openDatabase, type Db } from '../src/db/client.js';
import { applySchema } from '../src/db/schema.js';
import { recomputeClusters, listClusters } from '../src/services/clusters.js';
import {
  acceptCategory,
  acceptCluster,
  applySessionRules,
  ClusterRuleError,
  revokeCategory,
  revokeClusterAcceptance,
} from '../src/services/acceptance-rules.js';

/**
 * Tests for the Phase D cluster-rule fan-out. Uses the same in-memory seed
 * shape as clusters.test.ts but with image shas populated on the captures
 * (the rule fan-out requires them).
 */
function seed(db: Db): { sessionId: string; cluster: { id: string; signature: string } } {
  const now = new Date().toISOString();
  const aSha = 'a'.repeat(64);
  const bSha = 'b'.repeat(64);
  db.exec(`
    INSERT INTO sessions (id, name, csv_filename, created_at)
      VALUES ('s1', 'rule-test', 't.csv', '${now}');
    INSERT INTO url_pairs (id, session_id, url_a, url_b, row_index, created_at)
      VALUES
        ('p1', 's1', 'https://a1', 'https://b1', 0, '${now}'),
        ('p2', 's1', 'https://a2', 'https://b2', 1, '${now}');
    INSERT INTO jobs (id, type, status, created_at)
      VALUES ('j1', 'comparison', 'complete', '${now}');
    INSERT INTO capture_runs (id, session_id, job_id, options_json, created_at)
      VALUES ('cr1', 's1', 'j1', '{}', '${now}');
    INSERT INTO captures (id, capture_run_id, url_pair_id, side, url, status, screenshot_sha256, viewport_name, created_at)
      VALUES
        ('cap1', 'cr1', 'p1', 'a', 'https://a1', 'complete', '${aSha}', 'desktop', '${now}'),
        ('cap2', 'cr1', 'p1', 'b', 'https://b1', 'complete', '${bSha}', 'desktop', '${now}'),
        ('cap3', 'cr1', 'p2', 'a', 'https://a2', 'complete', '${aSha}', 'desktop', '${now}'),
        ('cap4', 'cr1', 'p2', 'b', 'https://b2', 'complete', '${bSha}', 'desktop', '${now}');
    INSERT INTO comparison_runs (id, session_id, capture_run_id, job_id, options_json, created_at)
      VALUES ('cmr1', 's1', 'cr1', 'j1', '{}', '${now}');
    INSERT INTO comparisons (id, comparison_run_id, url_pair_id, capture_a_id, capture_b_id, viewport_name, status, changed_pixel_percentage, ssim, matched_at_level, created_at)
      VALUES
        ('cmp1', 'cmr1', 'p1', 'cap1', 'cap2', 'desktop', 'complete', 5.2, 0.95, 'loose', '${now}'),
        ('cmp2', 'cmr1', 'p2', 'cap3', 'cap4', 'desktop', 'complete', 5.4, 0.94, 'loose', '${now}');
  `);
  const insertDiff = db.prepare(
    `INSERT INTO differences
       (id, comparison_id, source, description, severity, bounding_box_json,
        change_type, region_role, element_label, signature, signature_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Cluster on signature 'sigA' spans both pairs.
  insertDiff.run('d1', 'cmp1', 'lm', 'sidebar added', 'high',
    '{"x":0,"y":10,"width":25,"height":80}',
    'element_added', 'nav_primary', 'sidebar navigation', 'sigA', 'v1', now);
  insertDiff.run('d2', 'cmp2', 'lm', 'sidebar added', 'high',
    '{"x":0,"y":10,"width":25,"height":80}',
    'element_added', 'nav_primary', 'sidebar navigation', 'sigA', 'v1', now);
  // An unrelated diff on cmp1 — its bbox should be carried into the
  // acceptance snapshot when sigA's cluster is accepted (the snapshot is
  // the FULL comparison's regions, not just the cluster's bboxes).
  insertDiff.run('d3', 'cmp1', 'lm', 'breadcrumb changed', 'low',
    '{"x":50,"y":15,"width":40,"height":5}',
    'text_changed', 'nav_secondary', 'breadcrumbs', 'sigB', 'v1', now);

  recomputeClusters(db, 's1');
  const cluster = listClusters(db, 's1').find((c) => c.signature === 'sigA')!;
  return { sessionId: 's1', cluster: { id: cluster.id, signature: cluster.signature } };
}

let db: Db;
beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  applySchema(db);
});

describe('acceptCluster', () => {
  it('fans out into acceptances for every (pair, viewport) the cluster touches', () => {
    const { sessionId, cluster } = seed(db);
    const result = acceptCluster(db, sessionId, cluster.id, { notes: 'looks fine' });

    expect(result.acceptances_created).toBe(2);
    expect(result.acceptances_preserved).toBe(0);
    expect(result.cluster.review_state).toBe('accepted');
    expect(result.cluster.review_notes).toBe('looks fine');
    expect(result.rule.signature).toBe('sigA');
    expect(result.rule.scope).toBe('cluster');

    const acceptances = db
      .prepare(`SELECT * FROM acceptances WHERE session_id = ?`)
      .all(sessionId) as Array<{
        url_pair_id: string;
        viewport_name: string;
        accepted_level: string;
        accepted_pixel_pct: number | null;
        accepted_diff_regions_json: string;
        acceptance_rule_id: string | null;
        notes: string | null;
      }>;

    expect(acceptances).toHaveLength(2);
    for (const a of acceptances) {
      expect(a.viewport_name).toBe('desktop');
      expect(a.accepted_level).toBe('loose');
      expect(a.accepted_pixel_pct).toBeCloseTo(5.2, 0); // either 5.2 or 5.4
      expect(a.acceptance_rule_id).toBe(result.rule.id);
      expect(a.notes).toBe('looks fine');
    }

    // The acceptance snapshot is imagick-only — that's what
    // parseImagickRegions reads back at read time. The seed used only
    // LM-source differences, so both pairs end up with empty snapshots.
    // (When real comparisons run, the imagick CC pass populates these.)
    const p1 = acceptances.find((a) => a.url_pair_id === 'p1')!;
    expect(JSON.parse(p1.accepted_diff_regions_json)).toEqual([]);
    const p2 = acceptances.find((a) => a.url_pair_id === 'p2')!;
    expect(JSON.parse(p2.accepted_diff_regions_json)).toEqual([]);
  });

  it('snapshot includes imagick regions but excludes LM regions', () => {
    const { sessionId, cluster } = seed(db);
    // Inject an imagick CC on cmp1 so we can verify the filter.
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO differences
         (id, comparison_id, source, description, severity, bounding_box_json,
          change_type, region_role, element_label, signature, signature_version, created_at)
       VALUES ('im-cc-1', 'cmp1', 'imagick', 'Region of 5px (gray(0))', NULL,
               '{"x":40,"y":60,"width":2,"height":2}',
               NULL, NULL, NULL, 'sigZ', 'v0', ?)`,
    ).run(now);

    acceptCluster(db, sessionId, cluster.id);
    const p1 = db.prepare(
      `SELECT accepted_diff_regions_json FROM acceptances WHERE url_pair_id = ?`,
    ).get('p1') as { accepted_diff_regions_json: string };
    const regions = JSON.parse(p1.accepted_diff_regions_json);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toEqual({ x: 40, y: 60, width: 2, height: 2 });
  });

  it('preserves a pre-existing manual acceptance (DO NOTHING on conflict)', () => {
    const { sessionId, cluster } = seed(db);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO acceptances
         (id, session_id, url_pair_id, viewport_name, accepted_level,
          accepted_pixel_pct, accepted_ssim, accepted_diff_regions_json,
          accepted_capture_a_sha, accepted_capture_b_sha, accept_any,
          label, notes, created_at, updated_at)
       VALUES ('manual-1', ?, 'p1', 'desktop', 'tolerant', 4.0, 0.99, '[]',
               ?, ?, 0, 'manual', 'set by user', ?, ?)`,
    ).run(sessionId, 'a'.repeat(64), 'b'.repeat(64), now, now);

    const result = acceptCluster(db, sessionId, cluster.id);
    expect(result.acceptances_created).toBe(1);  // only p2
    expect(result.acceptances_preserved).toBe(1); // p1 was untouched

    const p1 = db
      .prepare<[string, string], { id: string; notes: string | null; acceptance_rule_id: string | null }>(
        `SELECT id, notes, acceptance_rule_id FROM acceptances
          WHERE session_id = ? AND url_pair_id = ?`,
      )
      .get(sessionId, 'p1')!;
    expect(p1.id).toBe('manual-1');
    expect(p1.notes).toBe('set by user');
    expect(p1.acceptance_rule_id).toBeNull();
  });

  it('throws not_found for an unknown cluster id', () => {
    seed(db);
    expect(() => acceptCluster(db, 's1', 'no-such-cluster'))
      .toThrow(ClusterRuleError);
  });

  it('throws already_accepted on a second accept', () => {
    const { sessionId, cluster } = seed(db);
    acceptCluster(db, sessionId, cluster.id);
    expect(() => acceptCluster(db, sessionId, cluster.id))
      .toThrowError(/already_accepted|already accepted/i);
  });

  it('defaults the rule label to the cluster element_label when not overridden', () => {
    const { sessionId, cluster } = seed(db);
    const result = acceptCluster(db, sessionId, cluster.id);
    expect(result.rule.label).toBe('sidebar navigation');
  });
});

describe('revokeClusterAcceptance', () => {
  it('deletes only rule-owned acceptances; leaves manual acceptances alone', () => {
    const { sessionId, cluster } = seed(db);
    // Plant a manual acceptance on p1 first.
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO acceptances
         (id, session_id, url_pair_id, viewport_name, accepted_level,
          accepted_pixel_pct, accepted_ssim, accepted_diff_regions_json,
          accepted_capture_a_sha, accepted_capture_b_sha, accept_any,
          label, notes, created_at, updated_at)
       VALUES ('manual-1', ?, 'p1', 'desktop', 'tolerant', 4.0, 0.99, '[]',
               ?, ?, 0, 'manual', 'set by user', ?, ?)`,
    ).run(sessionId, 'a'.repeat(64), 'b'.repeat(64), now, now);

    acceptCluster(db, sessionId, cluster.id);
    // Now: p1 = manual (preserved), p2 = rule-created. Revoke.
    const result = revokeClusterAcceptance(db, sessionId, cluster.id);
    expect(result.acceptances_revoked).toBe(1); // only p2
    expect(result.rules_deleted).toBe(1);
    expect(result.cluster.review_state).toBe('rejected');

    const remaining = db.prepare(
      `SELECT id FROM acceptances WHERE session_id = ?`,
    ).all(sessionId) as Array<{ id: string }>;
    expect(remaining.map((r) => r.id)).toEqual(['manual-1']);
  });

  it('throws not_accepted when the cluster is not in accepted state', () => {
    const { sessionId, cluster } = seed(db);
    expect(() => revokeClusterAcceptance(db, sessionId, cluster.id))
      .toThrowError(/not_accepted|not in 'accepted'/i);
  });

  it('throws not_found for unknown cluster id', () => {
    seed(db);
    expect(() => revokeClusterAcceptance(db, 's1', 'no-such-cluster'))
      .toThrow(ClusterRuleError);
  });

  it('lets a rejected cluster be re-accepted (fresh rule, fresh fan-out)', () => {
    const { sessionId, cluster } = seed(db);
    const first = acceptCluster(db, sessionId, cluster.id);
    revokeClusterAcceptance(db, sessionId, cluster.id);
    const second = acceptCluster(db, sessionId, cluster.id);
    expect(second.rule.id).not.toBe(first.rule.id);
    expect(second.acceptances_created).toBe(2);
    expect(second.cluster.review_state).toBe('accepted');
  });
});

describe('acceptCategory', () => {
  // Extended seed that adds a SECOND cluster sharing the same
  // (region_role, change_type) as the sidebar one, plus a cluster with
  // different tags that must NOT match the category rule.
  function seedCategory(db: Db): { sessionId: string } {
    const { sessionId } = seed(db);
    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO url_pairs (id, session_id, url_a, url_b, row_index, created_at)
        VALUES ('p3', '${sessionId}', 'https://a3', 'https://b3', 2, '${now}');
      INSERT INTO captures (id, capture_run_id, url_pair_id, side, url, status, screenshot_sha256, viewport_name, created_at)
        VALUES
          ('cap5', 'cr1', 'p3', 'a', 'https://a3', 'complete', '${'a'.repeat(64)}', 'desktop', '${now}'),
          ('cap6', 'cr1', 'p3', 'b', 'https://b3', 'complete', '${'b'.repeat(64)}', 'desktop', '${now}');
      INSERT INTO comparisons (id, comparison_run_id, url_pair_id, capture_a_id, capture_b_id, viewport_name, status, changed_pixel_percentage, ssim, matched_at_level, created_at)
        VALUES ('cmp3', 'cmr1', 'p3', 'cap5', 'cap6', 'desktop', 'complete', 6.0, 0.93, 'loose', '${now}');
    `);
    const insertDiff = db.prepare(
      `INSERT INTO differences
         (id, comparison_id, source, description, severity, bounding_box_json,
          change_type, region_role, element_label, signature, signature_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Second sidebar-nav cluster — same (region_role, change_type) but
    // different element_label → different signature.
    insertDiff.run('d4', 'cmp3', 'lm', 'top nav added', 'high',
      '{"x":0,"y":0,"width":100,"height":10}',
      'element_added', 'nav_primary', 'top navigation',
      'sigC', 'v1', now);
    // Unrelated cluster — different (region_role, change_type), must NOT
    // be touched by the sidebar category rule.
    insertDiff.run('d5', 'cmp3', 'lm', 'footer text', 'low',
      '{"x":0,"y":95,"width":100,"height":5}',
      'text_changed', 'footer', 'footer',
      'sigD', 'v1', now);
    recomputeClusters(db, sessionId);
    return { sessionId };
  }

  it('accepts all clusters in (region_role, change_type) and fans out across them', () => {
    const { sessionId } = seedCategory(db);
    const result = acceptCategory(db, sessionId, {
      region_role: 'nav_primary',
      change_type: 'element_added',
      label: 'all nav-added',
    });
    expect(result.clusters_accepted).toBe(2);  // sigA + sigC
    expect(result.acceptances_created).toBe(3); // p1 + p2 (sigA) + p3 (sigC)

    // Both nav_primary clusters are 'accepted' now.
    const clusters = listClusters(db, sessionId);
    const nav = clusters.filter((c) => c.region_role === 'nav_primary');
    expect(nav.every((c) => c.review_state === 'accepted')).toBe(true);

    // The footer (unrelated) cluster is still 'open'.
    const footer = clusters.find((c) => c.region_role === 'footer')!;
    expect(footer.review_state).toBe('open');

    // Acceptances are tagged with the rule id.
    const tagged = db.prepare(
      `SELECT COUNT(*) AS c FROM acceptances WHERE acceptance_rule_id = ?`,
    ).get(result.rule.id) as { c: number };
    expect(tagged.c).toBe(3);
  });

  it('skips clusters that already have an existing cluster rule', () => {
    const { sessionId } = seedCategory(db);
    const clusters = listClusters(db, sessionId);
    const sigA = clusters.find((c) => c.signature === 'sigA')!;
    acceptCluster(db, sessionId, sigA.id);

    const result = acceptCategory(db, sessionId, {
      region_role: 'nav_primary',
      change_type: 'element_added',
    });
    expect(result.clusters_skipped_already_accepted).toBe(1);
    expect(result.clusters_accepted).toBe(1); // only sigC was newly accepted
  });

  it('preserves manual acceptances and counts them as preserved', () => {
    const { sessionId } = seedCategory(db);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO acceptances
         (id, session_id, url_pair_id, viewport_name, accepted_level,
          accepted_pixel_pct, accepted_ssim, accepted_diff_regions_json,
          accepted_capture_a_sha, accepted_capture_b_sha, accept_any,
          label, notes, created_at, updated_at)
       VALUES ('manual-1', ?, 'p1', 'desktop', 'tolerant', 4.0, 0.99, '[]',
               ?, ?, 0, 'manual', 'set by user', ?, ?)`,
    ).run(sessionId, 'a'.repeat(64), 'b'.repeat(64), now, now);

    const result = acceptCategory(db, sessionId, {
      region_role: 'nav_primary',
      change_type: 'element_added',
    });
    expect(result.acceptances_preserved).toBeGreaterThanOrEqual(1);

    const p1 = db.prepare(
      `SELECT acceptance_rule_id, label FROM acceptances WHERE id = 'manual-1'`,
    ).get() as { acceptance_rule_id: string | null; label: string };
    expect(p1.acceptance_rule_id).toBeNull();
    expect(p1.label).toBe('manual');
  });
});

describe('revokeCategory', () => {
  function seedCategoryFor(db: Db): { sessionId: string } {
    const { sessionId } = seed(db);
    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO url_pairs (id, session_id, url_a, url_b, row_index, created_at)
        VALUES ('p3', '${sessionId}', 'https://a3', 'https://b3', 2, '${now}');
      INSERT INTO captures (id, capture_run_id, url_pair_id, side, url, status, screenshot_sha256, viewport_name, created_at)
        VALUES
          ('cap5', 'cr1', 'p3', 'a', 'https://a3', 'complete', '${'a'.repeat(64)}', 'desktop', '${now}'),
          ('cap6', 'cr1', 'p3', 'b', 'https://b3', 'complete', '${'b'.repeat(64)}', 'desktop', '${now}');
      INSERT INTO comparisons (id, comparison_run_id, url_pair_id, capture_a_id, capture_b_id, viewport_name, status, changed_pixel_percentage, ssim, matched_at_level, created_at)
        VALUES ('cmp3', 'cmr1', 'p3', 'cap5', 'cap6', 'desktop', 'complete', 6.0, 0.93, 'loose', '${now}');
    `);
    const insertDiff = db.prepare(
      `INSERT INTO differences (id, comparison_id, source, description, severity,
         bounding_box_json, change_type, region_role, element_label,
         signature, signature_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertDiff.run('d4', 'cmp3', 'lm', 'top nav added', 'high',
      '{"x":0,"y":0,"width":100,"height":10}',
      'element_added', 'nav_primary', 'top navigation',
      'sigC', 'v1', now);
    recomputeClusters(db, sessionId);
    return { sessionId };
  }

  it('deletes rule-owned acceptances and reopens clusters that lost all rule coverage', () => {
    const { sessionId } = seedCategoryFor(db);
    const accept = acceptCategory(db, sessionId, {
      region_role: 'nav_primary',
      change_type: 'element_added',
    });
    expect(listClusters(db, sessionId).filter((c) => c.region_role === 'nav_primary').every((c) => c.review_state === 'accepted')).toBe(true);

    const result = revokeCategory(db, sessionId, accept.rule.id);
    expect(result.acceptances_revoked).toBe(3);
    expect(result.clusters_reopened).toBe(2);

    const nav = listClusters(db, sessionId).filter((c) => c.region_role === 'nav_primary');
    expect(nav.every((c) => c.review_state === 'open')).toBe(true);

    // Rule row is gone.
    const rule = db.prepare(`SELECT id FROM acceptance_rules WHERE id = ?`)
      .get(accept.rule.id);
    expect(rule).toBeUndefined();
  });

  it('keeps clusters accepted when a surviving cluster-rule still covers them', () => {
    const { sessionId } = seedCategoryFor(db);
    const sigA = listClusters(db, sessionId).find((c) => c.signature === 'sigA')!;
    acceptCluster(db, sessionId, sigA.id);

    const category = acceptCategory(db, sessionId, {
      region_role: 'nav_primary',
      change_type: 'element_added',
    });
    // category rule didn't touch sigA (already accepted), but did touch sigC.

    revokeCategory(db, sessionId, category.rule.id);
    // sigA stays accepted because its own cluster rule is still there.
    const after = listClusters(db, sessionId).find((c) => c.signature === 'sigA')!;
    expect(after.review_state).toBe('accepted');
    // sigC re-opens.
    const afterC = listClusters(db, sessionId).find((c) => c.signature === 'sigC')!;
    expect(afterC.review_state).toBe('open');
  });

  it('throws not_found for an unknown rule id', () => {
    seed(db);
    expect(() => revokeCategory(db, 's1', 'no-such-rule')).toThrow(ClusterRuleError);
  });
});

describe('applySessionRules', () => {
  it('no-ops when the session has no rules', () => {
    const { sessionId } = seed(db);
    const result = applySessionRules(db, sessionId);
    expect(result.rules_processed).toBe(0);
    expect(result.acceptances_created).toBe(0);
  });

  it('re-applies a rule to a newly-landed cluster (decisions persist across runs)', () => {
    const { sessionId, cluster } = seed(db);
    acceptCluster(db, sessionId, cluster.id);
    // Simulate "new evaluation" — same signature lands on a new url_pair.
    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO url_pairs (id, session_id, url_a, url_b, row_index, created_at)
        VALUES ('p-new', '${sessionId}', 'https://a-new', 'https://b-new', 99, '${now}');
      INSERT INTO captures (id, capture_run_id, url_pair_id, side, url, status, screenshot_sha256, viewport_name, created_at)
        VALUES
          ('cap-new-a', 'cr1', 'p-new', 'a', 'https://a-new', 'complete', '${'c'.repeat(64)}', 'desktop', '${now}'),
          ('cap-new-b', 'cr1', 'p-new', 'b', 'https://b-new', 'complete', '${'d'.repeat(64)}', 'desktop', '${now}');
      INSERT INTO comparisons (id, comparison_run_id, url_pair_id, capture_a_id, capture_b_id, viewport_name, status, changed_pixel_percentage, ssim, matched_at_level, created_at)
        VALUES ('cmp-new', 'cmr1', 'p-new', 'cap-new-a', 'cap-new-b', 'desktop', 'complete', 5.5, 0.92, 'loose', '${now}');
    `);
    db.prepare(
      `INSERT INTO differences (id, comparison_id, source, description, severity,
         bounding_box_json, change_type, region_role, element_label,
         signature, signature_version, created_at)
       VALUES ('d-new', 'cmp-new', 'lm', 'sidebar added', 'high',
               '{"x":0,"y":10,"width":25,"height":80}',
               'element_added', 'nav_primary', 'sidebar navigation',
               'sigA', 'v1', ?)`,
    ).run(now);
    recomputeClusters(db, sessionId);

    const before = db.prepare(
      `SELECT COUNT(*) AS c FROM acceptances WHERE session_id = ?`,
    ).get(sessionId) as { c: number };
    const result = applySessionRules(db, sessionId);
    const after = db.prepare(
      `SELECT COUNT(*) AS c FROM acceptances WHERE session_id = ?`,
    ).get(sessionId) as { c: number };

    expect(result.acceptances_created).toBe(1);
    expect(after.c).toBe(before.c + 1);
  });

  it('is idempotent — a second pass adds nothing', () => {
    const { sessionId, cluster } = seed(db);
    acceptCluster(db, sessionId, cluster.id);
    applySessionRules(db, sessionId);
    const second = applySessionRules(db, sessionId);
    expect(second.acceptances_created).toBe(0);
  });
});
