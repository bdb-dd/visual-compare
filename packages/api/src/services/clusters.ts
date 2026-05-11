import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import type {
  ClusterReviewState,
  DifferenceClusterRow,
} from '../types.js';

/**
 * Cluster materialisation. The `difference_clusters` table is a derived
 * view over `differences` keyed by `(session_id, signature, signature_version)`.
 *
 * `recomputeClusters` is a full rebuild for one session: it picks up every
 * differences row that has a non-null signature, groups them, and writes
 * the aggregates back. Idempotent — running twice produces the same end
 * state. Review state (open/accepted/rejected/...) is preserved across
 * rebuilds when the same signature still has at least one member.
 *
 * Reasons to recompute:
 *   - End of an evaluation run (new differences landed)
 *   - After the backfill script assigns signatures to legacy rows
 *   - Manual: surface as an admin button later
 */

export interface RecomputeResult {
  session_id: string;
  clusters_upserted: number;
  clusters_removed: number;
  members_indexed: number;
}

interface AggregatedCluster {
  signature: string;
  signature_version: string;
  viewport_name: string | null;
  region_role: string | null;
  change_type: string | null;
  element_label: string | null;
  representative_difference_id: string;
  member_count: number;
  pair_count: number;
}

export function recomputeClusters(db: Db, sessionId: string): RecomputeResult {
  const now = new Date().toISOString();

  // Pull every differences row in the session that has a signature, joined
  // with comparison facets we surface on the cluster (viewport, pair). Order
  // so the first row per signature becomes the representative — biggest
  // severity first, then by row id for determinism.
  interface Row {
    diff_id: string;
    signature: string;
    signature_version: string;
    viewport_name: string;
    url_pair_id: string;
    region_role: string | null;
    change_type: string | null;
    element_label: string | null;
    severity: string | null;
  }
  const rows = db
    .prepare<[string], Row>(
      `SELECT d.id              AS diff_id,
              d.signature       AS signature,
              d.signature_version AS signature_version,
              d.region_role     AS region_role,
              d.change_type     AS change_type,
              d.element_label   AS element_label,
              d.severity        AS severity,
              c.viewport_name   AS viewport_name,
              c.url_pair_id     AS url_pair_id
         FROM differences d
         JOIN comparisons c ON c.id = d.comparison_id
         JOIN url_pairs   p ON p.id = c.url_pair_id
        WHERE p.session_id = ?
          AND d.signature IS NOT NULL`,
    )
    .all(sessionId);

  // Group in-memory. SQLite GROUP BY would also work but the per-row pass
  // is simpler and lets us pick the representative deterministically.
  const byKey = new Map<string, {
    sig: string;
    sigv: string;
    viewport: string | null;
    region: string | null;
    change: string | null;
    label: string | null;
    rep: { id: string; sevRank: number };
    member_count: number;
    pairs: Set<string>;
  }>();

  for (const r of rows) {
    const key = `${r.signature}::${r.signature_version}`;
    const sevRank = severityRank(r.severity);
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = {
        sig: r.signature,
        sigv: r.signature_version,
        viewport: r.viewport_name,
        region: r.region_role,
        change: r.change_type,
        label: r.element_label,
        rep: { id: r.diff_id, sevRank },
        member_count: 0,
        pairs: new Set(),
      };
      byKey.set(key, bucket);
    } else {
      // Promote a higher-severity row to representative; ties resolved by
      // lexicographic diff_id for determinism.
      if (sevRank > bucket.rep.sevRank ||
          (sevRank === bucket.rep.sevRank && r.diff_id < bucket.rep.id)) {
        bucket.rep = { id: r.diff_id, sevRank };
      }
    }
    bucket.member_count += 1;
    bucket.pairs.add(`${r.url_pair_id}::${r.viewport_name}`);
  }

  const aggregates: AggregatedCluster[] = [...byKey.values()].map((b) => ({
    signature: b.sig,
    signature_version: b.sigv,
    viewport_name: b.viewport,
    region_role: b.region,
    change_type: b.change,
    element_label: b.label,
    representative_difference_id: b.rep.id,
    member_count: b.member_count,
    pair_count: b.pairs.size,
  }));

  const tx = db.transaction(() => {
    // Upsert each (signature, signature_version) keeping the existing
    // review_state/notes when the row already exists.
    const upsert = db.prepare(
      `INSERT INTO difference_clusters
         (id, session_id, signature, signature_version,
          viewport_name, region_role, change_type, element_label,
          representative_difference_id, member_count, pair_count,
          review_state, review_notes, reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, ?)
       ON CONFLICT(session_id, signature, signature_version) DO UPDATE SET
         viewport_name                = excluded.viewport_name,
         region_role                  = excluded.region_role,
         change_type                  = excluded.change_type,
         element_label                = excluded.element_label,
         representative_difference_id = excluded.representative_difference_id,
         member_count                 = excluded.member_count,
         pair_count                   = excluded.pair_count,
         updated_at                   = excluded.updated_at`,
    );

    let upserted = 0;
    for (const a of aggregates) {
      upsert.run(
        randomUUID(),
        sessionId,
        a.signature,
        a.signature_version,
        a.viewport_name,
        a.region_role,
        a.change_type,
        a.element_label,
        a.representative_difference_id,
        a.member_count,
        a.pair_count,
        now,
        now,
      );
      upserted += 1;
    }

    // Remove clusters whose signature no longer appears in the diff stream.
    const keepSet = new Set(aggregates.map((a) => `${a.signature}::${a.signature_version}`));
    const existing = db
      .prepare<[string], { id: string; signature: string; signature_version: string }>(
        `SELECT id, signature, signature_version FROM difference_clusters WHERE session_id = ?`,
      )
      .all(sessionId);
    let removed = 0;
    const del = db.prepare(`DELETE FROM difference_clusters WHERE id = ?`);
    for (const e of existing) {
      const k = `${e.signature}::${e.signature_version}`;
      if (!keepSet.has(k)) {
        del.run(e.id);
        removed += 1;
      }
    }

    return { upserted, removed };
  });
  const { upserted, removed } = tx();

  return {
    session_id: sessionId,
    clusters_upserted: upserted,
    clusters_removed: removed,
    members_indexed: rows.length,
  };
}

function severityRank(s: string | null): number {
  switch (s) {
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

/**
 * List clusters for a session, sorted by pair-count desc — biggest leverage
 * first. Filter by `review_state` when provided ('open' is the default
 * triage view; the UI may also want to surface 'accepted' / 'rejected' tabs).
 */
export function listClusters(
  db: Db,
  sessionId: string,
  opts: { reviewState?: ClusterReviewState } = {},
): DifferenceClusterRow[] {
  if (opts.reviewState) {
    return db
      .prepare<[string, ClusterReviewState], DifferenceClusterRow>(
        `SELECT * FROM difference_clusters
          WHERE session_id = ? AND review_state = ?
          ORDER BY pair_count DESC, signature ASC`,
      )
      .all(sessionId, opts.reviewState);
  }
  return db
    .prepare<[string], DifferenceClusterRow>(
      `SELECT * FROM difference_clusters
        WHERE session_id = ?
        ORDER BY pair_count DESC, signature ASC`,
    )
    .all(sessionId);
}

export function getCluster(db: Db, sessionId: string, clusterId: string): DifferenceClusterRow | null {
  return (
    db
      .prepare<[string, string], DifferenceClusterRow>(
        `SELECT * FROM difference_clusters WHERE session_id = ? AND id = ?`,
      )
      .get(sessionId, clusterId) ?? null
  );
}

export interface ClusterMember {
  difference_id: string;
  comparison_id: string;
  url_pair_id: string;
  viewport_name: string;
  url_a: string;
  url_b: string;
  description: string;
  severity: string | null;
  bounding_box_json: string | null;
}

export function listClusterMembers(
  db: Db,
  sessionId: string,
  clusterId: string,
  limit = 50,
): ClusterMember[] {
  // Resolve signature first, then fetch member differences.
  const cluster = getCluster(db, sessionId, clusterId);
  if (!cluster) return [];
  return db
    .prepare<[string, string, string, number], ClusterMember>(
      `SELECT d.id                  AS difference_id,
              d.comparison_id       AS comparison_id,
              c.url_pair_id         AS url_pair_id,
              c.viewport_name       AS viewport_name,
              p.url_a               AS url_a,
              p.url_b               AS url_b,
              d.description         AS description,
              d.severity            AS severity,
              d.bounding_box_json   AS bounding_box_json
         FROM differences d
         JOIN comparisons c ON c.id = d.comparison_id
         JOIN url_pairs   p ON p.id = c.url_pair_id
        WHERE p.session_id        = ?
          AND d.signature         = ?
          AND d.signature_version = ?
        ORDER BY d.id
        LIMIT ?`,
    )
    .all(sessionId, cluster.signature, cluster.signature_version, limit);
}
