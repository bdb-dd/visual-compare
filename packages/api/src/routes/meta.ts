import { Router } from 'express';
import { availableParallelism, cpus } from 'node:os';
import { DEFAULT_VIEWPORTS, DEFAULT_VIEWPORT_NAME } from '../constants/viewports.js';
import { EQUIVALENCE_LEVELS, DEFAULT_EQUIVALENCE_LEVEL } from '../constants/equivalence.js';
import type { LmClient } from '../services/lm.js';
import type { LmActivityTracker } from '../services/lm-activity.js';
import type { WorkerActivityTracker } from '../services/worker-activity.js';

export interface MetaRouterDeps {
  lm?: LmClient;
  lmActivity?: LmActivityTracker;
  workerActivity?: WorkerActivityTracker;
}

export function metaRouter(deps: MetaRouterDeps = {}): Router {
  const router = Router();

  router.get('/viewports', (_req, res) => {
    res.json({ viewports: DEFAULT_VIEWPORTS, default: DEFAULT_VIEWPORT_NAME });
  });

  router.get('/equivalence-levels', (_req, res) => {
    res.json({ levels: EQUIVALENCE_LEVELS, default: DEFAULT_EQUIVALENCE_LEVEL });
  });

  router.get('/system-info', (_req, res) => {
    // availableParallelism is the right knob for "how many parallel workers
    // should this app use." It accounts for CPU affinity/cgroup quotas where
    // present and falls back to logical core count otherwise. cpus().length
    // is reported alongside for diagnostic display.
    res.json({
      max_capture_concurrency: availableParallelism(),
      cpu_count: cpus().length,
    });
  });

  router.get('/lm-status', async (req, res) => {
    if (!deps.lm) {
      res.json({
        ok: false,
        configured: false,
        message: 'LM client is not configured on the server.',
      });
      return;
    }
    const force = req.query.force === '1' || req.query.force === 'true';
    const pf = await deps.lm.preflight({ force });
    if (pf.ok) {
      res.json({
        ok: true,
        configured: true,
        server_reachable: true,
        model_loaded: true,
        configured_model: pf.configuredModel,
        loaded_models: pf.loadedModels,
        started_server: pf.startedServer,
        loaded_model: pf.loadedModel,
        duration_ms: pf.durationMs,
      });
      return;
    }
    res.json({
      ok: false,
      configured: true,
      server_reachable: pf.serverReachable,
      model_loaded: pf.modelLoaded,
      configured_model: pf.configuredModel,
      loaded_models: pf.loadedModels,
      reason: pf.reason,
      message: pf.message,
      started_server: pf.startedServer,
      loaded_model: pf.loadedModel,
      duration_ms: pf.durationMs,
    });
  });

  router.get('/lm-activity', (_req, res) => {
    if (!deps.lmActivity) {
      // No tracker registered → return an empty histogram so the
      // frontend can still render the component without special-casing
      // "tracker missing" (e.g. dev runs without the LM wired up).
      res.json({ samples: [], parallel: 0, interval_ms: 0 });
      return;
    }
    res.json(deps.lmActivity.snapshot());
  });

  router.get('/worker-activity', (_req, res) => {
    if (!deps.workerActivity) {
      res.json({ samples: [], capacity: 0, interval_ms: 0 });
      return;
    }
    res.json(deps.workerActivity.snapshot());
  });

  return router;
}
