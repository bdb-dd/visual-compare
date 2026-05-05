import { Router } from 'express';
import { DEFAULT_VIEWPORTS, DEFAULT_VIEWPORT_NAME } from '../constants/viewports.js';
import { EQUIVALENCE_LEVELS, DEFAULT_EQUIVALENCE_LEVEL } from '../constants/equivalence.js';
import type { LmClient } from '../services/lm.js';

export interface MetaRouterDeps {
  lm?: LmClient;
}

export function metaRouter(deps: MetaRouterDeps = {}): Router {
  const router = Router();

  router.get('/viewports', (_req, res) => {
    res.json({ viewports: DEFAULT_VIEWPORTS, default: DEFAULT_VIEWPORT_NAME });
  });

  router.get('/equivalence-levels', (_req, res) => {
    res.json({ levels: EQUIVALENCE_LEVELS, default: DEFAULT_EQUIVALENCE_LEVEL });
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

  return router;
}
