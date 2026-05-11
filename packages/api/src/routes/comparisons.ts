import { Router } from 'express';
import type { Db } from '../db/client.js';
import { getComparison, listComparisons } from '../services/comparison.js';
import { getCapture } from '../services/capture.js';
import { imageUrl } from '../services/artifact-store.js';
import { toCaptureDto } from './captures.js';
import type {
  ComparisonDetailDto,
  ComparisonDto,
  ComparisonRow,
  DifferenceDto,
  DifferenceRow,
  UrlPairRow,
} from '../types.js';

export function toComparisonDto(row: ComparisonRow): ComparisonDto {
  return { ...row, im_diff_url: imageUrl(row.im_diff_sha256) };
}

function toDifferenceDto(row: DifferenceRow): DifferenceDto {
  let bbox: DifferenceDto['bounding_box'] = null;
  if (row.bounding_box_json) {
    try {
      bbox = JSON.parse(row.bounding_box_json);
    } catch {
      bbox = null;
    }
  }
  return {
    id: row.id,
    comparison_id: row.comparison_id,
    source: row.source,
    description: row.description,
    severity: row.severity,
    change_type: row.change_type,
    region_role: row.region_role,
    element_label: row.element_label,
    signature: row.signature,
    signature_version: row.signature_version,
    created_at: row.created_at,
    bounding_box: bbox,
  };
}

export function comparisonsRouter(db: Db): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const comparisons = listComparisons(db, {
      comparison_run_id: req.query.comparison_run_id as string | undefined,
      session_id: req.query.session_id as string | undefined,
      status: req.query.status as string | undefined,
    });
    res.json({ comparisons: comparisons.map(toComparisonDto) });
  });

  router.get('/:id', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const comparison = getComparison(db, id);
    if (!comparison) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const captureA = getCapture(db, comparison.capture_a_id);
    const captureB = getCapture(db, comparison.capture_b_id);
    if (!captureA || !captureB) {
      res.status(500).json({ error: 'inconsistent_state', message: 'capture rows missing' });
      return;
    }
    const urlPair = db
      .prepare<[string], UrlPairRow>('SELECT * FROM url_pairs WHERE id = ?')
      .get(comparison.url_pair_id);
    if (!urlPair) {
      res.status(500).json({ error: 'inconsistent_state', message: 'url_pair missing' });
      return;
    }
    const differences = db
      .prepare<[string], DifferenceRow>(
        'SELECT * FROM differences WHERE comparison_id = ? ORDER BY created_at',
      )
      .all(id);

    const detail: ComparisonDetailDto = {
      comparison: toComparisonDto(comparison),
      capture_a: toCaptureDto(captureA),
      capture_b: toCaptureDto(captureB),
      url_pair: urlPair,
      differences: differences.map(toDifferenceDto),
    };
    res.json(detail);
  });

  return router;
}
