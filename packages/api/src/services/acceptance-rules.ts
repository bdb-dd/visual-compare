import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { getCluster } from './clusters.js';
import type {
  AcceptanceRuleRow,
  BoundingBoxPercent,
  DifferenceClusterRow,
  MatchedAtLevel,
} from '../types.js';

/**
 * Cluster-level Accept / Reject — the Phase D fan-out.
 *
 * Accept inserts an acceptance_rules row and ensures a per-(pair, viewport)
 * `acceptances` row exists for every comparison the cluster touches, tagged
 * with the rule's id. Snapshot data (matched_at_level, pixel pct, regions,
 * capture shas) comes from the comparison's CURRENT state — same shape
 * `acceptances.ts:upsertAcceptance` writes for a per-row accept.
 *
 * Reject deletes only the acceptances tagged with this rule's id, leaving
 * manually-created acceptances and acceptances from OTHER rules alone.
 *
 * Both functions are wrapped in a single SQLite transaction so partial
 * fan-outs aren't observable.
 */

export interface AcceptClusterOptions {
  label?: string | null;
  notes?: string | null;
  createdBy?: string | null;
}

export interface AcceptClusterResult {
  rule: AcceptanceRuleRow;
  cluster: DifferenceClusterRow;
  /** Number of (pair, viewport) acceptances newly inserted by this fan-out. */
  acceptances_created: number;
  /** Pre-existing acceptances at the same keys that we deliberately did not overwrite. */
  acceptances_preserved: number;
}

export interface RevokeClusterResult {
  cluster: DifferenceClusterRow;
  /** Number of acceptances deleted because they were rule-owned. */
  acceptances_revoked: number;
  /** Number of rule rows deleted. */
  rules_deleted: number;
}

export class ClusterRuleError extends Error {
  constructor(
    public readonly code: 'not_found' | 'already_accepted' | 'not_accepted',
    message: string,
  ) {
    super(message);
    this.name = 'ClusterRuleError';
  }
}

// ---------------------------------------------------------------------------
// Accept
// ---------------------------------------------------------------------------

interface FanoutCandidate {
  comparison_id: string;
  url_pair_id: string;
  viewport_name: string;
  matched_at_level: MatchedAtLevel | null;
  changed_pixel_percentage: number | null;
  ssim: number | null;
  capture_a_sha: string;
  capture_b_sha: string;
}

export function acceptCluster(
  db: Db,
  sessionId: string,
  clusterId: string,
  opts: AcceptClusterOptions = {},
): AcceptClusterResult {
  const cluster = getCluster(db, sessionId, clusterId);
  if (!cluster) {
    throw new ClusterRuleError('not_found', `Cluster ${clusterId} not found in session ${sessionId}`);
  }
  if (cluster.review_state === 'accepted') {
    throw new ClusterRuleError('already_accepted', `Cluster ${clusterId} is already accepted`);
  }

  const now = new Date().toISOString();
  const ruleId = randomUUID();
  const label = opts.label ?? cluster.element_label ?? null;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO acceptance_rules
         (id, session_id, signature, signature_version, scope,
          category_region_role, category_change_type,
          label, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'cluster', NULL, NULL, ?, ?, ?, ?, ?)`,
    ).run(
      ruleId,
      sessionId,
      cluster.signature,
      cluster.signature_version,
      label,
      opts.notes ?? null,
      opts.createdBy ?? null,
      now,
      now,
    );

    // Find every (pair, viewport) comparison this cluster touches and pull
    // the current snapshot data.
    const candidates = db
      .prepare<[string, string, string], FanoutCandidate>(
        `SELECT DISTINCT
                c.id                       AS comparison_id,
                c.url_pair_id              AS url_pair_id,
                c.viewport_name            AS viewport_name,
                c.matched_at_level         AS matched_at_level,
                c.changed_pixel_percentage AS changed_pixel_percentage,
                c.ssim                     AS ssim,
                ca.screenshot_sha256       AS capture_a_sha,
                cb.screenshot_sha256       AS capture_b_sha
           FROM differences d
           JOIN comparisons c  ON c.id  = d.comparison_id
           JOIN url_pairs   p  ON p.id  = c.url_pair_id
           JOIN captures    ca ON ca.id = c.capture_a_id
           JOIN captures    cb ON cb.id = c.capture_b_id
          WHERE p.session_id        = ?
            AND d.signature         = ?
            AND d.signature_version = ?`,
      )
      .all(sessionId, cluster.signature, cluster.signature_version);

    // Cluster acceptance only makes sense when capture shas exist. Skip
    // candidates without them rather than persist an invalid acceptance row.
    const usable = candidates.filter((c) => c.capture_a_sha && c.capture_b_sha);

    const regionsForComparison = db.prepare<[string], { bounding_box_json: string | null }>(
      `SELECT bounding_box_json FROM differences
        WHERE comparison_id = ? AND bounding_box_json IS NOT NULL`,
    );

    const insertAcceptance = db.prepare(
      `INSERT INTO acceptances
         (id, session_id, url_pair_id, viewport_name, accepted_level,
          accepted_pixel_pct, accepted_ssim, accepted_diff_regions_json,
          accepted_capture_a_sha, accepted_capture_b_sha, accept_any,
          label, notes, acceptance_rule_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, url_pair_id, viewport_name) DO NOTHING`,
    );

    let created = 0;
    for (const c of usable) {
      const regionRows = regionsForComparison.all(c.comparison_id);
      const regions: BoundingBoxPercent[] = [];
      for (const r of regionRows) {
        if (!r.bounding_box_json) continue;
        try {
          const obj = JSON.parse(r.bounding_box_json) as Partial<BoundingBoxPercent>;
          if (
            typeof obj.x === 'number' && typeof obj.y === 'number' &&
            typeof obj.width === 'number' && typeof obj.height === 'number'
          ) {
            regions.push({ x: obj.x, y: obj.y, width: obj.width, height: obj.height });
          }
        } catch { /* skip malformed */ }
      }
      const info = insertAcceptance.run(
        randomUUID(),
        sessionId,
        c.url_pair_id,
        c.viewport_name,
        // accepted_level defaults to the current matched_at_level — that's
        // the state the reviewer is freezing into the acceptance.
        c.matched_at_level ?? 'none',
        c.changed_pixel_percentage,
        c.ssim,
        JSON.stringify(regions),
        c.capture_a_sha,
        c.capture_b_sha,
        label,
        opts.notes ?? null,
        ruleId,
        now,
        now,
      );
      if (info.changes > 0) created += 1;
    }

    db.prepare(
      `UPDATE difference_clusters
          SET review_state = 'accepted',
              review_notes = ?,
              reviewed_at  = ?,
              updated_at   = ?
        WHERE id = ? AND session_id = ?`,
    ).run(opts.notes ?? null, now, now, clusterId, sessionId);

    const preserved = usable.length - created;
    return { created, preserved };
  });
  const { created, preserved } = tx();

  const ruleRow = db.prepare<[string], AcceptanceRuleRow>(
    `SELECT * FROM acceptance_rules WHERE id = ?`,
  ).get(ruleId);
  const updatedCluster = getCluster(db, sessionId, clusterId);
  if (!ruleRow || !updatedCluster) {
    throw new Error('post-accept lookup failed (this should not happen inside a successful transaction)');
  }
  return {
    rule: ruleRow,
    cluster: updatedCluster,
    acceptances_created: created,
    acceptances_preserved: preserved,
  };
}

// ---------------------------------------------------------------------------
// Reject (revoke)
// ---------------------------------------------------------------------------

export function revokeClusterAcceptance(
  db: Db,
  sessionId: string,
  clusterId: string,
  opts: { notes?: string | null } = {},
): RevokeClusterResult {
  const cluster = getCluster(db, sessionId, clusterId);
  if (!cluster) {
    throw new ClusterRuleError('not_found', `Cluster ${clusterId} not found in session ${sessionId}`);
  }
  // Only act when the cluster is currently accepted — rejecting an open or
  // already-rejected cluster is a 409 from the API surface.
  if (cluster.review_state !== 'accepted') {
    throw new ClusterRuleError('not_accepted', `Cluster ${clusterId} is not in 'accepted' state (currently '${cluster.review_state}')`);
  }

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    // Find all rules that ever targeted this cluster's signature. In normal
    // operation there's exactly one active rule, but defensive coding lets
    // us recover from out-of-band rule rows.
    const rules = db
      .prepare<[string, string, string], { id: string }>(
        `SELECT id FROM acceptance_rules
          WHERE session_id        = ?
            AND signature         = ?
            AND signature_version = ?
            AND scope             = 'cluster'`,
      )
      .all(sessionId, cluster.signature, cluster.signature_version);

    if (rules.length === 0) {
      // No rule row but cluster was 'accepted' — corrupt state. Still flip
      // the cluster back to 'rejected' so the UI is consistent.
      db.prepare(
        `UPDATE difference_clusters
            SET review_state = 'rejected', reviewed_at = ?, updated_at = ?
          WHERE id = ? AND session_id = ?`,
      ).run(now, now, clusterId, sessionId);
      return { revoked: 0, rulesDeleted: 0 };
    }

    const ruleIds = rules.map((r) => r.id);
    const placeholders = ruleIds.map(() => '?').join(',');
    const delAcceptances = db
      .prepare(`DELETE FROM acceptances WHERE session_id = ? AND acceptance_rule_id IN (${placeholders})`)
      .run(sessionId, ...ruleIds);
    const delRules = db
      .prepare(`DELETE FROM acceptance_rules WHERE id IN (${placeholders})`)
      .run(...ruleIds);

    db.prepare(
      `UPDATE difference_clusters
          SET review_state = 'rejected',
              review_notes = COALESCE(?, review_notes),
              reviewed_at  = ?,
              updated_at   = ?
        WHERE id = ? AND session_id = ?`,
    ).run(opts.notes ?? null, now, now, clusterId, sessionId);

    return { revoked: delAcceptances.changes, rulesDeleted: delRules.changes };
  });
  const { revoked, rulesDeleted } = tx();

  const updated = getCluster(db, sessionId, clusterId);
  if (!updated) throw new Error('post-revoke lookup failed');
  return {
    cluster: updated,
    acceptances_revoked: revoked,
    rules_deleted: rulesDeleted,
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function listRulesForCluster(
  db: Db,
  sessionId: string,
  cluster: { signature: string; signature_version: string },
): AcceptanceRuleRow[] {
  return db
    .prepare<[string, string, string], AcceptanceRuleRow>(
      `SELECT * FROM acceptance_rules
        WHERE session_id        = ?
          AND signature         = ?
          AND signature_version = ?
          AND scope             = 'cluster'
        ORDER BY created_at`,
    )
    .all(sessionId, cluster.signature, cluster.signature_version);
}
