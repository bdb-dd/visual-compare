import { Router } from 'express';
import type { Db } from '../db/client.js';
import { getEvaluation } from '../services/evaluator.js';

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
    res.json({ evaluation: parseEvaluationRow(row) });
  });

  return router;
}

export function parseEvaluationRow<T extends { config_snapshot_json: string; comparison_run_ids: string; cache_hits: string }>(
  row: T,
): Omit<T, 'config_snapshot_json' | 'comparison_run_ids' | 'cache_hits'> & {
  config: unknown;
  comparison_run_ids: string[];
  cache_hits: { captures: number; pixel: number; lm: number };
} {
  const { config_snapshot_json, comparison_run_ids, cache_hits, ...rest } = row;
  return {
    ...rest,
    config: JSON.parse(config_snapshot_json),
    comparison_run_ids: JSON.parse(comparison_run_ids),
    cache_hits: JSON.parse(cache_hits || '{}'),
  };
}
