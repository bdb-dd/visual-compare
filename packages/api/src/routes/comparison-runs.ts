import { Router } from 'express';
import { z } from 'zod';
import {
  comparisonRunOptionsSchema,
  getComparisonRun,
  listComparisonRuns,
  listComparisons,
  startComparisonRun,
  type ComparisonRunDeps,
} from '../services/comparison.js';
import { toComparisonDto } from './comparisons.js';

const startBodySchema = z.object({
  session_id: z.string().min(1),
  capture_run_id: z.string().min(1),
  options: comparisonRunOptionsSchema,
});

export function comparisonRunsRouter(deps: ComparisonRunDeps): Router {
  const router = Router();

  router.post('/', (req, res) => {
    const parsed = startBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_request',
        message: parsed.error.message,
        details: parsed.error.issues,
      });
      return;
    }
    try {
      const result = startComparisonRun(deps, {
        sessionId: parsed.data.session_id,
        captureRunId: parsed.data.capture_run_id,
        options: parsed.data.options,
      });
      res.status(202).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'comparison_run_failed', message });
    }
  });

  router.get('/', (req, res) => {
    const sessionId = (req.query.session_id as string | undefined) ?? undefined;
    res.json({ comparison_runs: listComparisonRuns(deps.db, sessionId) });
  });

  router.get('/:id', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const run = getComparisonRun(deps.db, id);
    if (!run) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({
      comparison_run: run,
      comparisons: listComparisons(deps.db, { comparison_run_id: id }).map(toComparisonDto),
    });
  });

  return router;
}
