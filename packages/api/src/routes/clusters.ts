import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  getCluster,
  listClusterMembers,
  listClusters,
  recomputeClusters,
  splitCluster,
  SplitClusterError,
} from '../services/clusters.js';
import {
  acceptCategory,
  acceptCluster,
  applySessionRules,
  ClusterRuleError,
  revokeCategory,
  rejectCluster,
} from '../services/acceptance-rules.js';
import { getSessionConfig } from '../services/sessions.js';
import { captureOptsHashFor } from '../services/capture-opts-hash.js';
import { captureRunOptionsSchema, type CaptureRunOptionsParsed } from '../services/capture.js';
import type { SessionConfig } from '../types.js';
import type {
  ClusterDetailDto,
  ClusterListDto,
  ClusterMemberDto,
  ClusterRepresentativeDto,
  ClusterReviewState,
  ClusterSummaryDto,
  DifferenceClusterRow,
  PairOutcome,
} from '../types.js';

/**
 * Read-only cluster review API. Mounted as a sub-router on
 * `/api/sessions/:id/clusters` so the parent session id is in `req.params.id`.
 *
 * Phase A surface — no mutation endpoints. Acceptance rule creation, cluster
 * splitting, and bulk-accept land in Phase D once v1 signatures are live and
 * trusted.
 */

export function clustersRouter(db: Db): Router {
  const router = Router({ mergeParams: true });

  // List clusters for a session.
  // Query params:
  //   review_state — optional filter (open / accepted / rejected / split / anomaly)
  //   recompute    — '1' to rebuild the index before responding. Useful for
  //                  manual refresh during development; remove if abused.
  router.get('/', (req, res) => {
    const sessionId = (req.params as { id?: string }).id;
    if (!sessionId) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    if (req.query.recompute === '1') {
      recomputeClusters(db, sessionId);
      // After a structural rebuild, re-apply standing rules so any new
      // clusters that match an existing rule get their fan-out acceptances.
      applySessionRules(db, sessionId);
    }

    const filter = parseReviewState(req.query.review_state);
    if (filter === 'invalid') {
      res.status(400).json({ error: 'invalid_review_state' });
      return;
    }

    const clusters = listClusters(db, sessionId, filter ? { reviewState: filter } : {});
    // Build state distribution without filter, so the UI can render the tab
    // strip independently of the current filter.
    const distribution = stateDistribution(db, sessionId);
    const total = Object.values(distribution).reduce((acc, n) => acc + n, 0);

    // Synthetic outcome-bucket clusters surface missing-page + capture-
    // failed comparisons as cluster-like entries so the Outcome filter has
    // something to bite on in clusters mode. These are derived per
    // request, never persisted in `difference_clusters`. They're treated
    // as `review_state = 'open'` for now (no acceptance flow yet), so
    // the `accepted` / `rejected` review-state filters skip them.
    const synthetic = filter && filter !== 'open'
      ? []
      : synthesizeOutcomeClusters(db, sessionId);

    const dto: ClusterListDto = {
      session_id: sessionId,
      total,
      by_review_state: distribution,
      clusters: [...clusters.map((c) => withSample(db, c)), ...synthetic],
    };
    res.json(dto);
  });

  // Cluster detail with member URLs.
  router.get('/:cluster_id', (req, res) => {
    const sessionId = (req.params as { id?: string }).id;
    const clusterId = (req.params as { cluster_id?: string }).cluster_id;
    if (!sessionId || !clusterId) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    // Synthetic outcome-bucket clusters never hit difference_clusters —
    // their id is parseable (`outcome:<viewport>:<bucket>`) and they're
    // rebuilt from comparisons on the fly.
    if (clusterId.startsWith('outcome:')) {
      const synth = buildOutcomeClusterDetail(db, sessionId, clusterId);
      if (!synth) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json(synth);
      return;
    }
    const cluster = getCluster(db, sessionId, clusterId);
    if (!cluster) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const limit = parsePositiveInt(req.query.limit, 50, 500);
    const members = listClusterMembers(db, sessionId, clusterId, limit);

    const memberDtos: ClusterMemberDto[] = members.map((m): ClusterMemberDto => ({
      difference_id: m.difference_id,
      comparison_id: m.comparison_id,
      url_pair_id: m.url_pair_id,
      viewport_name: m.viewport_name,
      url_a: m.url_a,
      url_b: m.url_b,
      description: m.description,
      severity: m.severity,
      bounding_box: parseBbox(m.bounding_box_json),
      capture_a_sha: m.capture_a_sha,
      capture_b_sha: m.capture_b_sha,
      im_diff_sha: m.im_diff_sha,
      ssim: m.ssim,
      changed_pct: m.changed_pct,
      lm_summary: m.lm_summary,
      lm_confidence: m.lm_confidence,
    }));
    // Prefer the representative entry from the member list when present —
    // keeps the two views in sync without a second SQL round-trip. Falls back
    // to a dedicated lookup if the rep wasn't returned (e.g. clipped by limit).
    const dto: ClusterDetailDto = {
      cluster,
      representative:
        memberDtos.find((m) => m.difference_id === cluster.representative_difference_id) ??
        representativeFor(db, cluster),
      members: memberDtos,
    };
    res.json(dto);
  });

  // Phase D — cluster Accept / Reject. Mutation endpoints fan out into
  // per-row acceptances via services/acceptance-rules.ts. Idempotency is
  // service-enforced: accepting an already-accepted cluster returns 409,
  // rejecting an open one likewise. Body validation is permissive — both
  // label and notes are optional free-text fields.
  const acceptBodySchema = z.object({
    label: z.string().max(120).optional(),
    notes: z.string().max(2000).optional(),
    created_by: z.string().max(120).optional(),
  }).strict();
  router.post('/:cluster_id/accept', (req, res) => {
    const sessionId = (req.params as { id?: string }).id;
    const clusterId = (req.params as { cluster_id?: string }).cluster_id;
    if (!sessionId || !clusterId) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    if (clusterId.startsWith('outcome:')) {
      res.status(409).json({
        error: 'synthetic_cluster',
        message: 'Outcome buckets are read-only — accept individual rows from the Rows view.',
      });
      return;
    }
    const body = acceptBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
      return;
    }
    try {
      const result = acceptCluster(db, sessionId, clusterId, {
        label: body.data.label,
        notes: body.data.notes,
        createdBy: body.data.created_by,
      });
      res.status(200).json({
        cluster: result.cluster,
        rule: result.rule,
        acceptances_created: result.acceptances_created,
        acceptances_preserved: result.acceptances_preserved,
      });
    } catch (err) {
      if (err instanceof ClusterRuleError) {
        const status = err.code === 'not_found' ? 404 : 409;
        res.status(status).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  const rejectBodySchema = z.object({
    notes: z.string().max(2000).optional(),
  }).strict();
  router.post('/:cluster_id/reject', (req, res) => {
    const sessionId = (req.params as { id?: string }).id;
    const clusterId = (req.params as { cluster_id?: string }).cluster_id;
    if (!sessionId || !clusterId) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    if (clusterId.startsWith('outcome:')) {
      res.status(409).json({
        error: 'synthetic_cluster',
        message: 'Outcome buckets are read-only — handle individual rows from the Rows view.',
      });
      return;
    }
    const body = rejectBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
      return;
    }
    try {
      const result = rejectCluster(db, sessionId, clusterId, {
        notes: body.data.notes,
      });
      res.status(200).json({
        cluster: result.cluster,
        acceptances_revoked: result.acceptances_revoked,
        rules_deleted: result.rules_deleted,
      });
    } catch (err) {
      if (err instanceof ClusterRuleError) {
        const status = err.code === 'not_found' ? 404 : 409;
        res.status(status).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  // Split a cluster: extract some members into a brand-new cluster.
  // Implemented by rewriting the selected differences' signature to a
  // synthetic suffix, then recomputing. See services/clusters.ts:
  // splitCluster for the full state-machine notes.
  const splitBodySchema = z
    .object({
      member_difference_ids: z.array(z.string().min(1)).min(1),
    })
    .strict();
  router.post('/:cluster_id/split', (req, res) => {
    const sessionId = (req.params as { id?: string }).id;
    const clusterId = (req.params as { cluster_id?: string }).cluster_id;
    if (!sessionId || !clusterId) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    if (clusterId.startsWith('outcome:')) {
      res.status(409).json({
        error: 'synthetic_cluster',
        message: 'Outcome buckets cannot be split.',
      });
      return;
    }
    const body = splitBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
      return;
    }
    try {
      const result = splitCluster(db, sessionId, clusterId, body.data.member_difference_ids);
      res.status(200).json({
        source_cluster: result.source_cluster,
        new_cluster: result.new_cluster,
        recompute: result.recompute,
      });
    } catch (err) {
      if (err instanceof SplitClusterError) {
        const status = err.code === 'not_found' ? 404 : 409;
        res.status(status).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  // Phase E — Category rules. POST creates an acceptance_rules row with
  // scope='category' and fans out across every matching cluster in the
  // session. DELETE revokes it (deletes rule-owned acceptances and
  // re-opens clusters that no longer have any rule coverage).
  const categoryAcceptBodySchema = z.object({
    region_role: z.string().min(1).max(64),
    change_type: z.string().min(1).max(64),
    signature_version: z.string().max(8).optional(),
    label: z.string().max(120).optional(),
    notes: z.string().max(2000).optional(),
    created_by: z.string().max(120).optional(),
  }).strict();
  router.post('/category-accept', (req, res) => {
    const sessionId = (req.params as { id?: string }).id;
    if (!sessionId) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const body = categoryAcceptBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
      return;
    }
    const result = acceptCategory(db, sessionId, {
      region_role: body.data.region_role,
      change_type: body.data.change_type,
      signature_version: body.data.signature_version,
      label: body.data.label,
      notes: body.data.notes,
      createdBy: body.data.created_by,
    });
    res.status(200).json({
      rule: result.rule,
      clusters_accepted: result.clusters_accepted,
      clusters_skipped_already_accepted: result.clusters_skipped_already_accepted,
      acceptances_created: result.acceptances_created,
      acceptances_preserved: result.acceptances_preserved,
    });
  });

  router.delete('/category-accept/:rule_id', (req, res) => {
    const sessionId = (req.params as { id?: string }).id;
    const ruleId = (req.params as { rule_id?: string }).rule_id;
    if (!sessionId || !ruleId) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    try {
      const result = revokeCategory(db, sessionId, ruleId);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof ClusterRuleError) {
        res.status(404).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}

/**
 * Resolve the cluster's representative difference into a richer DTO that
 * includes the comparison's image shas and metrics. The cluster detail UI
 * uses these to render the sample image triple inline.
 */
function representativeFor(db: Db, cluster: DifferenceClusterRow): ClusterRepresentativeDto | null {
  if (!cluster.representative_difference_id) return null;
  interface JoinRow {
    description: string;
    severity: string | null;
    bounding_box_json: string | null;
    comparison_id: string;
    url_pair_id: string;
    viewport_name: string;
    url_a: string;
    url_b: string;
    capture_a_sha: string | null;
    capture_b_sha: string | null;
    im_diff_sha: string | null;
    ssim: number | null;
    changed_pct: number | null;
    lm_summary: string | null;
    lm_confidence: number | null;
  }
  const row = db
    .prepare<[string], JoinRow>(
      `SELECT d.description           AS description,
              d.severity              AS severity,
              d.bounding_box_json     AS bounding_box_json,
              c.id                    AS comparison_id,
              c.url_pair_id           AS url_pair_id,
              c.viewport_name         AS viewport_name,
              p.url_a                 AS url_a,
              p.url_b                 AS url_b,
              ca.screenshot_sha256    AS capture_a_sha,
              cb.screenshot_sha256    AS capture_b_sha,
              c.im_diff_sha256        AS im_diff_sha,
              c.ssim                  AS ssim,
              c.changed_pixel_percentage AS changed_pct,
              c.lm_diff_summary       AS lm_summary,
              c.lm_confidence         AS lm_confidence
         FROM differences d
         JOIN comparisons c  ON c.id = d.comparison_id
         JOIN url_pairs   p  ON p.id = c.url_pair_id
         JOIN captures    ca ON ca.id = c.capture_a_id
         JOIN captures    cb ON cb.id = c.capture_b_id
        WHERE d.id = ?`,
    )
    .get(cluster.representative_difference_id);
  if (!row) return null;
  return {
    difference_id: cluster.representative_difference_id,
    comparison_id: row.comparison_id,
    url_pair_id: row.url_pair_id,
    viewport_name: row.viewport_name,
    url_a: row.url_a,
    url_b: row.url_b,
    description: row.description,
    severity: row.severity,
    bounding_box: parseBbox(row.bounding_box_json),
    capture_a_sha: row.capture_a_sha,
    capture_b_sha: row.capture_b_sha,
    im_diff_sha: row.im_diff_sha,
    ssim: row.ssim,
    changed_pct: row.changed_pct,
    lm_summary: row.lm_summary,
    lm_confidence: row.lm_confidence,
  };
}

function withSample(db: Db, cluster: DifferenceClusterRow): ClusterSummaryDto {
  if (!cluster.representative_difference_id) {
    return { ...cluster, pair_outcome: 'both_present', sample: null };
  }
  const row = db
    .prepare<[string], {
      description: string;
      severity: string | null;
      bounding_box_json: string | null;
      url_a: string;
      url_b: string;
    }>(
      `SELECT d.description AS description,
              d.severity    AS severity,
              d.bounding_box_json AS bounding_box_json,
              p.url_a       AS url_a,
              p.url_b       AS url_b
         FROM differences d
         JOIN comparisons c ON c.id = d.comparison_id
         JOIN url_pairs   p ON p.id = c.url_pair_id
        WHERE d.id = ?`,
    )
    .get(cluster.representative_difference_id);
  return { ...cluster, pair_outcome: 'both_present', sample: row ?? null };
}

function stateDistribution(db: Db, sessionId: string): Record<ClusterReviewState, number> {
  const rows = db
    .prepare<[string], { review_state: ClusterReviewState; n: number }>(
      `SELECT review_state, COUNT(*) AS n
         FROM difference_clusters
        WHERE session_id = ?
        GROUP BY review_state`,
    )
    .all(sessionId);
  const out: Record<ClusterReviewState, number> = {
    open: 0, accepted: 0, rejected: 0, split: 0, anomaly: 0,
  };
  for (const r of rows) out[r.review_state] = r.n;
  return out;
}

function parseReviewState(raw: unknown): ClusterReviewState | null | 'invalid' {
  if (raw === undefined) return null;
  if (typeof raw !== 'string') return 'invalid';
  const allowed: ClusterReviewState[] = ['open', 'accepted', 'rejected', 'split', 'anomaly'];
  return allowed.includes(raw as ClusterReviewState)
    ? (raw as ClusterReviewState)
    : 'invalid';
}

function parsePositiveInt(raw: unknown, defaultValue: number, max: number): number {
  if (typeof raw !== 'string') return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) return defaultValue;
  return Math.min(n, max);
}

function parseBbox(json: string | null): { x: number; y: number; width: number; height: number } | null {
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as { x: number; y: number; width: number; height: number };
    if (
      typeof obj.x === 'number' && typeof obj.y === 'number' &&
      typeof obj.width === 'number' && typeof obj.height === 'number'
    ) {
      return obj;
    }
  } catch { /* fall through */ }
  return null;
}

// ---------------------------------------------------------------------------
// Synthetic outcome-bucket clusters.
//
// Comparisons short-circuit before writing `differences` rows when either
// side is flagged as missing (capture.is_missing=1 → pair_outcome != both_present),
// and capture failures never produce a comparison at all. That leaves the
// Clusters view blind to those rows — even though the Rows view counts
// them under its Outcome filter. We synthesize one cluster-like entry per
// (viewport, bucket) so the same Outcome filter chips work in clusters
// mode. These are read-only — accept/reject is row-level, handled from
// the Rows view.
// ---------------------------------------------------------------------------

type OutcomeBucket = Exclude<PairOutcome, 'both_present'> | 'capture_failed';

const OUTCOME_BUCKET_LABEL: Record<OutcomeBucket, string> = {
  a_missing: 'Missing on A',
  b_missing: 'Missing on B',
  both_missing: 'Missing on both',
  capture_failed: 'Capture failed',
};

/**
 * Resolve the session's capture options against the schema defaults so
 * `captureOptsHashFor` (which expects a fully-shaped `CaptureRunOptionsParsed`)
 * has all required fields. Mirrors `resolveEvaluationConfig`'s merge.
 */
function resolveSessionCaptureOptions(config: SessionConfig): CaptureRunOptionsParsed {
  return captureRunOptionsSchema.parse({
    ...(config.default_capture_options ?? {}),
    viewports: config.default_viewports ?? [],
  });
}

function synthesizeOutcomeClusters(db: Db, sessionId: string): ClusterSummaryDto[] {
  // Mirror the Rows view: pair_outcome is derived from the *latest
  // capture per (url, viewport)*, not from comparisons. Comparisons may
  // be stale (showing 'both_present' from before a recapture changed
  // is_missing) or absent entirely (capture failed → no comparison row
  // ever created). Reading captures directly keeps the synthetic
  // clusters in sync with what Rows shows.
  //
  // The capture_opts_hash on capture_cache scopes the lookup to the
  // session's current capture options — same scoping the evaluator uses
  // in `readSessionResults`.
  const sessionConfig = getSessionConfig(db, sessionId);
  if (!sessionConfig) return [];
  const viewports = sessionConfig.default_viewports ?? [];
  if (viewports.length === 0) return [];
  const captureOptions = resolveSessionCaptureOptions(sessionConfig);

  // capture_cache(url, viewport, opts_hash) → is_missing for the live
  // capture under the session's current opts. NULL is_missing = legacy
  // row predating the column → treat as not missing (parity with the
  // evaluator).
  const cacheStmt = db.prepare<
    [string, string, string],
    { is_missing: number | null }
  >(
    `SELECT c.is_missing
       FROM capture_cache cc
       LEFT JOIN captures c ON c.id = cc.capture_id
      WHERE cc.url = ? AND cc.viewport_name = ? AND cc.capture_opts_hash = ?`,
  );

  // No cache hit for the current opts means the most-recent attempt
  // either errored, is in progress, or never ran. We mirror the Rows
  // view's `captureStatusFor` — fall back to the latest captures row
  // for that (session, url, viewport) and treat status='error' as
  // capture_failed; everything else falls outside any synthetic bucket.
  const recentCaptureStmt = db.prepare<
    [string, string, string],
    { status: string }
  >(
    `SELECT c.status
       FROM captures c
       JOIN capture_runs cr ON cr.id = c.capture_run_id
      WHERE cr.session_id = ? AND c.url = ? AND c.viewport_name = ?
      ORDER BY c.created_at DESC
      LIMIT 1`,
  );

  const pairs = db
    .prepare<[string], { id: string; url_a: string; url_b: string }>(
      `SELECT id, url_a, url_b FROM url_pairs WHERE session_id = ?`,
    )
    .all(sessionId);

  type SideState = { missing: boolean; errored: boolean };
  const sideStateFor = (url: string, viewport: string, optsHash: string): SideState => {
    const cached = cacheStmt.get(url, viewport, optsHash);
    if (cached) {
      return { missing: cached.is_missing === 1, errored: false };
    }
    const recent = recentCaptureStmt.get(sessionId, url, viewport);
    return { missing: false, errored: recent?.status === 'error' };
  };

  const buckets = new Map<string, { viewport: string; bucket: OutcomeBucket; pairs: Set<string> }>();
  for (const vp of viewports) {
    const optsHash = captureOptsHashFor(vp, captureOptions);
    for (const p of pairs) {
      const a = sideStateFor(p.url_a, vp.name, optsHash);
      const b = sideStateFor(p.url_b, vp.name, optsHash);
      let bucket: OutcomeBucket | null = null;
      if (a.errored || b.errored) bucket = 'capture_failed';
      else if (a.missing && b.missing) bucket = 'both_missing';
      else if (a.missing) bucket = 'a_missing';
      else if (b.missing) bucket = 'b_missing';
      if (!bucket) continue;
      const key = `${vp.name}::${bucket}`;
      let b2 = buckets.get(key);
      if (!b2) {
        b2 = { viewport: vp.name, bucket, pairs: new Set() };
        buckets.set(key, b2);
      }
      b2.pairs.add(p.id);
    }
  }

  const now = new Date().toISOString();
  const out: ClusterSummaryDto[] = [];
  for (const b of buckets.values()) {
    const count = b.pairs.size;
    out.push({
      id: outcomeClusterId(b.viewport, b.bucket),
      session_id: sessionId,
      signature: `outcome:${b.bucket}`,
      signature_version: 'outcome',
      viewport_name: b.viewport,
      region_role: null,
      change_type: null,
      element_label: OUTCOME_BUCKET_LABEL[b.bucket],
      representative_difference_id: null,
      member_count: count,
      pair_count: count,
      review_state: 'open',
      review_notes: null,
      reviewed_at: null,
      created_at: now,
      updated_at: now,
      pair_outcome: b.bucket,
      sample: null,
    });
  }
  // Sort by count desc, then viewport, then bucket — bigger leverage first.
  out.sort((a, b) =>
    b.pair_count - a.pair_count
      || (a.viewport_name ?? '').localeCompare(b.viewport_name ?? '')
      || (a.element_label ?? '').localeCompare(b.element_label ?? ''),
  );
  return out;
}

function outcomeClusterId(viewport: string, bucket: OutcomeBucket): string {
  return `outcome:${viewport}:${bucket}`;
}

function parseOutcomeClusterId(id: string): { viewport: string; bucket: OutcomeBucket } | null {
  const parts = id.split(':');
  if (parts.length !== 3 || parts[0] !== 'outcome') return null;
  const [, viewport, bucket] = parts;
  if (!viewport || !bucket) return null;
  if (
    bucket !== 'a_missing' &&
    bucket !== 'b_missing' &&
    bucket !== 'both_missing' &&
    bucket !== 'capture_failed'
  ) {
    return null;
  }
  return { viewport, bucket };
}

function buildOutcomeClusterDetail(
  db: Db,
  sessionId: string,
  clusterId: string,
): ClusterDetailDto | null {
  const parsed = parseOutcomeClusterId(clusterId);
  if (!parsed) return null;

  // Same capture-derived logic as synthesizeOutcomeClusters — see the
  // comment there for why we read from capture_cache + captures rather
  // than from comparisons.
  const sessionConfig = getSessionConfig(db, sessionId);
  if (!sessionConfig) return null;
  const vp = (sessionConfig.default_viewports ?? []).find((v) => v.name === parsed.viewport);
  if (!vp) return null;
  const captureOptions = resolveSessionCaptureOptions(sessionConfig);
  const optsHash = captureOptsHashFor(vp, captureOptions);

  // capture_cache returns the screenshot sha + is_missing flag; captures
  // table is the fallback for the errored-capture case so we can still
  // show "what was attempted" in the detail panel.
  const cacheStmt = db.prepare<
    [string, string, string],
    { screenshot_sha256: string; is_missing: number | null }
  >(
    `SELECT cc.screenshot_sha256, c.is_missing
       FROM capture_cache cc
       LEFT JOIN captures c ON c.id = cc.capture_id
      WHERE cc.url = ? AND cc.viewport_name = ? AND cc.capture_opts_hash = ?`,
  );
  const recentCaptureStmt = db.prepare<
    [string, string, string],
    { status: string; screenshot_sha256: string | null }
  >(
    `SELECT c.status, c.screenshot_sha256
       FROM captures c
       JOIN capture_runs cr ON cr.id = c.capture_run_id
      WHERE cr.session_id = ? AND c.url = ? AND c.viewport_name = ?
      ORDER BY c.created_at DESC
      LIMIT 1`,
  );
  // Comparison id is convenient for the per-member "open this row in
  // ComparisonDetail" link — best-effort, since comparisons may not
  // exist for capture-failed pairs.
  const comparisonStmt = db.prepare<
    [string, string],
    { id: string }
  >(
    `SELECT id FROM comparisons
      WHERE url_pair_id = ? AND viewport_name = ?
      ORDER BY created_at DESC
      LIMIT 1`,
  );

  const pairs = db
    .prepare<[string], { id: string; url_a: string; url_b: string }>(
      `SELECT id, url_a, url_b FROM url_pairs WHERE session_id = ? ORDER BY url_a`,
    )
    .all(sessionId);

  type SideState = { missing: boolean; errored: boolean; sha: string | null };
  const sideStateFor = (url: string): SideState => {
    const cached = cacheStmt.get(url, parsed.viewport, optsHash);
    if (cached) {
      return {
        missing: cached.is_missing === 1,
        errored: false,
        sha: cached.screenshot_sha256,
      };
    }
    const recent = recentCaptureStmt.get(sessionId, url, parsed.viewport);
    return {
      missing: false,
      errored: recent?.status === 'error',
      sha: recent?.screenshot_sha256 ?? null,
    };
  };

  const members: ClusterMemberDto[] = [];
  for (const p of pairs) {
    const a = sideStateFor(p.url_a);
    const b = sideStateFor(p.url_b);
    let bucket: OutcomeBucket | null = null;
    if (a.errored || b.errored) bucket = 'capture_failed';
    else if (a.missing && b.missing) bucket = 'both_missing';
    else if (a.missing) bucket = 'a_missing';
    else if (b.missing) bucket = 'b_missing';
    if (bucket !== parsed.bucket) continue;
    const comparison = comparisonStmt.get(p.id, parsed.viewport);
    // Synthetic difference id — no real differences row exists.
    // url_pair_id + viewport is enough to keep it unique within the
    // cluster.
    const syntheticDifferenceId = `outcome-member:${p.id}:${parsed.viewport}`;
    members.push({
      difference_id: syntheticDifferenceId,
      comparison_id: comparison?.id ?? '',
      url_pair_id: p.id,
      viewport_name: parsed.viewport,
      url_a: p.url_a,
      url_b: p.url_b,
      description: OUTCOME_BUCKET_LABEL[parsed.bucket],
      severity: null,
      bounding_box: null,
      capture_a_sha: a.sha,
      capture_b_sha: b.sha,
      im_diff_sha: null,
      ssim: null,
      changed_pct: null,
      lm_summary: null,
      lm_confidence: null,
    });
  }

  const count = members.length;
  if (count === 0) return null;
  const now = new Date().toISOString();
  const clusterRow: DifferenceClusterRow = {
    id: clusterId,
    session_id: sessionId,
    signature: `outcome:${parsed.bucket}`,
    signature_version: 'outcome',
    viewport_name: parsed.viewport,
    region_role: null,
    change_type: null,
    element_label: OUTCOME_BUCKET_LABEL[parsed.bucket],
    representative_difference_id: members[0]?.difference_id ?? null,
    member_count: count,
    pair_count: count,
    review_state: 'open',
    review_notes: null,
    reviewed_at: null,
    created_at: now,
    updated_at: now,
  };
  return {
    cluster: clusterRow,
    representative: members[0] ?? null,
    members,
  };
}
