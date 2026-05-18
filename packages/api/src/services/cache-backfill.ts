import type { Db } from '../db/client.js';
import { captureOptsHashFor } from './capture-opts-hash.js';
import { captureRunOptionsSchema } from './capture.js';
import { pipelineVersionFor } from '../constants/pipeline.js';
import {
  DEFAULT_EQUIVALENCE_LEVEL,
  EQUIVALENCE_LEVEL_IDS,
} from '../constants/equivalence.js';
import type { EquivalenceLevelId } from '../types.js';

function parseTargetLevel(optionsJson: string): EquivalenceLevelId {
  try {
    const parsed = JSON.parse(optionsJson) as { targetLevel?: unknown };
    if (
      typeof parsed.targetLevel === 'string' &&
      (EQUIVALENCE_LEVEL_IDS as string[]).includes(parsed.targetLevel)
    ) {
      return parsed.targetLevel as EquivalenceLevelId;
    }
  } catch {
    // fall through
  }
  return DEFAULT_EQUIVALENCE_LEVEL;
}

export interface BackfillResult {
  capture_cache_inserted: number;
  pixel_compare_cache_inserted: number;
  lm_verdict_cache_inserted: number;
  capture_runs_skipped: number;
}

/**
 * One-shot backfill of legacy run rows into the cache tables. Idempotent:
 * uses INSERT OR IGNORE so already-cached rows are left alone, which means
 * this can run unconditionally on every startup without clobbering more
 * recent live upserts.
 *
 * Cache tables are tagged with the current PIPELINE_VERSION. Bumping that
 * version naturally orphans these backfilled rows (they remain on the old
 * version and won't satisfy lookups for the new one), which is the design.
 */
export function runCacheBackfill(db: Db): BackfillResult {
  const result: BackfillResult = {
    capture_cache_inserted: 0,
    pixel_compare_cache_inserted: 0,
    lm_verdict_cache_inserted: 0,
    capture_runs_skipped: 0,
  };

  const insertCapture = db.prepare(
    `INSERT OR IGNORE INTO capture_cache
       (url, viewport_name, capture_opts_hash, screenshot_sha256, capture_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const captureRuns = db
    .prepare<unknown[], { id: string; options_json: string }>(
      'SELECT id, options_json FROM capture_runs',
    )
    .all();

  const completeCaptures = db.prepare<
    [string],
    {
      id: string;
      url: string;
      viewport_name: string;
      screenshot_sha256: string;
      captured_at: string | null;
      created_at: string;
    }
  >(
    `SELECT id, url, viewport_name, screenshot_sha256, captured_at, created_at
       FROM captures
      WHERE capture_run_id = ?
        AND status = 'complete'
        AND screenshot_sha256 IS NOT NULL`,
  );

  for (const run of captureRuns) {
    let options;
    try {
      options = captureRunOptionsSchema.parse(JSON.parse(run.options_json));
    } catch {
      result.capture_runs_skipped += 1;
      continue;
    }
    const viewportByName = new Map(options.viewports.map((v) => [v.name, v]));
    for (const cap of completeCaptures.all(run.id)) {
      const viewport = viewportByName.get(cap.viewport_name);
      if (!viewport) continue;
      const optsHash = captureOptsHashFor(viewport, options);
      const info = insertCapture.run(
        cap.url,
        cap.viewport_name,
        optsHash,
        cap.screenshot_sha256,
        cap.id,
        cap.captured_at ?? cap.created_at,
      );
      if (info.changes > 0) result.capture_cache_inserted += 1;
    }
  }

  const insertPixel = db.prepare(
    `INSERT OR IGNORE INTO pixel_compare_cache
       (capture_a_sha, capture_b_sha, pipeline_version,
        changed_pct, ssim, bbox_area_pct, component_count,
        im_diff_sha256, comparison_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Backfill leaves user_instruction_id at the column default (''). Legacy
  // rows predate the user-instruction template hash, so we can't reconstruct
  // the id; the empty-string default ensures lookups under any current
  // template id naturally miss and the LM is re-invoked next eval.
  const insertLm = db.prepare(
    `INSERT OR IGNORE INTO lm_verdict_cache
       (capture_a_sha, capture_b_sha, prompt_id, model_id,
        invocation_reason, pipeline_version,
        verdict, summary, confidence, comparison_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const completeComparisons = db
    .prepare<
      unknown[],
      {
        id: string;
        capture_a_id: string;
        capture_b_id: string;
        changed_pixel_percentage: number | null;
        ssim: number | null;
        bounding_box_area_percentage: number | null;
        connected_component_count: number | null;
        im_diff_sha256: string | null;
        lm_invocation_reason: string | null;
        lm_model: string | null;
        lm_prompt_version: string | null;
        lm_diff_summary: string | null;
        lm_confidence: number | null;
        lm_determined_equivalent: number | null;
        completed_at: string | null;
        created_at: string;
        run_options_json: string | null;
      }
    >(
      `SELECT c.id, c.capture_a_id, c.capture_b_id,
              c.changed_pixel_percentage, c.ssim, c.bounding_box_area_percentage,
              c.connected_component_count, c.im_diff_sha256,
              c.lm_invocation_reason, c.lm_model, c.lm_prompt_version,
              c.lm_diff_summary, c.lm_confidence, c.lm_determined_equivalent,
              c.completed_at, c.created_at,
              cr.options_json AS run_options_json
         FROM comparisons c
         LEFT JOIN comparison_runs cr ON cr.id = c.comparison_run_id
        WHERE c.status = 'complete'`,
    )
    .all();

  const captureSha = db.prepare<[string], { screenshot_sha256: string | null }>(
    'SELECT screenshot_sha256 FROM captures WHERE id = ?',
  );

  for (const cmp of completeComparisons) {
    const a = captureSha.get(cmp.capture_a_id);
    const b = captureSha.get(cmp.capture_b_id);
    if (!a?.screenshot_sha256 || !b?.screenshot_sha256) continue;
    const ts = cmp.completed_at ?? cmp.created_at;
    const targetLevel = cmp.run_options_json
      ? parseTargetLevel(cmp.run_options_json)
      : DEFAULT_EQUIVALENCE_LEVEL;
    const pipelineVersion = pipelineVersionFor(targetLevel);

    const pixelInfo = insertPixel.run(
      a.screenshot_sha256,
      b.screenshot_sha256,
      pipelineVersion,
      cmp.changed_pixel_percentage,
      cmp.ssim,
      cmp.bounding_box_area_percentage,
      cmp.connected_component_count,
      cmp.im_diff_sha256,
      cmp.id,
      ts,
    );
    if (pixelInfo.changes > 0) result.pixel_compare_cache_inserted += 1;

    if (
      cmp.lm_invocation_reason &&
      cmp.lm_model &&
      cmp.lm_prompt_version &&
      cmp.lm_determined_equivalent !== null
    ) {
      const lmInfo = insertLm.run(
        a.screenshot_sha256,
        b.screenshot_sha256,
        cmp.lm_prompt_version,
        cmp.lm_model,
        cmp.lm_invocation_reason,
        pipelineVersion,
        cmp.lm_determined_equivalent,
        cmp.lm_diff_summary,
        cmp.lm_confidence,
        cmp.id,
        ts,
      );
      if (lmInfo.changes > 0) result.lm_verdict_cache_inserted += 1;
    }
  }

  return result;
}
