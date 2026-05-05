import { Router } from 'express';
import { z } from 'zod';
import {
  captureRunOptionsSchema,
  getCaptureRun,
  listCaptureRuns,
  listCaptures,
  startCaptureRun,
  type CaptureRunDeps,
} from '../services/capture.js';
import { toCaptureDto } from './captures.js';

const startBodySchema = z.object({
  session_id: z.string().min(1),
  options: captureRunOptionsSchema.optional(),
});

export function captureRunsRouter(deps: CaptureRunDeps): Router {
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
    const options =
      parsed.data.options ?? captureRunOptionsSchema.parse({});
    try {
      const result = startCaptureRun(deps, {
        sessionId: parsed.data.session_id,
        options,
      });
      res.status(202).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'capture_run_failed', message });
    }
  });

  router.get('/', (req, res) => {
    const sessionId = (req.query.session_id as string | undefined) ?? undefined;
    res.json({ capture_runs: listCaptureRuns(deps.db, sessionId) });
  });

  router.get('/:id', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const run = getCaptureRun(deps.db, id);
    if (!run) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({
      capture_run: run,
      captures: listCaptures(deps.db, { capture_run_id: id }).map(toCaptureDto),
    });
  });

  return router;
}
