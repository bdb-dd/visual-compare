import type { Db } from './client.js';

export const INTERRUPTED_BY_RESTART = 'interrupted_by_restart';

export interface RecoveryResult {
  jobs: number;
  captures: number;
  comparisons: number;
  evaluations: number;
}

/**
 * Server restart recovery. Run before the queue accepts new work.
 *
 * - jobs.running       → error  (with error_message='interrupted_by_restart', completed_at=now)
 * - captures.processing  → error
 * - comparisons.processing → error
 * - evaluations.running → error  (otherwise the UI's Evaluate button coalesces
 *   onto a corpse and polls forever)
 *
 * `pending` rows are left alone and require explicit retry.
 */
export function recoverInterruptedRuns(db: Db, now: string = new Date().toISOString()): RecoveryResult {
  const result: RecoveryResult = { jobs: 0, captures: 0, comparisons: 0, evaluations: 0 };

  const apply = db.transaction(() => {
    const jobs = db
      .prepare(
        `UPDATE jobs
         SET status = 'error',
             error_message = ?,
             completed_at = ?
         WHERE status = 'running'`,
      )
      .run(INTERRUPTED_BY_RESTART, now);
    result.jobs = jobs.changes;

    const captures = db
      .prepare(
        `UPDATE captures
         SET status = 'error',
             error_message = ?
         WHERE status = 'processing'`,
      )
      .run(INTERRUPTED_BY_RESTART);
    result.captures = captures.changes;

    const comparisons = db
      .prepare(
        `UPDATE comparisons
         SET status = 'error',
             error_message = ?,
             completed_at = ?
         WHERE status = 'processing'`,
      )
      .run(INTERRUPTED_BY_RESTART, now);
    result.comparisons = comparisons.changes;

    const evaluations = db
      .prepare(
        `UPDATE evaluations
         SET status = 'error',
             error_message = ?,
             completed_at = ?
         WHERE status = 'running'`,
      )
      .run(INTERRUPTED_BY_RESTART, now);
    result.evaluations = evaluations.changes;
  });
  apply();

  return result;
}
