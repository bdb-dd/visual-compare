import { Router } from 'express';
import type { Db } from '../db/client.js';
import {
  getCluster,
  listClusterMembers,
  listClusters,
  recomputeClusters,
} from '../services/clusters.js';
import type {
  ClusterReviewState,
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

export type ClusterSummaryDto = DifferenceClusterRow & {
  /** Sample diff used to render the cluster card (description + bbox). */
  sample: {
    description: string;
    severity: string | null;
    bounding_box_json: string | null;
    url_a: string;
    url_b: string;
  } | null;
};

export interface ClusterListDto {
  session_id: string;
  /** Total cluster count for this session (any review state). */
  total: number;
  /** Distribution across review states — useful for the UI's tab strip. */
  by_review_state: Record<ClusterReviewState, number>;
  clusters: ClusterSummaryDto[];
}

export interface ClusterDetailDto {
  cluster: DifferenceClusterRow;
  members: Array<{
    difference_id: string;
    comparison_id: string;
    url_pair_id: string;
    viewport_name: string;
    url_a: string;
    url_b: string;
    description: string;
    severity: string | null;
    bounding_box: { x: number; y: number; width: number; height: number } | null;
  }>;
}

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
      members: members.map((m) => ({
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

  return router;
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
