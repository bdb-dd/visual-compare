import { describe, expect, it, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from '../src/db/client.js';
import { applySchema } from '../src/db/schema.js';
import { readSessionResults } from '../src/services/evaluator.js';
import type { EvaluationConfig } from '../src/services/evaluator.js';
import type { CaptureRunOptionsParsed } from '../src/services/capture.js';
import { captureOptsHashFor } from '../src/services/capture-opts-hash.js';

/**
 * Phase ε regression tests: SessionResultRow must surface
 * acceptance_rule_id / acceptance_rule_scope (when the acceptance came
 * from a cluster or category rule fan-out) and cluster_id /
 * cluster_review_state (the row's primary v1 cluster, if any).
 */

const desktop = {
  name: 'desktop',
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  orientation: 'landscape' as const,
};

const baseConfig: EvaluationConfig = {
  viewports: [desktop],
  target_level: 'tolerant',
  invoke_lm: false,
  region_match_config: {
    growth_margin_pct: 0.5,
    displacement_tolerance_pct: 1,
    pixel_pct_delta: 0.5,
  },
  capture_options: {
    viewports: [desktop],
    concurrency: 4,
  } as unknown as CaptureRunOptionsParsed,
  url_pair_ids: null,
  filter_query: {},
  lm_prompt_ids: {},
  lm_model_id: 'stub-model',
  lm_include_diff_image: true,
};

function seed(
  db: Db,
  opts: { withCluster?: boolean; withRule?: boolean } = {},
): { sessionId: string; pairId: string; clusterId: string | null; ruleId: string | null } {
  const sessionId = 's1';
  const pairId = 'p1';
  const captureRunId = 'cr1';
  const jobId = 'j1';
  const comparisonRunId = 'cmpr1';
  const comparisonId = 'cmp1';
  const captureASha = 'a'.repeat(64);
  const captureBSha = 'b'.repeat(64);
  // Hash needs to match what readSessionResults computes from
  // baseConfig.capture_options for the same viewport — otherwise the
  // capture_cache lookup misses and the row stays pending with no
  // comparison_id (and thus no cluster).
  const captureOptsHash = captureOptsHashFor(desktop, baseConfig.capture_options);
  const now = new Date().toISOString();

  db.exec(`
    INSERT INTO sessions (id, name, csv_filename, created_at)
      VALUES ('${sessionId}', 'test', 'test.csv', '${now}');
    INSERT INTO url_pairs (id, session_id, url_a, url_b, row_index, created_at)
      VALUES ('${pairId}', '${sessionId}', 'https://a1', 'https://b1', 0, '${now}');
    INSERT INTO jobs (id, type, status, created_at)
      VALUES ('${jobId}', 'comparison', 'complete', '${now}');
    INSERT INTO capture_runs (id, session_id, job_id, options_json, created_at)
      VALUES ('${captureRunId}', '${sessionId}', '${jobId}', '{}', '${now}');
    INSERT INTO captures (id, capture_run_id, url_pair_id, side, url, status, screenshot_sha256, viewport_name, created_at)
      VALUES
        ('cap1', '${captureRunId}', '${pairId}', 'a', 'https://a1', 'complete', '${captureASha}', 'desktop', '${now}'),
        ('cap2', '${captureRunId}', '${pairId}', 'b', 'https://b1', 'complete', '${captureBSha}', 'desktop', '${now}');
    INSERT INTO capture_cache (url, viewport_name, capture_opts_hash, screenshot_sha256, capture_id, created_at)
      VALUES
        ('https://a1', 'desktop', '${captureOptsHash}', '${captureASha}', 'cap1', '${now}'),
        ('https://b1', 'desktop', '${captureOptsHash}', '${captureBSha}', 'cap2', '${now}');
    INSERT INTO comparison_runs (id, session_id, capture_run_id, job_id, options_json, created_at)
      VALUES ('${comparisonRunId}', '${sessionId}', '${captureRunId}', '${jobId}', '{}', '${now}');
    INSERT INTO comparisons (id, comparison_run_id, url_pair_id, capture_a_id, capture_b_id, viewport_name, status, changed_pixel_percentage, ssim, matched_at_level, created_at)
      VALUES ('${comparisonId}', '${comparisonRunId}', '${pairId}', 'cap1', 'cap2', 'desktop', 'complete', 2.0, 0.95, 'tolerant', '${now}');
    INSERT INTO pixel_compare_cache (capture_a_sha, capture_b_sha, pipeline_version, changed_pct, ssim, bbox_area_pct, component_count, im_diff_sha256, comparison_id, created_at)
      VALUES ('${captureASha}', '${captureBSha}', 'v3-tolerant', 2.0, 0.95, 0.0, 0, NULL, '${comparisonId}', '${now}');
  `);

  let clusterId: string | null = null;
  let ruleId: string | null = null;

  if (opts.withCluster) {
    // A v1 difference + matching cluster — picked up by the
    // primaryClusterByComparisonId lookup.
    db.prepare(
      `INSERT INTO differences
         (id, comparison_id, source, description, severity, bounding_box_json,
          change_type, region_role, element_label, signature, signature_version, created_at)
       VALUES (?, ?, 'lm', 'sidebar added', 'high',
               '{"x":0,"y":10,"width":25,"height":80}',
               'element_added', 'nav_primary', 'sidebar navigation',
               'sig-A', 'v1', ?)`,
    ).run('d-1', comparisonId, now);
    clusterId = randomUUID();
    db.prepare(
      `INSERT INTO difference_clusters
         (id, session_id, signature, signature_version, viewport_name,
          region_role, change_type, element_label,
          representative_difference_id, member_count, pair_count,
          review_state, review_notes, reviewed_at, created_at, updated_at)
       VALUES (?, ?, 'sig-A', 'v1', 'desktop',
               'nav_primary', 'element_added', 'sidebar navigation',
               'd-1', 1, 1, 'open', NULL, NULL, ?, ?)`,
    ).run(clusterId, sessionId, now, now);
  }

  if (opts.withRule) {
    // A cluster rule + an acceptance fanned out from it.
    ruleId = randomUUID();
    db.prepare(
      `INSERT INTO acceptance_rules
         (id, session_id, signature, signature_version, scope,
          category_region_role, category_change_type,
          label, notes, created_by, created_at, updated_at)
       VALUES (?, ?, 'sig-A', 'v1', 'cluster',
               NULL, NULL,
               'sidebar navigation', NULL, NULL, ?, ?)`,
    ).run(ruleId, sessionId, now, now);
    db.prepare(
      `INSERT INTO acceptances
         (id, session_id, url_pair_id, viewport_name, accepted_level,
          accepted_pixel_pct, accepted_ssim, accepted_diff_regions_json,
          accepted_capture_a_sha, accepted_capture_b_sha, accept_any,
          label, notes, acceptance_rule_id, created_at, updated_at)
       VALUES (?, ?, ?, 'desktop', 'tolerant',
               2.0, 0.95, '[]',
               ?, ?, 0,
               'sidebar navigation', NULL, ?, ?, ?)`,
    ).run(
      randomUUID(), sessionId, pairId,
      captureASha, captureBSha,
      ruleId, now, now,
    );
  }

  return { sessionId, pairId, clusterId, ruleId };
}

let db: Db;
beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  applySchema(db);
});

describe('readSessionResults — Phase ε row provenance', () => {
  it('row without any cluster or rule has all provenance fields null', () => {
    const { sessionId } = seed(db, {});
    const rows = readSessionResults(db, sessionId, baseConfig);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.cluster_id).toBeNull();
    expect(r.cluster_review_state).toBeNull();
    expect(r.acceptance_rule_id).toBeNull();
    expect(r.acceptance_rule_scope).toBeNull();
  });

  it('row whose comparison participates in a v1 cluster surfaces cluster_id + state', () => {
    const { sessionId, clusterId } = seed(db, { withCluster: true });
    const rows = readSessionResults(db, sessionId, baseConfig);
    const r = rows[0]!;
    expect(r.cluster_id).toBe(clusterId);
    expect(r.cluster_review_state).toBe('open');
  });

  it('row accepted via a cluster rule fan-out surfaces acceptance_rule_id + scope', () => {
    const { sessionId, ruleId } = seed(db, { withCluster: true, withRule: true });
    const rows = readSessionResults(db, sessionId, baseConfig);
    const r = rows[0]!;
    expect(r.acceptance_rule_id).toBe(ruleId);
    expect(r.acceptance_rule_scope).toBe('cluster');
  });

  it('row with v1 cluster + rule populates all four provenance fields', () => {
    const { sessionId, clusterId, ruleId } = seed(db, { withCluster: true, withRule: true });
    const rows = readSessionResults(db, sessionId, baseConfig);
    const r = rows[0]!;
    expect(r.cluster_id).toBe(clusterId);
    expect(r.cluster_review_state).toBe('open');
    expect(r.acceptance_rule_id).toBe(ruleId);
    expect(r.acceptance_rule_scope).toBe('cluster');
  });
});
