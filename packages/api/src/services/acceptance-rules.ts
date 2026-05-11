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
// Accept (cluster scope)
// ---------------------------------------------------------------------------

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

    const { created, preserved } = fanOutAcceptances(
      db,
      sessionId,
      cluster.signature,
      cluster.signature_version,
      ruleId,
      label,
      opts.notes ?? null,
      now,
    );

    db.prepare(
      `UPDATE difference_clusters
          SET review_state = 'accepted',
              review_notes = ?,
              reviewed_at  = ?,
              updated_at   = ?
        WHERE id = ? AND session_id = ?`,
    ).run(opts.notes ?? null, now, now, clusterId, sessionId);

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

// ---------------------------------------------------------------------------
// Phase E — Category rules. A category rule matches any cluster sharing
// (region_role, change_type) at the same signature_version. Use case:
// "all sidebar-navigation-added clusters across viewports → accept all".
// ---------------------------------------------------------------------------

export interface AcceptCategoryOptions {
  region_role: string;
  change_type: string;
  signature_version?: string;
  label?: string | null;
  notes?: string | null;
  createdBy?: string | null;
}

export interface AcceptCategoryResult {
  rule: AcceptanceRuleRow;
  clusters_accepted: number;
  /** Clusters that already had review_state='accepted' and were left alone. */
  clusters_skipped_already_accepted: number;
  acceptances_created: number;
  acceptances_preserved: number;
}

export interface RevokeCategoryResult {
  rule_id: string;
  acceptances_revoked: number;
  /** Clusters whose review_state was rolled back from 'accepted' to 'open'. */
  clusters_reopened: number;
}

/**
 * Create a category-scoped rule and fan it out across every matching
 * cluster in the session. Already-accepted clusters are skipped (their
 * cluster-level rule covers them). Returns aggregate counts.
 *
 * Default signature_version is 'v1' — category rules only make sense over
 * structured-LM-tagged clusters; v0 clusters lack region_role/change_type.
 */
export function acceptCategory(
  db: Db,
  sessionId: string,
  opts: AcceptCategoryOptions,
): AcceptCategoryResult {
  const signatureVersion = opts.signature_version ?? 'v1';
  const now = new Date().toISOString();
  const ruleId = randomUUID();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO acceptance_rules
         (id, session_id, signature, signature_version, scope,
          category_region_role, category_change_type,
          label, notes, created_by, created_at, updated_at)
       VALUES (?, ?, '', ?, 'category', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ruleId,
      sessionId,
      signatureVersion,
      opts.region_role,
      opts.change_type,
      opts.label ?? null,
      opts.notes ?? null,
      opts.createdBy ?? null,
      now,
      now,
    );

    // Pick up every cluster matching the category. Skip already-accepted
    // ones — they have their own rule and don't need to be touched.
    const clusters = db.prepare<[string, string, string, string], {
      id: string;
      signature: string;
      review_state: string;
    }>(
      `SELECT id, signature, review_state FROM difference_clusters
        WHERE session_id        = ?
          AND signature_version = ?
          AND region_role       = ?
          AND change_type       = ?`,
    ).all(sessionId, signatureVersion, opts.region_role, opts.change_type);

    let acceptedClusters = 0;
    let skippedClusters = 0;
    let totalCreated = 0;
    let totalPreserved = 0;

    for (const cluster of clusters) {
      if (cluster.review_state === 'accepted') {
        skippedClusters += 1;
        continue;
      }
      // Reuse the same fan-out logic as cluster accept: every (pair,
      // viewport) the cluster's signature touches gets a snapshot
      // acceptance tagged with this rule id.
      const { created, preserved } = fanOutAcceptances(
        db,
        sessionId,
        cluster.signature,
        signatureVersion,
        ruleId,
        opts.label ?? null,
        opts.notes ?? null,
        now,
      );
      totalCreated += created;
      totalPreserved += preserved;
      db.prepare(
        `UPDATE difference_clusters
            SET review_state = 'accepted',
                reviewed_at  = ?,
                updated_at   = ?
          WHERE id = ? AND session_id = ?`,
      ).run(now, now, cluster.id, sessionId);
      acceptedClusters += 1;
    }
    return {
      acceptedClusters,
      skippedClusters,
      totalCreated,
      totalPreserved,
    };
  });
  const counts = tx();

  const rule = db.prepare<[string], AcceptanceRuleRow>(
    `SELECT * FROM acceptance_rules WHERE id = ?`,
  ).get(ruleId);
  if (!rule) throw new Error('post-accept rule lookup failed');
  return {
    rule,
    clusters_accepted: counts.acceptedClusters,
    clusters_skipped_already_accepted: counts.skippedClusters,
    acceptances_created: counts.totalCreated,
    acceptances_preserved: counts.totalPreserved,
  };
}

/**
 * Revoke a category rule. Deletes only the acceptances tagged with this
 * rule id; resets `review_state='open'` on clusters that no longer have
 * ANY rule-owned acceptances (a cluster also covered by a cluster-level
 * rule stays 'accepted'). Manual acceptances at the same pair/viewport
 * keys are preserved.
 */
export function revokeCategory(
  db: Db,
  sessionId: string,
  ruleId: string,
): RevokeCategoryResult {
  const tx = db.transaction(() => {
    const rule = db.prepare<[string, string], AcceptanceRuleRow>(
      `SELECT * FROM acceptance_rules WHERE id = ? AND session_id = ?`,
    ).get(ruleId, sessionId);
    if (!rule) {
      throw new ClusterRuleError('not_found', `Rule ${ruleId} not found in session ${sessionId}`);
    }
    if (rule.scope !== 'category') {
      throw new ClusterRuleError('not_found', `Rule ${ruleId} is not a category rule`);
    }

    // Snapshot which clusters were covered before the delete so we can
    // recompute review_state afterwards.
    const coveredClusters = db.prepare<[string, string, string, string], { id: string }>(
      `SELECT id FROM difference_clusters
        WHERE session_id        = ?
          AND signature_version = ?
          AND region_role       = ?
          AND change_type       = ?
          AND review_state      = 'accepted'`,
    ).all(
      sessionId,
      rule.signature_version,
      rule.category_region_role ?? '',
      rule.category_change_type ?? '',
    );

    const delAcceptances = db.prepare(
      `DELETE FROM acceptances WHERE session_id = ? AND acceptance_rule_id = ?`,
    ).run(sessionId, ruleId);

    db.prepare(`DELETE FROM acceptance_rules WHERE id = ?`).run(ruleId);

    // For each previously-covered cluster, check whether ANY rule-owned
    // acceptances still touch it via its signature. If not, the cluster's
    // 'accepted' state is no longer backed by anything — flip to 'open'.
    let reopened = 0;
    const nowReopen = new Date().toISOString();
    const remainingForCluster = db.prepare<[string, string, string], { c: number }>(
      `SELECT COUNT(*) AS c FROM acceptances a
        JOIN comparisons cm ON cm.url_pair_id = a.url_pair_id
                           AND cm.viewport_name = a.viewport_name
        JOIN differences d  ON d.comparison_id = cm.id
       WHERE a.session_id          = ?
         AND a.acceptance_rule_id IS NOT NULL
         AND d.signature           = (SELECT signature FROM difference_clusters WHERE id = ?)
         AND d.signature_version   = (SELECT signature_version FROM difference_clusters WHERE id = ?)`,
    );
    const reopenCluster = db.prepare(
      `UPDATE difference_clusters
          SET review_state = 'open', reviewed_at = NULL, updated_at = ?
        WHERE id = ? AND session_id = ?`,
    );
    for (const c of coveredClusters) {
      const remainder = remainingForCluster.get(sessionId, c.id, c.id);
      if ((remainder?.c ?? 0) === 0) {
        reopenCluster.run(nowReopen, c.id, sessionId);
        reopened += 1;
      }
    }
    return { revoked: delAcceptances.changes, reopened };
  });
  const result = tx();
  return {
    rule_id: ruleId,
    acceptances_revoked: result.revoked,
    clusters_reopened: result.reopened,
  };
}

// ---------------------------------------------------------------------------
// Rule auto-apply. Called after recomputeClusters() to ensure that every
// existing rule (cluster-scope and category-scope) has its fan-out applied
// to any newly-landed clusters. INSERT ON CONFLICT DO NOTHING makes this
// safe to re-run — manual acceptances and prior rule-owned acceptances
// are preserved.
//
// What this enables: "decisions persist across runs." A reviewer who
// accepted "sidebar nav added" on Monday will see Tuesday's new pages
// auto-categorised as 'accepted' if the same signature lands again.
// ---------------------------------------------------------------------------

export interface ApplySessionRulesResult {
  rules_processed: number;
  acceptances_created: number;
  clusters_accepted: number;
}

export function applySessionRules(db: Db, sessionId: string): ApplySessionRulesResult {
  const rules = db.prepare<[string], AcceptanceRuleRow>(
    `SELECT * FROM acceptance_rules WHERE session_id = ? ORDER BY created_at`,
  ).all(sessionId);

  const now = new Date().toISOString();
  let totalCreated = 0;
  let clustersFlipped = 0;

  const tx = db.transaction(() => {
    for (const rule of rules) {
      // Resolve which clusters this rule covers.
      const clusters = rule.scope === 'cluster'
        ? db.prepare<[string, string, string], { id: string; review_state: string; signature: string }>(
            `SELECT id, review_state, signature FROM difference_clusters
              WHERE session_id = ? AND signature = ? AND signature_version = ?`,
          ).all(sessionId, rule.signature, rule.signature_version)
        : db.prepare<[string, string, string, string], { id: string; review_state: string; signature: string }>(
            `SELECT id, review_state, signature FROM difference_clusters
              WHERE session_id = ? AND signature_version = ?
                AND region_role = ? AND change_type = ?`,
          ).all(
            sessionId, rule.signature_version,
            rule.category_region_role ?? '',
            rule.category_change_type ?? '',
          );

      for (const cluster of clusters) {
        const { created } = fanOutAcceptances(
          db,
          sessionId,
          cluster.signature,
          rule.signature_version,
          rule.id,
          rule.label,
          rule.notes,
          now,
        );
        totalCreated += created;
        if (cluster.review_state !== 'accepted' && created > 0) {
          db.prepare(
            `UPDATE difference_clusters
                SET review_state = 'accepted', reviewed_at = ?, updated_at = ?
              WHERE id = ? AND session_id = ?`,
          ).run(now, now, cluster.id, sessionId);
          clustersFlipped += 1;
        }
      }
    }
  });
  tx();

  return {
    rules_processed: rules.length,
    acceptances_created: totalCreated,
    clusters_accepted: clustersFlipped,
  };
}

// ---------------------------------------------------------------------------
// Shared fan-out helper. Used by both cluster accept and category accept.
// Pulls every (pair, viewport) comparison touched by a signature and
// upserts a rule-tagged acceptance with the snapshot data.
// ---------------------------------------------------------------------------

interface FanOutCounts {
  created: number;
  preserved: number;
}

function fanOutAcceptances(
  db: Db,
  sessionId: string,
  signature: string,
  signatureVersion: string,
  ruleId: string,
  label: string | null,
  notes: string | null,
  now: string,
): FanOutCounts {
  interface Candidate {
    comparison_id: string;
    url_pair_id: string;
    viewport_name: string;
    matched_at_level: MatchedAtLevel | null;
    changed_pixel_percentage: number | null;
    ssim: number | null;
    capture_a_sha: string;
    capture_b_sha: string;
  }
  const candidates = db.prepare<[string, string, string], Candidate>(
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
  ).all(sessionId, signature, signatureVersion);

  const usable = candidates.filter((c) => c.capture_a_sha && c.capture_b_sha);

  // Snapshot regions are the IMAGICK CCs — that's what the read-time
  // acceptance_status check compares against (evaluator.ts:parseImagickRegions
  // filters to source='imagick'). Including LM bboxes here would make the
  // snapshot asymmetric with the read-time check and cause false-positive
  // expanded_diff verdicts. Clustering still uses LM differences; the
  // snapshot is about pixel-level regression detection, a separate concern.
  const regionsForComparison = db.prepare<[string], { bounding_box_json: string | null }>(
    `SELECT bounding_box_json FROM differences
      WHERE comparison_id = ? AND source = 'imagick' AND bounding_box_json IS NOT NULL`,
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
      c.matched_at_level ?? 'none',
      c.changed_pixel_percentage,
      c.ssim,
      JSON.stringify(regions),
      c.capture_a_sha,
      c.capture_b_sha,
      label,
      notes,
      ruleId,
      now,
      now,
    );
    if (info.changes > 0) created += 1;
  }
  return { created, preserved: usable.length - created };
}
