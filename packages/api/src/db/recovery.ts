import type { Db } from './client.js';

export const INTERRUPTED_BY_RESTART = 'interrupted_by_restart';

export interface ResumableEvaluation {
  id: string;
  session_id: string;
  /** Resolved `EvaluationConfig` JSON snapshot stored at start time. */
  config_snapshot_json: string;
}

export interface RecoveryResult {
  jobs: number;
  captures: number;
  comparisons: number;
  evaluations: number;
  /**
   * Evaluations that were `running`/`pending` at restart, captured *before*
   * they were flipped to `error`. The startup script calls
   * `resumeInterruptedEvaluations` with these so an unfinished eval picks
   * back up where it left off (cached captures stay cached, the planner
   * re-queues the still-pending work). One entry per evaluation row;
   * `evaluator.start` coalesces if multiple were running for the same
   * session.
   */
  resumable: ResumableEvaluation[];
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
 * The returned `resumable` array carries the evaluations that were live,
 * so the caller (index.ts) can hand them to `resumeInterruptedEvaluations`
 * and re-drive the work automatically — no user click required.
 */
export function recoverInterruptedRuns(db: Db, now: string = new Date().toISOString()): RecoveryResult {
  const result: RecoveryResult = {
    jobs: 0,
    captures: 0,
    comparisons: 0,
    evaluations: 0,
    resumable: [],
  };

  const apply = db.transaction(() => {
    // Capture the live evaluations BEFORE we flip them to 'error' so the
    // caller can resume them.
    result.resumable = db
      .prepare<unknown[], ResumableEvaluation>(
        `SELECT id, session_id, config_snapshot_json
           FROM evaluations
          WHERE status IN ('running', 'pending')
          ORDER BY started_at`,
      )
      .all();

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
