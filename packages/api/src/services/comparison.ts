import { randomUUID } from 'node:crypto';
import { mkdir, stat, unlink } from 'node:fs/promises';
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
import { computeSignature } from './cluster-signature.js';
import { createLimit } from './concurrency.js';
import { getEquivalenceLevel, isAtLeastAsStrict } from '../constants/equivalence.js';
import {
  isAnalyzeError,
  userInstructionTemplateId,
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
  PairOutcome,
} from '../types.js';
import { pipelineVersionFor } from '../constants/pipeline.js';

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
  /**
   * How many comparisons to process in parallel within a single run. Each
   * comparison is largely independent (own diff temp file, own
   * artifact-store write, own DB transaction), so the loop scales close to
   * linearly up to ~CPU/2 before IM CPU contention or SQLite write
   * serialization start to bite. Default 4 is a reasonable balance for
   * typical 8-core boxes that may also be running Playwright captures
   * alongside; bump to 8+ for dedicated comparison-only runs.
   */
  concurrency: z.number().int().min(1).max(10).default(4),
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
  /**
   * Optional signal for cooperative cancellation. The limit-loop checks
   * `aborted` before each new comparison; in-flight ImageMagick / LM work
   * runs to completion.
   */
  signal?: AbortSignal;
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
  const { sessionId, captureRunId, options, pairs, signal } = input;
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
    // Bounded parallelism. Each runOneComparison owns its temp diff path,
    // its writeImage call, and its DB transactions, so they don't trample
    // each other; SQLite serializes writers internally. The shared circuit
    // breaker is mutated under a JS-single-threaded model — sequential
    // increment/check is safe between awaits.
    const limit = createLimit(options.concurrency);
    await Promise.all(
      comparisons.map((c) =>
        limit(async () => {
          // Cooperative cancel: skip pending comparisons once the evaluation
          // is aborted. The currently-running ones finish — ImageMagick
          // subprocesses don't take an AbortSignal in this codepath.
          if (signal?.aborted) {
            db.prepare(
              `UPDATE comparisons SET status = 'error', completed_at = ?
                 WHERE id = ? AND status = 'pending'`,
            ).run(new Date().toISOString(), c.id);
            ctx.incrementProgress();
            return;
          }
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
        }),
      ),
    );
  });

  return {
    comparison_run_id: comparisonRunId,
    job_id: jobId,
    comparison_count: pairs.length,
  };
}

function safeParseBbox(json: string | null): import('../types.js').BoundingBoxPercent | null {
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as Partial<import('../types.js').BoundingBoxPercent>;
    if (
      typeof obj.x === 'number' && typeof obj.y === 'number' &&
      typeof obj.width === 'number' && typeof obj.height === 'number'
    ) {
      return { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
    }
  } catch { /* fall through */ }
  return null;
}

function derivePairOutcome(a: CaptureRow, b: CaptureRow): PairOutcome {
  const aMissing = a.is_missing === 1;
  const bMissing = b.is_missing === 1;
  if (aMissing && bMissing) return 'both_missing';
  if (aMissing) return 'a_missing';
  if (bMissing) return 'b_missing';
  return 'both_present';
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

    // Missing-page short-circuit. When either side rendered as a 404 / soft-404
    // the visual diff is meaningless (real-page-vs-error-page produces a wall
    // of noise). Skip compareAe/SSIM/CC entirely; record `pair_outcome` so the
    // results UI can filter / badge the row distinctly. We intentionally don't
    // populate the pixel cache for these — they're not "verdicts" the cache
    // can serve.
    const pairOutcome = derivePairOutcome(captureA, captureB);
    if (pairOutcome !== 'both_present') {
      const completedAt = new Date().toISOString();
      db.prepare(
        `UPDATE comparisons SET
           status = 'complete',
           pair_outcome = ?,
           duration_ms = ?,
           completed_at = ?
         WHERE id = ?`,
      ).run(pairOutcome, Date.now() - startedAt, completedAt, comparison.id);
      return;
    }

    const aPath = artifactStore.absolutePathFor(captureA.screenshot_sha256);
    const bPath = artifactStore.absolutePathFor(captureB.screenshot_sha256);

    // Pixel-cache short-circuit. When a prior comparison run already
    // produced the IM verdict for this capture pair at the current pipeline
    // version (Phase 1 of the persistence split caches it independently of
    // LM outcome), skip the IM pipeline entirely and just transfer the
    // cached values onto this comparison row. This is the fast path for
    // LM-only retries — after fixing LM Studio, re-evaluating the rows that
    // failed only on the LM side now finishes in seconds instead of
    // re-running blur/compare/CC for every pair.
    const pipelineVersion = pipelineVersionFor(targetLevel);
    type CachedPixelRow = {
      changed_pct: number | null;
      ssim: number | null;
      bbox_area_pct: number | null;
      component_count: number | null;
      im_diff_sha256: string | null;
      comparison_id: string;
    };
    const cachedPixel = db
      .prepare<[string, string, string], CachedPixelRow>(
        `SELECT changed_pct, ssim, bbox_area_pct, component_count, im_diff_sha256, comparison_id
           FROM pixel_compare_cache
          WHERE capture_a_sha = ? AND capture_b_sha = ? AND pipeline_version = ?`,
      )
      .get(captureA.screenshot_sha256, captureB.screenshot_sha256, pipelineVersion);

    interface ImSnapshot {
      changedPct: number;
      ssim: number;
      bboxAreaPct: number;
      componentCount: number;
      diffHash: string;
      diffBytes: number;
      /** Pre-encoded `differences` rows ready for INSERT against this comparison's id. */
      regionsToInsert: { description: string; bounding_box_json: string }[];
      /** True when the IM pipeline was skipped. */
      cacheHit: boolean;
    }

    let im: ImSnapshot;
    if (cachedPixel?.im_diff_sha256) {
      // Cache hit. Pull regions from the prior comparison's differences
      // rows so the detail view for THIS comparison still renders bbox
      // overlays. The rows are already in percent terms — no recompute.
      const priorRegions = db
        .prepare<
          [string],
          { description: string | null; bounding_box_json: string | null }
        >(
          `SELECT description, bounding_box_json
             FROM differences
            WHERE comparison_id = ? AND source = 'imagick'`,
        )
        .all(cachedPixel.comparison_id);
      let diffBytes = 0;
      try {
        const s = await stat(artifactStore.absolutePathFor(cachedPixel.im_diff_sha256));
        diffBytes = s.size;
      } catch {
        // Diff file is gone (artifact pruned?); leave size 0 — the row
        // still has im_diff_sha256 so the UI's image lookup will 404
        // explicitly rather than silently rendering wrong.
      }
      im = {
        changedPct: cachedPixel.changed_pct ?? 0,
        ssim: cachedPixel.ssim ?? 0,
        bboxAreaPct: cachedPixel.bbox_area_pct ?? 0,
        componentCount: cachedPixel.component_count ?? 0,
        diffHash: cachedPixel.im_diff_sha256,
        diffBytes,
        regionsToInsert: priorRegions
          .filter((r) => r.bounding_box_json !== null)
          .map((r) => ({
            description: r.description ?? '',
            bounding_box_json: r.bounding_box_json!,
          })),
        cacheHit: true,
      };
    } else {
      const tempDir = join(tmpdir(), 'visual-compare-diffs');
      await mkdir(tempDir, { recursive: true });
      diffTempPath = join(tempDir, `${randomUUID()}.png`);

      // Run the diff branch (compareAe → writeImage → extractCC) in parallel
      // with SSIM. SSIM operates on the unblurred originals and is
      // independent of compareAe's output, so it doesn't need to wait. SSIM
      // is the dominant single step (~1.1s on a 1440×900 capture vs ~0.2s
      // for the entire diff branch on cached blurs), so overlapping it
      // with the diff/CC work cuts per-comparison wall time roughly in half.
      const tolerance = getEquivalenceLevel(targetLevel).tolerance;
      const diffBranchPath = diffTempPath;
      const diffBranch = (async () => {
        const ae = await imagick.compareAe(aPath, bPath, diffBranchPath, tolerance);
        const { sha256: diffHash, byteSize: diffBytes } =
          await artifactStore.writeImage(diffBranchPath);
        const diffPathLocal = artifactStore.absolutePathFor(diffHash);
        const cc = await imagick.extractConnectedComponents(diffPathLocal);
        const regions = parseConnectedComponents(cc.raw, {
          imageWidth: ae.width,
          imageHeight: ae.height,
          format: cc.format,
        });
        return { ae, diffHash, diffBytes, regions };
      })();
      const [diffResult, ssimResult] = await Promise.all([
        diffBranch,
        imagick.compareSsim(aPath, bPath),
      ]);
      // Ownership of diffTempPath transferred to artifactStore.writeImage.
      diffTempPath = null;
      const totalArea = diffResult.ae.width * diffResult.ae.height;
      im = {
        changedPct: diffResult.ae.changedPixelPercentage,
        ssim: ssimResult,
        bboxAreaPct:
          (diffResult.regions.reduce((sum, r) => sum + r.area, 0) /
            Math.max(1, totalArea)) *
          100,
        componentCount: diffResult.regions.length,
        diffHash: diffResult.diffHash,
        diffBytes: diffResult.diffBytes,
        regionsToInsert: diffResult.regions.map((r) => ({
          description: `Region of ${r.area}px${r.color ? ` (${r.color})` : ''}`,
          bounding_box_json: JSON.stringify(r.bbox_percent),
        })),
        cacheHit: false,
      };
    }

    const diffPath = artifactStore.absolutePathFor(im.diffHash);
    const ssim = im.ssim;

    const { pixelMatchedAtLevel, inTargetAmbiguityBand } = computeMatchedAtLevel({
      changedPixelPercentage: im.changedPct,
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

    // `im_determined_equivalent` records whether pixel rules alone reached
    // the target. It's a diagnostic — the load-bearing field is matched_at_level.
    const imDeterminedEquivalentForTarget = isAtLeastAsStrict(
      pixelMatchedAtLevel,
      targetLevel,
    );

    // ── Phase 1: persist the IM verdict ────────────────────────────────────
    // Done BEFORE the LM call so an LM failure (transport / context-size /
    // circuit-open) doesn't waste the upstream IM work. The row is marked
    // 'complete' with matched_decided_by='pixel'; the LM phase below may
    // promote matched_at_level and flip matched_decided_by to 'lm' on
    // success. lm_invocation_reason is set here as a record of "LM was
    // attempted (or planned) for this row" — useful when the LM phase
    // errors and you want to grep which rows have a missing verdict.
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
           matched_decided_by = 'pixel',
           lm_invocation_reason = ?,
           duration_ms = ?,
           completed_at = ?
         WHERE id = ?`,
      ).run(
        im.changedPct,
        ssim,
        im.bboxAreaPct,
        im.componentCount,
        im.diffHash,
        im.diffBytes,
        imDeterminedEquivalentForTarget ? 1 : 0,
        pixelMatchedAtLevel,
        lmInvocationReason,
        Date.now() - startedAt,
        completedAt,
        comparison.id,
      );

      const insertDiff = db.prepare(
        `INSERT INTO differences
           (id, comparison_id, source, description, severity, bounding_box_json,
            change_type, region_role, element_label, signature, signature_version,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      );
      for (const r of im.regionsToInsert) {
        // Imagick rows have no LM taxonomy tags — always v0 fallback signature.
        const bbox = safeParseBbox(r.bounding_box_json);
        const sig = computeSignature({
          source: 'imagick',
          viewport_name: comparison.viewport_name,
          bbox,
          change_type: null,
          region_role: null,
          element_label: null,
        });
        insertDiff.run(
          randomUUID(),
          comparison.id,
          'imagick',
          r.description,
          null,
          r.bounding_box_json,
          sig?.signature ?? null,
          sig?.signature_version ?? null,
          completedAt,
        );
      }

      // Pixel cache is keyed on the ordered capture-sha pair + pipeline
      // version. Writing it here (independent of LM outcome) means a
      // subsequent re-eval after an LM fix only needs to re-run LM, not
      // the whole IM pipeline.
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
        pipelineVersion,
        im.changedPct,
        ssim,
        im.bboxAreaPct,
        im.componentCount,
        im.diffHash,
        comparison.id,
        completedAt,
      );
    })();

    // ── Phase 2: optional LM second pass ───────────────────────────────────
    // Failures here log + maybe-trip the circuit breaker, but do NOT mark
    // the row as 'error'. The IM verdict from phase 1 stands; on next
    // re-eval the planner sees the lm_verdict_cache miss and re-queues
    // for an LM-only retry.
    if (lmInvocationReason !== null) {
      try {
        if (!deps.lm) {
          throw new Error(
            `LM Studio is required (reason: ${lmInvocationReason}) but no LM client was configured. Set LM_STUDIO_BASE_URL and load a model.`,
          );
        }
        if (circuit.open) {
          throw new Error(
            `lm_circuit_open: skipped LM call after ${circuit.threshold} consecutive failures in this run. Last error: ${circuit.lastError ?? 'unknown'}`,
          );
        }
        const sessionPrompt =
          lmInvocationReason === 'target_level_failure' || lmInvocationReason === 'ambiguous_pixel_result'
            ? prompts[lmInvocationReason]
            : undefined;
        const lmOutcome = await deps.lm.analyze({
          aPath,
          bPath,
          diffPath,
          level: targetLevel,
          invocationReason: lmInvocationReason,
          changedPixelPercentage: im.changedPct,
          ssim,
          prompt: sessionPrompt,
        });
        if (isAnalyzeError(lmOutcome)) {
          circuit.consecutiveFailures += 1;
          circuit.lastError = lmOutcome.message;
          if (circuit.consecutiveFailures >= circuit.threshold) {
            circuit.open = true;
          }
          // eslint-disable-next-line no-console
          console.warn(
            `[lm] comparison ${comparison.id} LM call failed: ${lmOutcome.message}`,
          );
          // Fall through — IM verdict from phase 1 stands.
        } else {
          // Success: reset breaker and persist LM verdict.
          circuit.consecutiveFailures = 0;
          circuit.lastError = null;
          const lmEquivalent = lmOutcome.parsed.equivalent;
          // IM-area guardrail. The vision LM sometimes rubber-stamps
          // pairs as "equivalent" while looking past large mid-page
          // content blocks (observed: pairs with ~40% of page area in IM
          // regions still tagged equivalent on the basis of "timestamps +
          // breadcrumb"). When the IM pipeline flagged enough area that
          // a calm reading would *have* to describe substantive
          // differences, downgrade an LM "equivalent" verdict back to
          // the pixel walk's level. The raw LM verdict stays in
          // lm_determined_equivalent for diagnostics; matched_decided_by
          // flips to 'pixel' since the row's effective level comes from
          // the pixel walk after the override.
          const imAreaOverride =
            lmEquivalent && im.bboxAreaPct > IM_AREA_OVERRIDE_THRESHOLD_PCT;
          const effectivelyEquivalent = lmEquivalent && !imAreaOverride;
          // LM "equivalent" promotes to target; "different" (or
          // overridden-equivalent) leaves the verdict at the pixel walk's
          // result. LM can't downgrade past what pixel reported.
          const finalMatchedAtLevel: MatchedAtLevel = effectivelyEquivalent
            ? targetLevel
            : pixelMatchedAtLevel;
          const finalDecidedBy: MatchedDecidedBy = imAreaOverride ? 'pixel' : 'lm';
          const summaryOut = imAreaOverride
            ? `[im_area_override ${im.bboxAreaPct.toFixed(1)}%>${IM_AREA_OVERRIDE_THRESHOLD_PCT}%] ${lmOutcome.parsed.summary}`
            : lmOutcome.parsed.summary;
          db.transaction(() => {
            db.prepare(
              `UPDATE comparisons SET
                 matched_at_level = ?,
                 matched_decided_by = ?,
                 lm_model = ?,
                 lm_prompt_version = ?,
                 lm_diff_summary = ?,
                 lm_confidence = ?,
                 lm_response_json = ?,
                 lm_determined_equivalent = ?
               WHERE id = ?`,
            ).run(
              finalMatchedAtLevel,
              finalDecidedBy,
              lmOutcome.model,
              lmOutcome.promptVersion,
              summaryOut,
              lmOutcome.parsed.confidence,
              lmOutcome.rawText,
              lmEquivalent ? 1 : 0,
              comparison.id,
            );
            const insertDiff = db.prepare(
              `INSERT INTO differences
                 (id, comparison_id, source, description, severity, bounding_box_json,
                  change_type, region_role, element_label,
                  signature, signature_version, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            );
            for (const d of lmOutcome.parsed.differences) {
              // LM rows get v1 signature when the v3 prompt populated the
              // taxonomy fields; falls back to v0 otherwise (v2 prompt path).
              const sig = computeSignature({
                source: 'lm',
                viewport_name: comparison.viewport_name,
                bbox: d.boundingBox,
                change_type: d.changeType ?? null,
                region_role: d.regionRole ?? null,
                element_label: d.elementLabel ?? null,
              });
              insertDiff.run(
                randomUUID(),
                comparison.id,
                'lm',
                d.description,
                d.severity,
                JSON.stringify(d.boundingBox),
                d.changeType ?? null,
                d.regionRole ?? null,
                d.elementLabel ?? null,
                sig?.signature ?? null,
                sig?.signature_version ?? null,
                completedAt,
              );
            }
            const userInstructionId = userInstructionTemplateId(lmInvocationReason, {
              // The cache key must reflect the exact payload shape the LM
              // saw, so a toggle of LM_STUDIO_INCLUDE_DIFF_IMAGE forces a
              // re-run rather than reusing a verdict the model formed
              // against a different image set. Defaulting to `true` here
              // matches `userInstructionTemplateId`'s own default and
              // preserves backward compatibility with cached rows + test
              // stubs that don't set `includeDiffImage`.
              includeDiffImage: deps.lm?.config.includeDiffImage ?? true,
            });
            db.prepare(
              `INSERT INTO lm_verdict_cache
                 (capture_a_sha, capture_b_sha, prompt_id, user_instruction_id, model_id,
                  invocation_reason, pipeline_version,
                  verdict, summary, confidence, comparison_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (capture_a_sha, capture_b_sha, prompt_id, user_instruction_id, model_id, invocation_reason, pipeline_version) DO UPDATE SET
                 verdict       = excluded.verdict,
                 summary       = excluded.summary,
                 confidence    = excluded.confidence,
                 comparison_id = excluded.comparison_id,
                 created_at    = excluded.created_at`,
            ).run(
              captureA.screenshot_sha256,
              captureB.screenshot_sha256,
              lmOutcome.promptVersion,
              userInstructionId,
              lmOutcome.model,
              lmInvocationReason,
              pipelineVersionFor(targetLevel),
              lmEquivalent ? 1 : 0,
              lmOutcome.parsed.summary,
              lmOutcome.parsed.confidence,
              comparison.id,
              completedAt,
            );
          })();
        }
      } catch (lmErr) {
        const message = lmErr instanceof Error ? lmErr.message : String(lmErr);
        // eslint-disable-next-line no-console
        console.warn(`[lm] comparison ${comparison.id}: ${message}`);
        // IM verdict already persisted; row stays 'complete'.
      }
    }

    // Slow-comparison logging. Surfacing outliers helps reviewers correlate
    // them with system load (Spotlight, Time Machine, browser, …) rather
    // than wondering why a benign-looking pair took 30 minutes. Threshold
    // overridable via env so it can be tuned per environment.
    const elapsed = Date.now() - startedAt;
    if (elapsed > SLOW_COMPARISON_THRESHOLD_MS) {
      // eslint-disable-next-line no-console
      console.warn(
        `[slow] comparison ${comparison.id} (${comparison.viewport_name}) took ${elapsed}ms`,
      );
    }
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

const SLOW_COMPARISON_THRESHOLD_MS = Number(
  process.env.SLOW_COMPARISON_THRESHOLD_MS ?? 20_000,
);

/**
 * When the IM pipeline flagged this much of the page area (sum of changed
 * pixels as a percent of total page pixels), refuse to accept an LM
 * "equivalent" verdict. Above this threshold the LM hasn't engaged with
 * what the pixel pipeline actually found, so the row keeps the pixel
 * walk's verdict and `matched_decided_by` flips back to 'pixel'. Tuned at
 * 20 from observed Altinn data — 25% missed pairs with ~21-24% real
 * differences that reviewers wanted flagged. Override via env to
 * tighten/relax.
 */
export const IM_AREA_OVERRIDE_THRESHOLD_PCT = Number(
  process.env.IM_AREA_OVERRIDE_THRESHOLD_PCT ?? 20,
);

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
