import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { ArtifactStore } from './artifact-store.js';
import {
  compareAe,
  compareSsim,
  extractConnectedComponents,
} from './imagick.js';
import { parseConnectedComponents } from './connected-components.js';
import { computeMatchedAtLevel } from './equivalence.js';
import { isAtLeastAsStrict } from '../constants/equivalence.js';
import {
  isAnalyzeError,
  type AnalyzeOutcome,
  type LmClient,
} from './lm.js';
import { getSessionPrompt, type LmPromptInvocationReason } from './lm-prompts.js';
import type { JobQueue } from './queue.js';
import type {
  CaptureRow,
  ComparisonRow,
  ComparisonRunRow,
  EquivalenceLevelId,
  LmInvocationReason,
  MatchedAtLevel,
  MatchedDecidedBy,
} from '../types.js';
import { PIPELINE_VERSION } from '../constants/pipeline.js';

export const comparisonRunOptionsSchema = z.object({
  /** Session-wide target level. Single value; the pipeline records `matched_at_level` per comparison. */
  targetLevel: z.enum([
    'pixel-perfect',
    'strict',
    'tolerant',
    'loose',
  ]),
  /** When true, run the LM second-pass for comparisons that miss the target. */
  invokeLm: z.boolean().optional(),
  urlPairIds: z.array(z.string()).optional(),
  viewports: z.array(z.string()).optional(),
});

export type ComparisonRunOptionsParsed = z.output<typeof comparisonRunOptionsSchema>;

export interface ComparisonImagick {
  compareAe: typeof compareAe;
  compareSsim: typeof compareSsim;
  extractConnectedComponents: typeof extractConnectedComponents;
}

const realImagick: ComparisonImagick = {
  compareAe,
  compareSsim,
  extractConnectedComponents,
};

export interface ComparisonRunDeps {
  db: Db;
  queue: JobQueue;
  artifactStore: ArtifactStore;
  imagick?: ComparisonImagick;
  /**
   * LM Studio client. Required for `semantic` level and for ambiguity-band
   * tiebreaks; absence is treated as a hard error for those code paths.
   */
  lm?: LmClient;
}

export interface StartComparisonRunInput {
  sessionId: string;
  captureRunId: string;
  options: ComparisonRunOptionsParsed;
}

export interface StartComparisonRunResult {
  comparison_run_id: string;
  job_id: string;
  comparison_count: number;
}

interface PairKey {
  url_pair_id: string;
  viewport_name: string;
  capture_a: CaptureRow;
  capture_b: CaptureRow;
}

function pickMatchingCaptures(db: Db, captureRunId: string, opts: ComparisonRunOptionsParsed): PairKey[] {
  const captures = db
    .prepare<[string], CaptureRow>(
      `SELECT * FROM captures WHERE capture_run_id = ? AND status = 'complete'`,
    )
    .all(captureRunId);

  const byKey = new Map<string, { a?: CaptureRow; b?: CaptureRow }>();
  for (const c of captures) {
    const key = `${c.url_pair_id}::${c.viewport_name}`;
    const slot = byKey.get(key) ?? {};
    if (c.side === 'a') slot.a = c;
    else slot.b = c;
    byKey.set(key, slot);
  }

  const pickedPairs = opts.urlPairIds && opts.urlPairIds.length > 0
    ? new Set(opts.urlPairIds)
    : null;
  const pickedViewports = opts.viewports && opts.viewports.length > 0
    ? new Set(opts.viewports)
    : null;

  const out: PairKey[] = [];
  for (const [key, slot] of byKey) {
    if (!slot.a || !slot.b) continue;
    if (pickedPairs && !pickedPairs.has(slot.a.url_pair_id)) continue;
    if (pickedViewports && !pickedViewports.has(slot.a.viewport_name)) continue;
    void key;
    out.push({
      url_pair_id: slot.a.url_pair_id,
      viewport_name: slot.a.viewport_name,
      capture_a: slot.a,
      capture_b: slot.b,
    });
  }
  return out;
}

export interface ExplicitComparisonPair {
  url_pair_id: string;
  viewport_name: string;
  capture_a_id: string;
  capture_b_id: string;
}

export interface StartComparisonRunForPairsInput {
  sessionId: string;
  captureRunId: string;
  options: ComparisonRunOptionsParsed;
  pairs: ExplicitComparisonPair[];
}

export function startComparisonRun(
  deps: ComparisonRunDeps,
  input: StartComparisonRunInput,
): StartComparisonRunResult {
  const { db } = deps;
  const { sessionId, captureRunId, options } = input;

  // Confirm the capture run belongs to the session.
  const captureRun = db
    .prepare<[string, string], { id: string }>(
      'SELECT id FROM capture_runs WHERE id = ? AND session_id = ?',
    )
    .get(captureRunId, sessionId);
  if (!captureRun) {
    throw new Error(
      `capture_run ${captureRunId} not found in session ${sessionId}`,
    );
  }

  const pairs = pickMatchingCaptures(db, captureRunId, options);
  if (pairs.length === 0) {
    throw new Error('No matching A/B captures with status=complete were found.');
  }

  return startComparisonRunForPairs(deps, {
    sessionId,
    captureRunId,
    options,
    pairs: pairs.map((p) => ({
      url_pair_id: p.url_pair_id,
      viewport_name: p.viewport_name,
      capture_a_id: p.capture_a.id,
      capture_b_id: p.capture_b.id,
    })),
  });
}

/**
 * Lower-level entry point that takes an explicit list of capture pairs. The
 * evaluator uses this to pull pairs from the cache substrate (potentially
 * spanning multiple historical capture runs).
 */
export function startComparisonRunForPairs(
  deps: ComparisonRunDeps,
  input: StartComparisonRunForPairsInput,
): StartComparisonRunResult {
  const { db, queue } = deps;
  const { sessionId, captureRunId, options, pairs } = input;
  const imagick = deps.imagick ?? realImagick;

  if (pairs.length === 0) {
    throw new Error('startComparisonRunForPairs requires at least one pair');
  }

  const jobId = queue.createJob({ type: 'comparison', progress_total: pairs.length });
  const comparisonRunId = randomUUID();
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO comparison_runs
         (id, session_id, capture_run_id, job_id, options_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      comparisonRunId,
      sessionId,
      captureRunId,
      jobId,
      JSON.stringify(options),
      now,
    );
    const insertComparison = db.prepare(
      `INSERT INTO comparisons
         (id, comparison_run_id, url_pair_id, capture_a_id, capture_b_id,
          viewport_name, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    );
    for (const p of pairs) {
      insertComparison.run(
        randomUUID(),
        comparisonRunId,
        p.url_pair_id,
        p.capture_a_id,
        p.capture_b_id,
        p.viewport_name,
        now,
      );
    }
  });
  tx();

  queue.enqueue(jobId, async (ctx) => {
    const comparisons = db
      .prepare<[string], ComparisonRow>(
        `SELECT * FROM comparisons WHERE comparison_run_id = ? ORDER BY created_at`,
      )
      .all(comparisonRunId);
    const circuit: LmCircuit = {
      consecutiveFailures: 0,
      open: false,
      lastError: null,
      threshold: 2,
    };
    // Resolve session-scoped prompts once per run. The session config can be
    // edited mid-run, but we want every comparison in this run to use a
    // single, consistent prompt (and hence a stable cache key).
    const prompts = resolveSessionPrompts(db, sessionId);
    for (const c of comparisons) {
      await runOneComparison(
        deps,
        imagick,
        c,
        options.targetLevel,
        options.invokeLm ?? false,
        circuit,
        prompts,
      );
      ctx.incrementProgress();
    }
  });

  return {
    comparison_run_id: comparisonRunId,
    job_id: jobId,
    comparison_count: pairs.length,
  };
}

interface LmCircuit {
  consecutiveFailures: number;
  open: boolean;
  lastError: string | null;
  threshold: number;
}

type SessionPromptMap = Partial<Record<LmPromptInvocationReason, { id: string; text: string }>>;

function resolveSessionPrompts(db: Db, sessionId: string): SessionPromptMap {
  const out: SessionPromptMap = {};
  for (const reason of ['target_level_failure', 'ambiguous_pixel_result'] as const) {
    const row = getSessionPrompt(db, sessionId, reason);
    if (row) out[reason] = { id: row.prompt_id, text: row.prompt_text };
  }
  return out;
}

async function runOneComparison(
  deps: ComparisonRunDeps,
  imagick: ComparisonImagick,
  comparison: ComparisonRow,
  targetLevel: EquivalenceLevelId,
  invokeLm: boolean,
  circuit: LmCircuit,
  prompts: SessionPromptMap,
): Promise<void> {
  const { db, artifactStore } = deps;
  db.prepare(`UPDATE comparisons SET status = 'processing' WHERE id = ?`).run(comparison.id);

  const startedAt = Date.now();
  let diffTempPath: string | null = null;
  try {
    const captureA = db
      .prepare<[string], CaptureRow>('SELECT * FROM captures WHERE id = ?')
      .get(comparison.capture_a_id);
    const captureB = db
      .prepare<[string], CaptureRow>('SELECT * FROM captures WHERE id = ?')
      .get(comparison.capture_b_id);
    if (!captureA?.screenshot_sha256 || !captureB?.screenshot_sha256) {
      throw new Error('Capture rows are missing screenshot hashes.');
    }
    const aPath = artifactStore.absolutePathFor(captureA.screenshot_sha256);
    const bPath = artifactStore.absolutePathFor(captureB.screenshot_sha256);

    const tempDir = join(tmpdir(), 'visual-compare-diffs');
    await mkdir(tempDir, { recursive: true });
    diffTempPath = join(tempDir, `${randomUUID()}.png`);

    const ae = await imagick.compareAe(aPath, bPath, diffTempPath);
    const ssim = await imagick.compareSsim(aPath, bPath);

    // Write the diff into the content-addressed store.
    const { sha256: diffHash, byteSize: diffBytes } =
      await artifactStore.writeImage(diffTempPath);
    diffTempPath = null;
    const diffPath = artifactStore.absolutePathFor(diffHash);

    // Connected components.
    const cc = await imagick.extractConnectedComponents(diffPath);
    const regions = parseConnectedComponents(cc.raw, {
      imageWidth: ae.width,
      imageHeight: ae.height,
      format: cc.format,
    });

    const componentCount = regions.length;
    const totalArea = ae.width * ae.height;
    const bboxAreaPct = regions.reduce((sum, r) => sum + r.area, 0) / Math.max(1, totalArea) * 100;

    const { pixelMatchedAtLevel, inTargetAmbiguityBand } = computeMatchedAtLevel({
      changedPixelPercentage: ae.changedPixelPercentage,
      ssim,
      targetLevel,
    });

    // LM invocation rules (at most one LM call per comparison):
    //   1. Target's ambiguity band → `ambiguous_pixel_result` (tiebreaker).
    //   2. Pixel didn't reach target AND user opted in to LM second-pass
    //      → `target_level_failure`.
    // Otherwise the pixel verdict stands.
    let lmInvocationReason: LmInvocationReason | null = null;
    if (inTargetAmbiguityBand) {
      lmInvocationReason = 'ambiguous_pixel_result';
    } else if (invokeLm && !isAtLeastAsStrict(pixelMatchedAtLevel, targetLevel)) {
      lmInvocationReason = 'target_level_failure';
    }

    let lmOutcome: AnalyzeOutcome | null = null;
    if (lmInvocationReason !== null) {
      if (!deps.lm) {
        throw new Error(
          `LM Studio is required (reason: ${lmInvocationReason}) but no LM client was configured. Set LM_STUDIO_BASE_URL and load a model.`,
        );
      }
      // Circuit breaker: skip if a prior comparison in this run already
      // exhausted the failure threshold.
      if (circuit.open) {
        throw new Error(
          `lm_circuit_open: skipped LM call after ${circuit.threshold} consecutive failures in this run. Last error: ${circuit.lastError ?? 'unknown'}`,
        );
      }
      // Look up the session-scoped prompt for this invocation reason. If
      // there's no row (e.g. `manual_retry`, which the seed doesn't cover),
      // fall through and let the LM client use its env-derived default.
      const sessionPrompt =
        lmInvocationReason === 'target_level_failure' || lmInvocationReason === 'ambiguous_pixel_result'
          ? prompts[lmInvocationReason]
          : undefined;
      lmOutcome = await deps.lm.analyze({
        aPath,
        bPath,
        diffPath,
        level: targetLevel,
        invocationReason: lmInvocationReason,
        changedPixelPercentage: ae.changedPixelPercentage,
        ssim,
        prompt: sessionPrompt,
      });
      if (isAnalyzeError(lmOutcome)) {
        circuit.consecutiveFailures += 1;
        circuit.lastError = lmOutcome.message;
        if (circuit.consecutiveFailures >= circuit.threshold) {
          circuit.open = true;
        }
        throw new Error(`LM Studio failed: ${lmOutcome.message}`);
      }
      // Successful LM call → reset breaker.
      circuit.consecutiveFailures = 0;
      circuit.lastError = null;
    }

    // Final matched_at_level:
    //   - LM "equivalent" promotes to target.
    //   - LM "different" leaves it at the pixel walk's result (necessarily
    //     weaker than target; LM can't downgrade further than pixel said).
    //   - No LM: pixel result stands.
    const lmEquivalent = lmOutcome && !isAnalyzeError(lmOutcome)
      ? lmOutcome.parsed.equivalent
      : null;
    let matchedAtLevel: MatchedAtLevel = pixelMatchedAtLevel;
    let matchedDecidedBy: MatchedDecidedBy = 'pixel';
    if (lmEquivalent !== null) {
      matchedDecidedBy = 'lm';
      if (lmEquivalent) matchedAtLevel = targetLevel;
      // LM "different" → keep pixelMatchedAtLevel.
    }

    // `im_determined_equivalent` records whether pixel rules alone reached
    // the target. It's a diagnostic — the load-bearing field is matched_at_level.
    const imDeterminedEquivalentForTarget = isAtLeastAsStrict(
      pixelMatchedAtLevel,
      targetLevel,
    );

    const completedAt = new Date().toISOString();
    db.transaction(() => {
      db.prepare(
        `UPDATE comparisons SET
           status = 'complete',
           changed_pixel_percentage = ?,
           ssim = ?,
           bounding_box_area_percentage = ?,
           connected_component_count = ?,
           im_diff_sha256 = ?,
           im_diff_byte_size = ?,
           im_determined_equivalent = ?,
           matched_at_level = ?,
           matched_decided_by = ?,
           lm_invocation_reason = ?,
           lm_model = ?,
           lm_prompt_version = ?,
           lm_diff_summary = ?,
           lm_confidence = ?,
           lm_response_json = ?,
           lm_determined_equivalent = ?,
           duration_ms = ?,
           completed_at = ?
         WHERE id = ?`,
      ).run(
        ae.changedPixelPercentage,
        ssim,
        bboxAreaPct,
        componentCount,
        diffHash,
        diffBytes,
        imDeterminedEquivalentForTarget ? 1 : 0,
        matchedAtLevel,
        matchedDecidedBy,
        lmInvocationReason,
        lmOutcome && !isAnalyzeError(lmOutcome) ? lmOutcome.model : null,
        lmOutcome && !isAnalyzeError(lmOutcome) ? lmOutcome.promptVersion : null,
        lmOutcome && !isAnalyzeError(lmOutcome) ? lmOutcome.parsed.summary : null,
        lmOutcome && !isAnalyzeError(lmOutcome) ? lmOutcome.parsed.confidence : null,
        lmOutcome && !isAnalyzeError(lmOutcome) ? lmOutcome.rawText : null,
        lmEquivalent === null ? null : lmEquivalent ? 1 : 0,
        Date.now() - startedAt,
        completedAt,
        comparison.id,
      );

      const insertDiff = db.prepare(
        `INSERT INTO differences
           (id, comparison_id, source, description, severity, bounding_box_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of regions) {
        insertDiff.run(
          randomUUID(),
          comparison.id,
          'imagick',
          `Region of ${r.area}px${r.color ? ` (${r.color})` : ''}`,
          null,
          JSON.stringify(r.bbox_percent),
          completedAt,
        );
      }
      if (lmOutcome && !isAnalyzeError(lmOutcome)) {
        for (const d of lmOutcome.parsed.differences) {
          insertDiff.run(
            randomUUID(),
            comparison.id,
            'lm',
            d.description,
            d.severity,
            JSON.stringify(d.boundingBox),
            completedAt,
          );
        }
      }

      // Cache upserts. Pixel cache is keyed on the ordered capture-sha pair +
      // pipeline_version; LM cache adds prompt_id, model_id, and the
      // invocation reason because the LM is prompted differently in
      // semantic_mode vs ambiguity tiebreak.
      db.prepare(
        `INSERT INTO pixel_compare_cache
           (capture_a_sha, capture_b_sha, pipeline_version,
            changed_pct, ssim, bbox_area_pct, component_count,
            im_diff_sha256, comparison_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (capture_a_sha, capture_b_sha, pipeline_version) DO UPDATE SET
           changed_pct     = excluded.changed_pct,
           ssim            = excluded.ssim,
           bbox_area_pct   = excluded.bbox_area_pct,
           component_count = excluded.component_count,
           im_diff_sha256  = excluded.im_diff_sha256,
           comparison_id   = excluded.comparison_id,
           created_at      = excluded.created_at`,
      ).run(
        captureA.screenshot_sha256,
        captureB.screenshot_sha256,
        PIPELINE_VERSION,
        ae.changedPixelPercentage,
        ssim,
        bboxAreaPct,
        componentCount,
        diffHash,
        comparison.id,
        completedAt,
      );

      if (lmInvocationReason && lmOutcome && !isAnalyzeError(lmOutcome)) {
        db.prepare(
          `INSERT INTO lm_verdict_cache
             (capture_a_sha, capture_b_sha, prompt_id, model_id,
              invocation_reason, pipeline_version,
              verdict, summary, confidence, comparison_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (capture_a_sha, capture_b_sha, prompt_id, model_id, invocation_reason, pipeline_version) DO UPDATE SET
             verdict       = excluded.verdict,
             summary       = excluded.summary,
             confidence    = excluded.confidence,
             comparison_id = excluded.comparison_id,
             created_at    = excluded.created_at`,
        ).run(
          captureA.screenshot_sha256,
          captureB.screenshot_sha256,
          lmOutcome.promptVersion,
          lmOutcome.model,
          lmInvocationReason,
          PIPELINE_VERSION,
          lmOutcome.parsed.equivalent ? 1 : 0,
          lmOutcome.parsed.summary,
          lmOutcome.parsed.confidence,
          comparison.id,
          completedAt,
        );
      }
    })();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE comparisons
         SET status = 'error', error_message = ?, completed_at = ?, duration_ms = ?
       WHERE id = ?`,
    ).run(message, new Date().toISOString(), Date.now() - startedAt, comparison.id);
  } finally {
    if (diffTempPath) await unlink(diffTempPath).catch(() => {});
  }
}

export function getComparisonRun(db: Db, id: string): ComparisonRunRow | null {
  const row = db
    .prepare<[string], ComparisonRunRow>('SELECT * FROM comparison_runs WHERE id = ?')
    .get(id);
  return row ?? null;
}

export function listComparisonRuns(db: Db, sessionId?: string): ComparisonRunRow[] {
  if (sessionId) {
    return db
      .prepare<[string], ComparisonRunRow>(
        `SELECT * FROM comparison_runs WHERE session_id = ? ORDER BY created_at DESC`,
      )
      .all(sessionId);
  }
  return db
    .prepare<unknown[], ComparisonRunRow>(
      'SELECT * FROM comparison_runs ORDER BY created_at DESC',
    )
    .all();
}

export interface ComparisonsQuery {
  comparison_run_id?: string;
  session_id?: string;
  status?: string;
}

export function listComparisons(db: Db, q: ComparisonsQuery): ComparisonRow[] {
  const where: string[] = [];
  const params: string[] = [];
  if (q.comparison_run_id) {
    where.push('cr.comparison_run_id = ?');
    params.push(q.comparison_run_id);
  }
  if (q.session_id) {
    where.push(
      'cr.comparison_run_id IN (SELECT id FROM comparison_runs WHERE session_id = ?)',
    );
    params.push(q.session_id);
  }
  if (q.status) {
    where.push('cr.status = ?');
    params.push(q.status);
  }
  const sql = `SELECT cr.* FROM comparisons cr${
    where.length ? ' WHERE ' + where.join(' AND ') : ''
  } ORDER BY cr.created_at`;
  return db.prepare<string[], ComparisonRow>(sql).all(...params);
}

export function getComparison(db: Db, id: string): ComparisonRow | null {
  const row = db
    .prepare<[string], ComparisonRow>('SELECT * FROM comparisons WHERE id = ?')
    .get(id);
  return row ?? null;
}
