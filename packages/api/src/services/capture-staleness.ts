import type { Db } from '../db/client.js';
import type { CaptureSide } from '../types.js';

/**
 * Latest captures row per (url_pair_id, viewport_name, side) for a session.
 *
 * Surfaces "is the displayed capture stale relative to a newer attempt?":
 * if the captures row a consumer is currently rendering (cache row's
 * capture_id, or a comparison's capture_a_id/capture_b_id) doesn't match
 * the latest captures row's id, a newer attempt exists. When that newer
 * attempt is pending/processing the cache hasn't rolled forward yet; when
 * it errored the cache keeps pointing at the prior good capture and the
 * row's status reports the failure.
 *
 * Used by:
 *   - planEvaluation, to avoid dispatching comparisons against a cache
 *     row that's about to be overwritten by an in-flight recapture.
 *   - readSessionResults, to populate CaptureStatusInfo.is_stale.
 *   - listClusterMembers, to flag stale member images so the Clusters
 *     view matches the Rows view during a recapture.
 *
 * Map key is `${url_pair_id}::${viewport_name}::${side}`. Returns the
 * latest row's id + status. A single window-function pass, indexed via
 * idx_captures_pair + idx_captures_run.
 */
export interface LatestCaptureRow {
  capture_id: string;
  status: string;
  error_message: string | null;
}

export function loadLatestCapturesByKey(
  db: Db,
  sessionId: string,
): Map<string, LatestCaptureRow> {
  const out = new Map<string, LatestCaptureRow>();
  for (const row of db
    .prepare<
      [string],
      {
        url_pair_id: string;
        viewport_name: string;
        side: CaptureSide;
        capture_id: string;
        status: string;
        error_message: string | null;
      }
    >(
      `SELECT url_pair_id, viewport_name, side, id AS capture_id, status, error_message
         FROM (
           SELECT c.id, c.url_pair_id, c.viewport_name, c.side, c.status, c.error_message,
                  ROW_NUMBER() OVER (
                    PARTITION BY c.url_pair_id, c.viewport_name, c.side
                    ORDER BY c.created_at DESC
                  ) AS rn
             FROM captures c
             JOIN capture_runs cr ON cr.id = c.capture_run_id
            WHERE cr.session_id = ?
         )
        WHERE rn = 1`,
    )
    .all(sessionId)) {
    out.set(`${row.url_pair_id}::${row.viewport_name}::${row.side}`, {
      capture_id: row.capture_id,
      status: row.status,
      error_message: row.error_message,
    });
  }
  return out;
}

export function latestCapturesKey(
  url_pair_id: string,
  viewport_name: string,
  side: CaptureSide,
): string {
  return `${url_pair_id}::${viewport_name}::${side}`;
}
