import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  getCluster,
  listClusterMembers,
  listClusters,
  recomputeClusters,
} from '../services/clusters.js';
import {
  acceptCluster,
  ClusterRuleError,
  revokeClusterAcceptance,
} from '../services/acceptance-rules.js';
import type {
  ClusterDetailDto,
  ClusterListDto,
  ClusterMemberDto,
  ClusterRepresentativeDto,
  ClusterReviewState,
  ClusterSummaryDto,
  DifferenceClusterRow,
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

    const dto: ClusterListDto = {
      session_id: sessionId,
      total,
      by_review_state: distribution,
      clusters: clusters.map((c) => withSample(db, c)),
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
    const cluster = getCluster(db, sessionId, clusterId);
    if (!cluster) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const limit = parsePositiveInt(req.query.limit, 50, 500);
    const members = listClusterMembers(db, sessionId, clusterId, limit);

    const dto: ClusterDetailDto = {
      cluster,
      representative: representativeFor(db, cluster),
      members: members.map((m): ClusterMemberDto => ({
        difference_id: m.difference_id,
        comparison_id: m.comparison_id,
        url_pair_id: m.url_pair_id,
        viewport_name: m.viewport_name,
        url_a: m.url_a,
        url_b: m.url_b,
        description: m.description,
        severity: m.severity,
        bounding_box: parseBbox(m.bounding_box_json),
      })),
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
    const body = rejectBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
      return;
    }
    try {
      const result = revokeClusterAcceptance(db, sessionId, clusterId, {
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
    return { ...cluster, sample: null };
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
  return { ...cluster, sample: row ?? null };
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
