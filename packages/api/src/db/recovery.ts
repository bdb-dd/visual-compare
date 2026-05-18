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
 * Both `running`/`processing` (mid-flight when the process died) AND `pending`
 * (queued but never picked up — the queue is in-memory only) rows are
 * orphaned by a restart: the in-memory JobQueue is fresh, no handler will
 * pick them up, and the planner drives off `capture_cache` rather than the
 * `captures` table, so leaving them pending accomplishes nothing but lets the
 * table grow by ~10K rows per interrupted Recapture-all + Evaluate.
 *
 * Both are flipped to `error` with `error_message='interrupted_by_restart'`.
 * Re-driving the work is the planner's job: any not-yet-cached URL will be
 * picked up by the next Evaluate, which creates a fresh capture_run.
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
         WHERE status IN ('running', 'pending')`,
      )
      .run(INTERRUPTED_BY_RESTART, now);
    result.jobs = jobs.changes;

    const captures = db
      .prepare(
        `UPDATE captures
         SET status = 'error',
             error_message = ?
         WHERE status IN ('processing', 'pending')`,
      )
      .run(INTERRUPTED_BY_RESTART);
    result.captures = captures.changes;

    const comparisons = db
      .prepare(
        `UPDATE comparisons
         SET status = 'error',
             error_message = ?,
             completed_at = ?
         WHERE status IN ('processing', 'pending')`,
      )
      .run(INTERRUPTED_BY_RESTART, now);
    result.comparisons = comparisons.changes;

    const evaluations = db
      .prepare(
        `UPDATE evaluations
         SET status = 'error',
             error_message = ?,
             completed_at = ?
         WHERE status IN ('running', 'pending')`,
      )
      .run(INTERRUPTED_BY_RESTART, now);
    result.evaluations = evaluations.changes;
  });
  apply();

  return result;
}
