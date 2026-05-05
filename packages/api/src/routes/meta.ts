import { Router } from 'express';
import { DEFAULT_VIEWPORTS, DEFAULT_VIEWPORT_NAME } from '../constants/viewports.js';
import { EQUIVALENCE_LEVELS, DEFAULT_EQUIVALENCE_LEVEL } from '../constants/equivalence.js';

export function metaRouter(): Router {
  const router = Router();

  router.get('/viewports', (_req, res) => {
    res.json({ viewports: DEFAULT_VIEWPORTS, default: DEFAULT_VIEWPORT_NAME });
  });

  router.get('/equivalence-levels', (_req, res) => {
    res.json({ levels: EQUIVALENCE_LEVELS, default: DEFAULT_EQUIVALENCE_LEVEL });
  });

  return router;
}
