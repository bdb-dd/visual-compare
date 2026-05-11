import { Router } from 'express';
import type { Db } from '../db/client.js';
import { getEvaluation } from '../services/evaluator.js';
import type { EvaluationProgress } from '../types.js';

/**
 * Single-evaluation detail endpoint. Per-session listing and creation
 * endpoints live on the sessions router so they can share the path prefix.
 */
export function evaluationsRouter(db: Db): Router {
  const router = Router();

  router.get('/:id', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'id is required' });
      return;
    }
    const row = getEvaluation(db, id);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ evaluation: parseEvaluationRow(db, row) });
  });

  return router;
}

interface JobProgressRow {
  status: string;
  progress_current: number;
  progress_total: number;
}

/**
 * Resolve in-flight progress for an evaluation by joining the underlying
 * jobs. The capture job runs before the comparison job; once capture is
 * complete the comparison job takes over. `null` when the evaluation isn't
 * running or no underlying job is currently running.
 */
function computeProgress(
  db: Db,
  row: { status: string; capture_run_id: string | null; comparison_run_id: string | null },
): EvaluationProgress | null {
  if (row.status !== 'running') return null;

  const captureJob = row.capture_run_id
    ? db
        .prepare<[string], JobProgressRow>(
          `SELECT j.status, j.progress_current, j.progress_total
           FROM capture_runs cr JOIN jobs j ON j.id = cr.job_id
           WHERE cr.id = ?`,
        )
        .get(row.capture_run_id) ?? null
    : null;
  if (captureJob && captureJob.status === 'running') {
    return { phase: 'capture', current: captureJob.progress_current, total: captureJob.progress_total };
  }

  const comparisonJob = row.comparison_run_id
    ? db
        .prepare<[string], JobProgressRow>(
          `SELECT j.status, j.progress_current, j.progress_total
           FROM comparison_runs cr JOIN jobs j ON j.id = cr.job_id
           WHERE cr.id = ?`,
        )
        .get(row.comparison_run_id) ?? null
    : null;
  if (comparisonJob && comparisonJob.status === 'running') {
    return {
      phase: 'comparison',
      current: comparisonJob.progress_current,
      total: comparisonJob.progress_total,
    };
  }

  return null;
}

export function parseEvaluationRow<
  T extends {
    config_snapshot_json: string;
    cache_hits: string;
    status: string;
    capture_run_id: string | null;
    comparison_run_id: string | null;
  },
>(
  db: Db,
  row: T,
): Omit<T, 'config_snapshot_json' | 'cache_hits'> & {
  config: unknown;
  cache_hits: { captures: number; pixel: number; lm: number };
  progress: EvaluationProgress | null;
} {
  const { config_snapshot_json, cache_hits, ...rest } = row;
  return {
    ...rest,
    config: JSON.parse(config_snapshot_json),
    cache_hits: JSON.parse(cache_hits || '{}'),
    progress: computeProgress(db, row),
  };
}
