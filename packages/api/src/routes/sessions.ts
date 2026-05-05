import { Router } from 'express';
import multer from 'multer';
import type { Db } from '../db/client.js';
import { parseSessionCsv } from '../services/csv.js';
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  listUrlPairs,
} from '../services/sessions.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MiB
});

export function sessionsRouter(db: Db): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ sessions: listSessions(db) });
  });

  router.post('/', upload.single('csv'), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'invalid_request', message: 'csv file is required' });
      return;
    }

    const text = req.file.buffer.toString('utf8');
    const result = parseSessionCsv(text);
    if (!result.ok) {
      res.status(400).json({
        error: 'invalid_csv',
        message: result.message,
        row_errors: result.row_errors,
      });
      return;
    }

    const name = (req.body?.name as string | undefined)?.trim() || req.file.originalname;
    const filename = req.file.originalname || 'upload.csv';

    const created = createSession(db, {
      name,
      csv_filename: filename,
      rows: result.rows,
    });

    res.status(201).json({
      session: created.session,
      url_pairs: created.url_pairs,
    });
  });

  router.get('/:id', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'id is required' });
      return;
    }
    const session = getSession(db, id);
    if (!session) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({
      session,
      url_pairs: listUrlPairs(db, id),
    });
  });

  router.delete('/:id', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'id is required' });
      return;
    }
    const deleted = deleteSession(db, id);
    if (!deleted) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
