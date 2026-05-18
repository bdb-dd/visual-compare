import { Router } from 'express';
import type { Db } from '../db/client.js';
import { getJob } from '../services/queue.js';

export function jobsRouter(db: Db): Router {
  const router = Router();

  router.get('/:id', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const job = getJob(db, id);
    if (!job) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ job });
  });

  return router;
}
