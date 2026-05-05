import { Router } from 'express';
import type { Db } from '../db/client.js';
import { getCapture, listCaptures } from '../services/capture.js';
import { imageUrl } from '../services/artifact-store.js';
import type { CaptureDto, CaptureRow } from '../types.js';

export function toCaptureDto(row: CaptureRow): CaptureDto {
  return { ...row, screenshot_url: imageUrl(row.screenshot_sha256) };
}

export function capturesRouter(db: Db): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const captures = listCaptures(db, {
      capture_run_id: req.query.capture_run_id as string | undefined,
      session_id: req.query.session_id as string | undefined,
      url_pair_id: req.query.url_pair_id as string | undefined,
    });
    res.json({ captures: captures.map(toCaptureDto) });
  });

  router.get('/:id', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const capture = getCapture(db, id);
    if (!capture) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ capture: toCaptureDto(capture) });
  });

  return router;
}
