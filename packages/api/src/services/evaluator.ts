import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { ArtifactStore } from './artifact-store.js';
import type { CaptureWorker } from './capture.js';
import type { ComparisonImagick } from './comparison.js';
import { userInstructionTemplateId, type LmClient } from './lm.js';
import type { JobQueue } from './queue.js';
import type { WorkerActivityTracker } from './worker-activity.js';
import {
  captureRunOptionsSchema,
  startCaptureRun,
  type CaptureRunOptionsParsed,
} from './capture.js';
import {
  IM_AREA_OVERRIDE_THRESHOLD_PCT,
  comparisonRunOptionsSchema,
  startComparisonRunForPairs,
  type ExplicitComparisonPair,
} from './comparison.js';
import { getSessionConfig, listUrlPairs } from './sessions.js';
import { loadLatestCapturesByKey } from './capture-staleness.js';
import {
  getSessionPrompt,
  type LmPromptInvocationReason,
} from './lm-prompts.js';
import { computeMatchedAtLevel } from './equivalence.js';
import { computeAcceptanceStatus, listAcceptances } from './acceptances.js';
import { resolvePairConfig } from './config-resolver.js';
import { captureOptsHashFor } from './capture-opts-hash.js';
import { pipelineVersionFor } from '../constants/pipeline.js';
import {
  DEFAULT_VIEWPORTS,
  DEFAULT_VIEWPORT_NAME,
} from '../constants/viewports.js';
import {
  DEFAULT_EQUIVALENCE_LEVEL,
  DEFAULT_REGION_MATCH_CONFIG,
  isAtLeastAsStrict,
} from '../constants/equivalence.js';
import type {
  AcceptanceRow,
  AcceptanceRuleScope,
  BoundingBoxPercent,
  CaptureSide,
  ClusterReviewState,
  EquivalenceLevelId,
  FilterQuery,
  LmInvocationReason,
  MatchedAtLevel,
  PairOutcome,
  PlannedCapture,
  RegionMatchConfig,
  SessionConfig,
  SessionResultRow,
  UrlPairConfigOverrideRow,
  UrlPairRow,
  ViewportDef,
} from '../types.js';
export type { PlannedCapture };

const SIDES: CaptureSide[] = ['a', 'b'];

const viewportSchema = z.object({
  name: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive(),
  orientation: z.enum(['portrait', 'landscape']),
});

const equivalenceLevelSchema = z.enum([
  'pixel-perfect',
  'strict',
  'tolerant',
  'loose',
]);

export const evaluationConfigInputSchema = z
  .object({
    viewports: z.array(viewportSchema).min(1).optional(),
    /** Single target level. The pipeline records `matched_at_level` per comparison. */
    target_level: equivalenceLevelSchema.optional(),
    /** When true, run the LM second pass on comparisons that don't match at target. */
    invoke_lm: z.boolean().optional(),
    capture_options: z.record(z.unknown()).optional(),
    url_pair_ids: z.array(z.string()).optional(),
    /** Override the model id used for cache lookups; rarely needed. */
    lm_model_id: z.string().min(1).optional(),
    /**
     * When set, the planner ignores cached captures for the scoped tuples
     * and treats them as misses, so the orchestrator re-captures them. The
     * existing capture/comparison parallelism still applies — comparisons
     * dispatch per-pair as each new sha lands. `sides` empty = both sides;
     * the pair scope is the eval's `url_pair_ids` (null = every enabled
     * pair). Used by the Recapture button to fold "recapture + re-evaluate"
     * into a single evaluation run.
     */
    force_recapture: z
      .object({
        sides: z.array(z.enum(['a', 'b'])).default([]),
      })
      .optional(),
  })
  .strict();

export type EvaluationConfigInput = z.infer<typeof evaluationConfigInputSchema>;

export interface EvaluationConfig {
  viewports: ViewportDef[];
  /** Session-wide target level. Single value, not a list. */
  target_level: EquivalenceLevelId;
  /** Whether the LM second pass runs on comparisons that miss the target. */
  invoke_lm: boolean;
  region_match_config: RegionMatchConfig;
  capture_options: CaptureRunOptionsParsed;
  /**
   * Explicit pair selection. When non-null, takes precedence over
   * `filter_query`. Null means "use the filter."
   */
  url_pair_ids: string[] | null;
  filter_query: FilterQuery;
  /**
   * Cache-key prompt ids per invocation reason. The keys are content-addressable
   * sha256s, so editing a session's prompt naturally produces a cache miss.
   */
  lm_prompt_ids: Partial<Record<LmPromptInvocationReason, string>>;
  lm_model_id: string;
  /**
   * Mirrors `LmConfig.includeDiffImage` so the planner / readSessionResults
   * can compute the same `userInstructionTemplateId` the write path used.
   * Read from the live LM client at resolve time; the cache key
   * incorporates this so toggling it forces a re-run of LM.
   */
  lm_include_diff_image: boolean;
  /**
   * When non-null, the planner treats the matching (pair, viewport, side)
   * tuples as capture misses regardless of cache state. Pair scope is
   * `url_pair_ids` (null = every enabled pair). `sides: []` means both.
   */
  force_recapture: { sides: ('a' | 'b')[] } | null;
}

export interface PlannedComparison {
  url_pair_id: string;
  viewport_name: string;
  /** Already-cached capture shas, when available. */
  capture_a_sha: string | null;
  capture_b_sha: string | null;
}

export interface EvaluationPlan {
  enabled_pair_count: number;
  capture_misses: PlannedCapture[];
  comparison_misses: PlannedComparison[];
  cache_hits: { captures: number; pixel: number; lm: number };
}

export interface EvaluationCacheHits {
  captures: number;
  pixel: number;
  lm: number;
}

export interface StartEvaluationResult {
  evaluation_id: string;
  coalesced: boolean;
}

/**
 * Per-reason `prompt_id` cache keys. Phase 4 sources these from
 * `lm_prompts(session_id, ...)`; if a row is missing for a given reason,
 * the LM client's env-derived `promptVersion` is used as a fallback so
 * older sessions keep working.
 */
export function loadSessionPromptIds(
  db: Db,
  sessionId: string,
  lm: LmClient | undefined,
): Partial<Record<LmPromptInvocationReason, string>> {
  const out: Partial<Record<LmPromptInvocationReason, string>> = {};
  const fallback = lm?.config.promptVersion;
  for (const reason of ['target_level_failure', 'ambiguous_pixel_result'] as const) {
    const row = getSessionPrompt(db, sessionId, reason);
    if (row) out[reason] = row.prompt_id;
    else if (fallback) out[reason] = fallback;
  }
  return out;
}

/**
 * Resolve an EvaluationConfigInput into the fully-defaulted config the
 * planner needs. Precedence (highest to lowest):
 *   1. Per-call overrides (`input`).
 *   2. Session config (`session`), when supplied.
 *   3. System defaults (constants files, LM client).
 *
 * `url_pair_ids` from `input` takes precedence over `filter_query` from
 * `session` — explicit pair selection trumps the DSL.
 *
 * `promptIds` are looked up separately via `loadSessionPromptIds` because
 * they require a db handle; resolveEvaluationConfig stays pure.
 */
export function resolveEvaluationConfig(
  input: EvaluationConfigInput | undefined,
  session: SessionConfig | undefined,
  lm: LmClient | undefined,
  promptIds: Partial<Record<LmPromptInvocationReason, string>> = {},
): EvaluationConfig {
  const sessionViewports = session?.default_viewports ?? [];

  const viewports =
    input?.viewports ??
    (sessionViewports.length > 0
      ? sessionViewports
      : DEFAULT_VIEWPORTS.filter((v) => v.name === DEFAULT_VIEWPORT_NAME));

  const target_level =
    input?.target_level ?? session?.default_equivalence_level ?? DEFAULT_EQUIVALENCE_LEVEL;

  const capture_options = captureRunOptionsSchema.parse({
    ...(session?.default_capture_options ?? {}),
    ...(input?.capture_options ?? {}),
    viewports,
  });

  const lm_model_id = input?.lm_model_id ?? lm?.config.model ?? 'unknown';

  return {
    viewports,
    target_level,
    invoke_lm: input?.invoke_lm ?? session?.default_invoke_lm ?? false,
    region_match_config: session?.region_match_config ?? { ...DEFAULT_REGION_MATCH_CONFIG },
    capture_options,
    url_pair_ids: input?.url_pair_ids ?? null,
    filter_query: session?.filter_query ?? {},
    lm_prompt_ids: promptIds,
    lm_model_id,
    // Defaults to `true` to match `userInstructionTemplateId`'s default
    // and keep cache lookups consistent with rows written before this
    // flag existed (which all used the "AB+diff" payload shape).
    // Production deployments override via the env reader, which defaults
    // the env value to `false` once the toggle exists.
    lm_include_diff_image: lm?.config.includeDiffImage ?? true,
    force_recapture: input?.force_recapture
      ? { sides: input.force_recapture.sides ?? [] }
      : null,
  };
}

/**
 * Effective path for filtering. Prefers the explicit `path` column when
 * the CSV provided one (e.g. Altinn's sitemap-derived `/en/about-altinn`),
 * and falls back to `url_a`'s pathname so filters still work on plain
 * `url_a, url_b` CSVs. `url_b` is intentionally not consulted — pairs
 * are expected to share a path; A is the canonical side for filtering.
 */
function effectivePath(p: UrlPairRow): string | null {
  if (p.path) return p.path;
  try {
    return new URL(p.url_a).pathname;
  } catch {
    return null;
  }
}

/**
 * Apply the filter DSL to a list of url_pairs. Empty/missing fields mean
 * "no constraint on this facet." Pairs whose facet is null fail an
 * inclusive-list check (they can't be in `["no"]` if they have no language).
 */
export function applyFilter(pairs: UrlPairRow[], filter: FilterQuery): UrlPairRow[] {
  return pairs.filter((p) => {
    if (filter.language && filter.language.length > 0) {
      if (!p.language || !filter.language.includes(p.language)) return false;
    }
    if (filter.category && filter.category.length > 0) {
      if (!p.category || !filter.category.includes(p.category)) return false;
    }
    if (filter.subcategory && filter.subcategory.length > 0) {
      if (!p.subcategory || !filter.subcategory.includes(p.subcategory)) return false;
    }
    if (filter.path_prefix) {
      const path = effectivePath(p);
      if (!path || !path.startsWith(filter.path_prefix)) return false;
    }
    return true;
  });
}

/**
 * Returns the cache-key prompt id for the given invocation reason. Returns
 * null when the reason has no configured prompt (e.g. `manual_retry`,
 * which the seed doesn't cover). Cache lookups skip over null reasons.
 */
function lookupPromptId(
  config: EvaluationConfig,
  reason: LmInvocationReason,
): string | null {
  if (reason === 'target_level_failure' || reason === 'ambiguous_pixel_result') {
    return config.lm_prompt_ids[reason] ?? null;
  }
  return null;
}

function selectEnabledPairs(
  allPairs: UrlPairRow[],
  config: EvaluationConfig,
): UrlPairRow[] {
  const active = allPairs.filter((p) => p.disabled === 0);
  if (config.url_pair_ids) {
    const idSet = new Set(config.url_pair_ids);
    return active.filter((p) => idSet.has(p.id));
  }
  return applyFilter(active, config.filter_query);
}

interface CaptureCacheRow {
  url: string;
  viewport_name: string;
  capture_opts_hash: string;
  screenshot_sha256: string;
  capture_id: string;
}

interface PixelCacheRow {
  capture_a_sha: string;
  capture_b_sha: string;
  pipeline_version: string;
  changed_pct: number | null;
  ssim: number | null;
}

export function planEvaluation(
  db: Db,
  sessionId: string,
  config: EvaluationConfig,
): EvaluationPlan {
  const allPairs = listUrlPairs(db, sessionId);
  const enabledPairs = selectEnabledPairs(allPairs, config);

  // Join captures so we surface is_missing alongside the cached sha. The
  // planner needs it to short-circuit missing-page pairs (no point queueing
  // a comparison job that's just going to short-circuit and write no cache);
  // is_missing is null for legacy capture rows that predate the column —
  // treated as 'not missing' below.
  const captureCacheLookup = db.prepare<
    [string, string, string],
    CaptureCacheRow & { is_missing: number | null }
  >(
    `SELECT cc.url, cc.viewport_name, cc.capture_opts_hash, cc.screenshot_sha256, cc.capture_id,
            c.is_missing
       FROM capture_cache cc
       LEFT JOIN captures c ON c.id = cc.capture_id
      WHERE cc.url = ? AND cc.viewport_name = ? AND cc.capture_opts_hash = ?`,
  );

  const pixelCacheLookup = db.prepare<
    [string, string, string],
    PixelCacheRow
  >(
    `SELECT capture_a_sha, capture_b_sha, pipeline_version, changed_pct, ssim
       FROM pixel_compare_cache
      WHERE capture_a_sha = ? AND capture_b_sha = ? AND pipeline_version = ?`,
  );

  const lmCacheLookup = db.prepare<
    [string, string, string, string, string, string, string],
    { capture_a_sha: string }
  >(
    `SELECT capture_a_sha
       FROM lm_verdict_cache
      WHERE capture_a_sha = ? AND capture_b_sha = ? AND prompt_id = ?
        AND user_instruction_id = ? AND model_id = ? AND invocation_reason = ?
        AND pipeline_version = ?`,
  );

  const capture_misses: PlannedCapture[] = [];
  const captureShaByKey = new Map<string, string>(); // pair_id::vp_name::side → sha
  const missingByKey = new Set<string>(); // pair_id::vp_name::side for is_missing=1 captures
  let captureHits = 0;

  // force_recapture: empty sides list means both. The pair scope is the
  // eval's enabledPairs (already filtered by url_pair_ids upstream), so we
  // only need to honor the side restriction here.
  const forcedSides: Set<CaptureSide> | null = config.force_recapture
    ? new Set(
        config.force_recapture.sides.length > 0
          ? config.force_recapture.sides
          : SIDES,
      )
    : null;

  // Latest captures row per (pair, vp, side) for the session. Lets us
  // detect "the cache row is stale because a newer pending/processing/error
  // captures row exists" — which is the steady state during an in-flight
  // recapture. Treating those as misses keeps the orchestrator's
  // dispatchReady poll from racing comparisons against the about-to-be-
  // -overwritten cache sha.
  const latestCapturesByKey = loadLatestCapturesByKey(db, sessionId);

  for (const pair of enabledPairs) {
    for (const vp of config.viewports) {
      const optsHash = captureOptsHashFor(vp, config.capture_options);
      for (const side of SIDES) {
        const url = side === 'a' ? pair.url_a : pair.url_b;
        const cached = captureCacheLookup.get(url, vp.name, optsHash);
        const latest = latestCapturesByKey.get(`${pair.id}::${vp.name}::${side}`);
        const isStale = !!(cached && latest && latest.capture_id !== cached.capture_id);
        const forced = forcedSides?.has(side) ?? false;
        const useCacheHit = cached && !isStale && !forced;
        if (useCacheHit) {
          captureShaByKey.set(`${pair.id}::${vp.name}::${side}`, cached.screenshot_sha256);
          if (cached.is_missing === 1) {
            missingByKey.add(`${pair.id}::${vp.name}::${side}`);
          }
          captureHits += 1;
        } else {
          capture_misses.push({
            url_pair_id: pair.id,
            viewport_name: vp.name,
            side,
            url,
          });
        }
      }
    }
  }

  const comparison_misses: PlannedComparison[] = [];
  let pixelHits = 0;
  let lmHits = 0;

  // TODO(phase-2): a future planner walks every level strictest -> loosest from
  // a single cached pixel result and decides whether LM second-pass is needed.
  // For phase 1, this still plans one comparison per (pair, viewport) at the
  // session's target level — same shape as before, but without the per-level
  // fan-out.
  for (const pair of enabledPairs) {
    for (const vp of config.viewports) {
      const aSha = captureShaByKey.get(`${pair.id}::${vp.name}::a`) ?? null;
      const bSha = captureShaByKey.get(`${pair.id}::${vp.name}::b`) ?? null;
      if (!aSha || !bSha) {
        comparison_misses.push({
          url_pair_id: pair.id,
          viewport_name: vp.name,
          capture_a_sha: aSha,
          capture_b_sha: bSha,
        });
        continue;
      }
      // Missing-page short-circuit. runOneComparison treats these as
      // already-done (status='complete', pair_outcome set) and intentionally
      // skips the pixel_compare_cache write — the diff is meaningless. The
      // planner must mirror that decision: don't queue a comparison job
      // here, otherwise every Evaluate forever re-runs the missing-page
      // pairs and the cache hit count never catches up to enabled_pair_count.
      const aMissing = missingByKey.has(`${pair.id}::${vp.name}::a`);
      const bMissing = missingByKey.has(`${pair.id}::${vp.name}::b`);
      if (aMissing || bMissing) continue;
      const pipelineVersion = pipelineVersionFor(config.target_level);
      const pixel = pixelCacheLookup.get(aSha, bSha, pipelineVersion);
      if (!pixel) {
        comparison_misses.push({
          url_pair_id: pair.id,
          viewport_name: vp.name,
          capture_a_sha: aSha,
          capture_b_sha: bSha,
        });
        continue;
      }
      pixelHits += 1;

      const { pixelMatchedAtLevel, inTargetAmbiguityBand } = computeMatchedAtLevel({
        changedPixelPercentage: pixel.changed_pct ?? 0,
        ssim: pixel.ssim,
        targetLevel: config.target_level,
      });
      // Same gating as runOneComparison: LM is invoked at most once, with
      // ambiguity-band taking precedence over target-failure.
      let reason: LmInvocationReason | null = null;
      if (inTargetAmbiguityBand) {
        reason = 'ambiguous_pixel_result';
      } else if (
        config.invoke_lm &&
        !isAtLeastAsStrict(pixelMatchedAtLevel, config.target_level)
      ) {
        reason = 'target_level_failure';
      }
      if (reason !== null) {
        const promptId = lookupPromptId(config, reason);
        const lmHit = promptId
          ? lmCacheLookup.get(
              aSha,
              bSha,
              promptId,
              userInstructionTemplateId(reason, { includeDiffImage: config.lm_include_diff_image }),
              config.lm_model_id,
              reason,
              pipelineVersion,
            )
          : null;
        if (!lmHit) {
          comparison_misses.push({
            url_pair_id: pair.id,
            viewport_name: vp.name,
            capture_a_sha: aSha,
            capture_b_sha: bSha,
          });
          continue;
        }
        lmHits += 1;
      }
    }
  }

  return {
    enabled_pair_count: enabledPairs.length,
    capture_misses,
    comparison_misses,
    cache_hits: { captures: captureHits, pixel: pixelHits, lm: lmHits },
  };
}

export interface EvaluatorDeps {
  db: Db;
  queue: JobQueue;
  artifactStore: ArtifactStore;
  worker: CaptureWorker;
  imagick?: ComparisonImagick;
  lm?: LmClient;
  /**
   * Worker activity histogram. Optional — tests don't need it.
   * Capture and comparison runs report in-flight counts here so the
   * CPU usage indicator in the session header reflects real load.
   */
  workerActivity?: WorkerActivityTracker;
  /**
   * Poll cadence for the streaming orchestrator. The orchestrator re-plans
   * + dispatches newly-ready comparison batches on this interval while the
   * capture job is in flight. Default in production: 2000 ms (cheap on DB,
   * tight enough that the GPU rarely idles between batches). Tests override
   * with a small value (e.g. 10 ms) so they don't wait whole seconds.
   */
  pollIntervalMs?: number;
}

interface EvaluationRow {
  id: string;
  session_id: string;
  status: 'pending' | 'running' | 'complete' | 'error' | 'cancelled';
  capture_run_id: string | null;
  comparison_run_id: string | null;
  cache_hits: string;
  config_snapshot_json: string;
  enabled_pair_count: number;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

interface PendingEvaluation {
  promise: Promise<void>;
  controller: AbortController;
}

export class Evaluator {
  #deps: EvaluatorDeps;
  #pending = new Map<string, PendingEvaluation>();

  constructor(deps: EvaluatorDeps) {
    // If pollIntervalMs isn't passed explicitly, fall back to env so a
    // global vitest config can set a tiny interval without every test
    // having to thread the option through createApp.
    const envPoll = process.env.EVALUATOR_POLL_INTERVAL_MS;
    this.#deps = {
      ...deps,
      pollIntervalMs:
        deps.pollIntervalMs ??
        (envPoll && Number.isFinite(Number(envPoll)) ? Number(envPoll) : undefined),
    };
  }

  /**
   * Cooperative cancel. Aborts the per-evaluation signal so the capture /
   * comparison limit-loops stop pulling new work, and the orchestrator
   * marks the row `'cancelled'` when the in-flight phase resolves.
   *
   * Returns the disposition: `cancelled` when we set the abort, `noop` when
   * the evaluation isn't in flight (already terminal, or unknown id).
   * Pre-flight in the DB happens in the route layer so it can return 404 /
   * 409 with proper status codes.
   */
  cancel(evaluationId: string): 'cancelled' | 'noop' {
    const entry = this.#pending.get(evaluationId);
    if (!entry) return 'noop';
    if (entry.controller.signal.aborted) return 'noop';
    entry.controller.abort();
    return 'cancelled';
  }

  /**
   * Compute a plan and start (or coalesce onto) an evaluation. Returns
   * synchronously with the evaluation id; the orchestration runs in the
   * background.
   */
  start(sessionId: string, configInput?: EvaluationConfigInput): StartEvaluationResult {
    const { db } = this.#deps;
    const inFlight = db
      .prepare<[string], { id: string }>(
        `SELECT id FROM evaluations
           WHERE session_id = ? AND status IN ('pending', 'running')
           ORDER BY started_at DESC LIMIT 1`,
      )
      .get(sessionId);
    if (inFlight) return { evaluation_id: inFlight.id, coalesced: true };

    const sessionConfig = getSessionConfig(db, sessionId) ?? undefined;
    const promptIds = loadSessionPromptIds(db, sessionId, this.#deps.lm);
    const config = resolveEvaluationConfig(
      configInput,
      sessionConfig,
      this.#deps.lm,
      promptIds,
    );
    const initialPlan = planEvaluation(db, sessionId, config);

    const evaluationId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO evaluations
         (id, session_id, config_snapshot_json, enabled_pair_count,
          capture_run_id, comparison_run_id, cache_hits, status, started_at)
         VALUES (?, ?, ?, ?, NULL, NULL, '{}', 'pending', ?)`,
    ).run(
      evaluationId,
      sessionId,
      JSON.stringify(config),
      initialPlan.enabled_pair_count,
      now,
    );

    const controller = new AbortController();
    const promise = this.#orchestrate(
      evaluationId,
      sessionId,
      config,
      initialPlan,
      controller.signal,
    )
      .catch((err) => {
        // Already recorded inside #orchestrate; swallow so unhandled rejection
        // doesn't crash the process.
        // eslint-disable-next-line no-console
        console.error(`[evaluator] orchestration failed: ${(err as Error).message}`);
      })
      .finally(() => {
        this.#pending.delete(evaluationId);
      });
    this.#pending.set(evaluationId, { promise, controller });

    return { evaluation_id: evaluationId, coalesced: false };
  }

  /** Promise that resolves once the named evaluation finishes orchestrating. */
  waitFor(evaluationId: string): Promise<void> | undefined {
    return this.#pending.get(evaluationId)?.promise;
  }

  /** Wait for every in-flight evaluation. Used by tests. */
  async drainAll(): Promise<void> {
    while (this.#pending.size > 0) {
      const pending = [...this.#pending.values()].map((p) => p.promise);
      await Promise.all(pending);
    }
  }

  async #orchestrate(
    evaluationId: string,
    sessionId: string,
    config: EvaluationConfig,
    initialPlan: EvaluationPlan,
    signal: AbortSignal,
  ): Promise<void> {
    const { db, queue } = this.#deps;
    db.prepare(`UPDATE evaluations SET status = 'running' WHERE id = ?`).run(evaluationId);

    try {
      if (signal.aborted) {
        this.#finalizeCancelled(evaluationId, null, null);
        return;
      }

      // -- Phase 1: kick off captures (don't await yet) -------------------
      //
      // Pass the planner's per-tuple misses through `explicitCaptures` so we
      // insert exactly one captures row per actually-missing
      // (pair, viewport, side) — the legacy cartesian-product path would
      // re-capture both sides of any pair where either side was missing, and
      // any rows left `pending` after an interruption become permanent
      // zombies (the in-memory queue can't re-pick them up).
      let captureRunId: string | null = null;
      let captureWait: Promise<void> | undefined;
      let captureDone = false;
      if (initialPlan.capture_misses.length > 0) {
        const missingViewportNames = new Set(
          initialPlan.capture_misses.map((c) => c.viewport_name),
        );
        const captureViewports = config.viewports.filter((v) =>
          missingViewportNames.has(v.name),
        );
        const captureOpts = captureRunOptionsSchema.parse({
          ...config.capture_options,
          viewports: captureViewports,
        });
        const captureResult = startCaptureRun(this.#deps, {
          sessionId,
          options: captureOpts,
          signal,
          explicitCaptures: initialPlan.capture_misses,
        });
        captureRunId = captureResult.capture_run_id;
        db.prepare(`UPDATE evaluations SET capture_run_id = ? WHERE id = ?`).run(
          captureRunId,
          evaluationId,
        );
        captureWait = queue.waitForJob(captureResult.job_id);
        if (captureWait) {
          void captureWait.then(() => {
            captureDone = true;
          });
        } else {
          captureDone = true;
        }
      } else {
        captureDone = true;
      }

      // -- Phase 2: stream comparisons as pairs become ready --------------
      //
      // Each iteration re-plans (cheap query) and resolves capture row ids
      // for any pair whose A/B captures have landed in the cache substrate.
      // Newly-ready pairs are dispatched as a fresh comparison job that
      // appends rows to the same logical comparison_run. Per-batch worker
      // scoping (see startComparisonRunForPairs) prevents cross-batch row
      // double-pickup; the per-type queue chain (see queue.ts) lets these
      // jobs run concurrently with the in-flight capture job.
      const comparisonOpts = comparisonRunOptionsSchema.parse({
        targetLevel: config.target_level,
        invokeLm: config.invoke_lm,
      });
      const dispatchedKeys = new Set<string>();
      const comparisonJobIds: string[] = [];
      let comparisonRunId: string | null = null;
      const fallbackCaptureRunId = (): string | null =>
        captureRunId ?? this.#anyCaptureRunForSession(sessionId);

      // dispatchReady plans without force_recapture: phase 1's pending
      // captures rows already make the cache "stale" (latest captures row
      // != cache.capture_id), so the planner's always-on is_stale check
      // keeps the comparison from racing the still-rolling-forward cache.
      // Once the new captures complete and the cache rolls forward,
      // is_stale clears and the comparison dispatches against fresh shas.
      const dispatchConfig: EvaluationConfig = { ...config, force_recapture: null };
      const dispatchReady = (): void => {
        if (signal.aborted) return;
        const plan = planEvaluation(db, sessionId, dispatchConfig);
        const rowsByPair = this.#loadCapturesForMisses(plan.comparison_misses);
        const pairs: ExplicitComparisonPair[] = [];
        for (const m of plan.comparison_misses) {
          const key = `${m.url_pair_id}::${m.viewport_name}`;
          if (dispatchedKeys.has(key)) continue;
          const ids = rowsByPair.get(key);
          if (!ids?.a || !ids?.b) continue;
          pairs.push({
            url_pair_id: m.url_pair_id,
            viewport_name: m.viewport_name,
            capture_a_id: ids.a,
            capture_b_id: ids.b,
          });
          dispatchedKeys.add(key);
        }
        if (pairs.length === 0) return;
        const cr = fallbackCaptureRunId();
        if (!cr) {
          throw new Error(
            'No capture run available to associate with this comparison run; ' +
              'this should be impossible when comparisons are missing.',
          );
        }
        const result = startComparisonRunForPairs(this.#deps, {
          sessionId,
          captureRunId: cr,
          options: comparisonOpts,
          pairs,
          signal,
          existingRunId: comparisonRunId ?? undefined,
        });
        if (!comparisonRunId) {
          comparisonRunId = result.comparison_run_id;
          db.prepare(
            `UPDATE evaluations SET comparison_run_id = ? WHERE id = ?`,
          ).run(comparisonRunId, evaluationId);
        }
        comparisonJobIds.push(result.job_id);
      };

      // Per-item isolation: a transient failure in dispatchReady (e.g.,
      // an HTTP 502 from a Scaleway control-plane call inside preflight)
      // used to crash #orchestrate and mark the whole evaluation `'error'`,
      // leaving thousands of queued items undone. We now log and continue —
      // the next poll re-plans against current state, so transient failures
      // self-heal once the underlying service comes back. dispatchReady's
      // writes (startComparisonRunForPairs) are append-only and idempotent
      // on `existingRunId`, so a partially-applied dispatch is safe to retry.
      const tryDispatchReady = (): void => {
        try {
          dispatchReady();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[evaluator] dispatchReady failed transiently for evaluation ${evaluationId}: ${(err as Error).message}; will retry on next poll`,
          );
        }
      };

      // Initial dispatch: any pairs already resolvable from cache hits.
      tryDispatchReady();

      // Poll loop while the capture job is still flying. The cadence
      // balances "tight enough that the GPU rarely idles" against "loose
      // enough to keep DB pressure trivial." 2s is small relative to capture
      // latency (~5–30s/page) and to a typical verdict (~1–5s).
      const pollMs = this.#deps.pollIntervalMs ?? 2000;
      while (!captureDone && !signal.aborted) {
        await sleep(pollMs);
        if (signal.aborted) break;
        tryDispatchReady();
      }

      // Final dispatch after captures resolve, to catch any pair that became
      // ready in the gap between the last poll tick and capture completion.
      if (!signal.aborted) tryDispatchReady();

      // Await every dispatched comparison job.
      for (const jobId of comparisonJobIds) {
        const wait = queue.waitForJob(jobId);
        if (wait) await wait;
        if (signal.aborted) break;
      }

      if (signal.aborted) {
        this.#finalizeCancelled(evaluationId, captureRunId, comparisonRunId);
        return;
      }

      // -- Phase 3: finalize -----------------------------------------------
      // Use dispatchConfig (force_recapture cleared) so cache_hits reflect
      // the post-recapture steady state: cache rolled forward, no longer
      // "forced." Otherwise the recapture'd sides would still be counted
      // as misses despite their fresh captures.
      //
      // Wrap the final plan in try/catch: if a transient DB hiccup makes
      // cache_hits unavailable, we still want to mark the eval `'complete'`
      // with empty cache_hits rather than `'error'` — all the actual
      // capture/comparison work already happened successfully by this
      // point, and `'error'` would discard that signal.
      let finalCacheHits: { captures: number; pixel: number; lm: number };
      try {
        finalCacheHits = planEvaluation(db, sessionId, dispatchConfig).cache_hits;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[evaluator] final plan failed for evaluation ${evaluationId}: ${(err as Error).message}; finalizing without cache_hits`,
        );
        finalCacheHits = { captures: 0, pixel: 0, lm: 0 };
      }
      db.prepare(
        `UPDATE evaluations
           SET status = 'complete',
               comparison_run_id = ?,
               cache_hits = ?,
               completed_at = ?
         WHERE id = ?`,
      ).run(
        comparisonRunId,
        JSON.stringify(finalCacheHits),
        new Date().toISOString(),
        evaluationId,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.prepare(
        `UPDATE evaluations
           SET status = 'error', error_message = ?, completed_at = ?
         WHERE id = ?`,
      ).run(message, new Date().toISOString(), evaluationId);
      throw err;
    }
  }

  /**
   * Mark the evaluation row `cancelled` and persist whichever run ids were
   * already attached. Best-effort cache_hits recompute is skipped — the
   * partial counts aren't meaningful and risk confusing the history view.
   */
  #finalizeCancelled(
    evaluationId: string,
    captureRunId: string | null,
    comparisonRunId: string | null,
  ): void {
    this.#deps.db
      .prepare(
        `UPDATE evaluations
           SET status = 'cancelled',
               capture_run_id = COALESCE(capture_run_id, ?),
               comparison_run_id = COALESCE(comparison_run_id, ?),
               completed_at = ?
         WHERE id = ?`,
      )
      .run(captureRunId, comparisonRunId, new Date().toISOString(), evaluationId);
  }

  #loadCapturesForMisses(
    misses: PlannedComparison[],
  ): Map<string, { a?: string; b?: string }> {
    const byPair = new Map<string, { a?: string; b?: string }>();
    if (misses.length === 0) return byPair;
    const { db } = this.#deps;
    const urlPair = db.prepare<
      [string],
      { id: string; url_a: string; url_b: string }
    >('SELECT id, url_a, url_b FROM url_pairs WHERE id = ?');
    const captureBySha = db.prepare<
      [string, string, string],
      { capture_id: string }
    >(
      `SELECT capture_id FROM capture_cache
         WHERE url = ? AND viewport_name = ? AND screenshot_sha256 = ?
         ORDER BY created_at DESC LIMIT 1`,
    );

    const seen = new Set<string>();
    for (const m of misses) {
      const key = `${m.url_pair_id}::${m.viewport_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pair = urlPair.get(m.url_pair_id);
      if (!pair || !m.capture_a_sha || !m.capture_b_sha) continue;
      const aRow = captureBySha.get(pair.url_a, m.viewport_name, m.capture_a_sha);
      const bRow = captureBySha.get(pair.url_b, m.viewport_name, m.capture_b_sha);
      if (!aRow || !bRow) continue;
      byPair.set(key, { a: aRow.capture_id, b: bRow.capture_id });
    }
    return byPair;
  }

  #anyCaptureRunForSession(sessionId: string): string | null {
    const row = this.#deps.db
      .prepare<[string], { id: string }>(
        `SELECT id FROM capture_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId);
    return row?.id ?? null;
  }
}

export function getEvaluation(db: Db, id: string): EvaluationRow | null {
  const row = db
    .prepare<[string], EvaluationRow>('SELECT * FROM evaluations WHERE id = ?')
    .get(id);
  return row ?? null;
}

export interface ResumeResult {
  /** Original eval id whose work this resume re-drives. */
  prior_evaluation_id: string;
  session_id: string;
  /** New eval row created by the resume call. */
  evaluation_id: string;
  /** True when the original session already had a fresh in-flight eval. */
  coalesced: boolean;
}

/**
 * Re-drive every evaluation interrupted by a restart. Called once at boot,
 * after `recoverInterruptedRuns` flips the orphaned rows to `error`. The
 * snapshot stored on each evaluation lets us reconstruct the user's intent
 * (force_recapture, url_pair_ids, target_level, viewports, capture_options,
 * lm_model_id) so the new orchestration picks up where the dead process
 * left off — captures already in the cache are reused, only the still-
 * missing work is re-queued.
 *
 * Session, prompt, and LM-server config are re-resolved from current state
 * (the new evaluator.start path), not snapshotted; if a session's config
 * changed between the old eval starting and the restart, the resume uses
 * today's config. That's the conservative choice — a stale snapshot could
 * easily reference deleted url_pair_ids or removed viewports.
 *
 * Failures during a single resume are logged but don't abort the loop;
 * the user can still click Evaluate manually to recover.
 */
export function resumeInterruptedEvaluations(
  evaluator: Evaluator,
  resumable: ReadonlyArray<{ id: string; session_id: string; config_snapshot_json: string }>,
): ResumeResult[] {
  const out: ResumeResult[] = [];
  for (const prior of resumable) {
    try {
      const input = configSnapshotToInput(prior.config_snapshot_json);
      const result = evaluator.start(prior.session_id, input);
      out.push({
        prior_evaluation_id: prior.id,
        session_id: prior.session_id,
        evaluation_id: result.evaluation_id,
        coalesced: result.coalesced,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[evaluator] failed to resume evaluation ${prior.id} for session ${prior.session_id}: ${(err as Error).message}`,
      );
    }
  }
  return out;
}

/**
 * Best-effort mapper from a stored EvaluationConfig snapshot to the
 * EvaluationConfigInput shape `evaluator.start` accepts. Fields that
 * resolve from current session/LM config (`filter_query`,
 * `region_match_config`, `lm_prompt_ids`, `lm_include_diff_image`,
 * `capture_options`) are deliberately dropped — picking them up fresh
 * is more likely to be correct than replaying a possibly stale snapshot.
 *
 * `capture_options` in particular: an interrupted eval was likely
 * interrupted *because* its concurrency was set too high for the box
 * (the OOM-kill → resume → OOM-kill loop we hit in practice). Re-
 * resolving from the session means an operator can drop concurrency in
 * the session config and have the next restart cycle pick it up
 * automatically, instead of being stuck replaying the original eval's
 * settings. The cost is that a one-off per-eval capture-options
 * override is lost on resume — acceptable trade given the failure
 * mode.
 *
 * Unparseable input yields an empty config (which still works: the
 * resolver fills from the session).
 */
function configSnapshotToInput(json: string): EvaluationConfigInput {
  let snapshot: Partial<EvaluationConfig>;
  try {
    snapshot = JSON.parse(json) as Partial<EvaluationConfig>;
  } catch {
    return {};
  }
  const input: EvaluationConfigInput = {};
  if (Array.isArray(snapshot.viewports) && snapshot.viewports.length > 0) {
    input.viewports = snapshot.viewports;
  }
  if (snapshot.target_level) input.target_level = snapshot.target_level;
  if (typeof snapshot.invoke_lm === 'boolean') input.invoke_lm = snapshot.invoke_lm;
  if (Array.isArray(snapshot.url_pair_ids) && snapshot.url_pair_ids.length > 0) {
    input.url_pair_ids = snapshot.url_pair_ids;
  }
  if (typeof snapshot.lm_model_id === 'string' && snapshot.lm_model_id.length > 0) {
    input.lm_model_id = snapshot.lm_model_id;
  }
  if (snapshot.force_recapture) {
    input.force_recapture = { sides: snapshot.force_recapture.sides ?? [] };
  }
  return input;
}

export function listEvaluations(db: Db, sessionId: string): EvaluationRow[] {
  return db
    .prepare<[string], EvaluationRow>(
      `SELECT * FROM evaluations WHERE session_id = ? ORDER BY started_at DESC`,
    )
    .all(sessionId);
}

/**
 * Return compound `<url_pair_id>::<viewport_name>` keys for rows whose
 * verdict could have moved since `since`. Two signal sources:
 *
 *   1. Comparisons completed after `since` — i.e. new pixel/LM verdicts.
 *      Captures going from pending → complete don't count here, since
 *      readSessionResults reads from pixel_compare_cache, not the captures
 *      table; only completed comparisons write that cache.
 *   2. Acceptances created/updated after `since` — accept/clear actions
 *      change `acceptance_status` on the row even when the verdict didn't
 *      move. Without this we'd miss UI-driven changes from another tab.
 *
 * `since` must be an ISO-8601 timestamp; callers pass it through verbatim
 * from the previous response's `cursor`. Results are deduped and order is
 * not guaranteed (the client uses these as a set).
 */
export function listChangedPairKeysSince(
  db: Db,
  sessionId: string,
  since: string,
): string[] {
  const seen = new Set<string>();
  const compRows = db
    .prepare<
      [string, string],
      { url_pair_id: string; viewport_name: string }
    >(
      `SELECT c.url_pair_id, c.viewport_name
         FROM comparisons c
         JOIN comparison_runs cr ON cr.id = c.comparison_run_id
        WHERE cr.session_id = ?
          AND c.completed_at IS NOT NULL
          AND c.completed_at > ?`,
    )
    .all(sessionId, since);
  for (const r of compRows) seen.add(`${r.url_pair_id}::${r.viewport_name}`);

  const acceptanceRows = db
    .prepare<
      [string, string],
      { url_pair_id: string; viewport_name: string }
    >(
      `SELECT url_pair_id, viewport_name
         FROM acceptances
        WHERE session_id = ?
          AND updated_at > ?`,
    )
    .all(sessionId, since);
  for (const r of acceptanceRows) seen.add(`${r.url_pair_id}::${r.viewport_name}`);

  return Array.from(seen);
}

// SessionResultRow has moved to ../types.ts (cross-package). Re-export so
// existing imports keep working without churn.
export type { SessionResultRow } from '../types.js';

/**
 * Aggregate result rows into the histogram/filter buckets the Review UI
 * needs. Pure function — runs in O(n) over the rows, no DB access.
 *
 * `pending` covers any row whose status is 'pending' or whose
 * matched_at_level hasn't been resolved (LM-cache miss waiting for a
 * second pass). The same row also lands in by_target_status='pending' so
 * the two breakdowns never disagree on totals.
 */
export function summariseResults(
  rows: SessionResultRow[],
  targetLevel: EquivalenceLevelId,
): import('../types.js').SessionResultsSummary {
  const by_level: Record<MatchedAtLevel | 'pending' | 'missing', number> = {
    'pixel-perfect': 0,
    strict: 0,
    tolerant: 0,
    loose: 0,
    none: 0,
    pending: 0,
    missing: 0,
  };
  const by_acceptance_status: Record<
    import('../types.js').AcceptanceStatus,
    number
  > = {
    unaccepted: 0,
    accepted: 0,
    regressed: 0,
    expanded_diff: 0,
  };
  const by_decided_by: Record<MatchedDecidedBy | 'none', number> = {
    pixel: 0,
    lm: 0,
    none: 0,
  };
  const by_target_status: Record<
    'reached_target' | 'weaker_than_target' | 'pending',
    number
  > = {
    reached_target: 0,
    weaker_than_target: 0,
    pending: 0,
  };
  const by_pair_outcome: Record<PairOutcome, number> = {
    both_present: 0,
    a_missing: 0,
    b_missing: 0,
    both_missing: 0,
  };

  for (const r of rows) {
    // Missing-page rows have matched_at_level=null because no visual diff
    // was attempted. They are NOT pending — they're already classified by
    // pair_outcome. Bucket them separately so the histogram's `pending` cell
    // accurately reflects "rows still awaiting a verdict" and reviewers
    // aren't misled into thinking work is outstanding when it isn't.
    if (r.pair_outcome !== 'both_present') {
      by_level.missing += 1;
      // by_target_status: missing rows can never reach the target since no
      // diff ran. Counting them as 'weaker_than_target' would lump them
      // with real fails. Treat as 'pending' so the "is this comparison
      // settled?" lens stays honest about which rows still need attention
      // — none, in the missing case.
      by_target_status.pending += 1;
    } else if (r.matched_at_level === null) {
      by_level.pending += 1;
      by_target_status.pending += 1;
    } else {
      by_level[r.matched_at_level] += 1;
      by_target_status[
        isAtLeastAsStrict(r.matched_at_level, targetLevel)
          ? 'reached_target'
          : 'weaker_than_target'
      ] += 1;
    }
    by_decided_by[r.matched_decided_by ?? 'none'] += 1;
    by_acceptance_status[r.acceptance_status] += 1;
    by_pair_outcome[r.pair_outcome] += 1;
  }

  return {
    total: rows.length,
    by_level,
    by_acceptance_status,
    by_decided_by,
    by_target_status,
    by_pair_outcome,
  };
}

type MatchedDecidedBy = import('../types.js').MatchedDecidedBy;

/**
 * Compute the live results view for a session by joining `url_pairs` with
 * the cache substrate under the given config. Rows are emitted per (pair,
 * viewport, level). When data is missing the row is still emitted with
 * `status: 'pending'` so the UI can show progress against the full plan.
 */
export function readSessionResults(
  db: Db,
  sessionId: string,
  config: EvaluationConfig,
): SessionResultRow[] {
  const allPairs = listUrlPairs(db, sessionId);
  const enabledPairs = selectEnabledPairs(allPairs, config);

  const captureCacheLookup = db.prepare<
    [string, string, string],
    { screenshot_sha256: string; is_missing: number | null; capture_id: string }
  >(
    // Join captures to surface is_missing for the matching capture row. The
    // missing-page columns live on captures, not capture_cache, so a denormal
    // lookup is the cheapest path. is_missing is null for legacy rows that
    // predate the column; the row-builder treats null as 'not missing'.
    // capture_id flows through so is_stale can compare against the latest
    // captures row for (pair, viewport, side).
    `SELECT cc.screenshot_sha256, c.is_missing, cc.capture_id
       FROM capture_cache cc
       LEFT JOIN captures c ON c.id = cc.capture_id
      WHERE cc.url = ? AND cc.viewport_name = ? AND cc.capture_opts_hash = ?`,
  );

  // Batched "latest captures row per (pair, viewport, side)" for the session.
  // Used to compute `is_stale`: the displayed sha (from capture_cache) is
  // stale when the latest captures row for the same (pair, vp, side) is
  // different from the one the cache row points at — i.e. there's been a
  // more recent attempt that's pending, errored, or completed under a
  // different opts_hash. Single window-function pass, indexed via
  // idx_captures_pair + idx_captures_run.
  const latestCapturesByKey = loadLatestCapturesByKey(db, sessionId);

  const pixelCacheLookup = db.prepare<
    [string, string, string],
    {
      changed_pct: number | null;
      ssim: number | null;
      bbox_area_pct: number | null;
      component_count: number | null;
      im_diff_sha256: string | null;
      comparison_id: string;
    }
  >(
    `SELECT changed_pct, ssim, bbox_area_pct, component_count, im_diff_sha256, comparison_id
       FROM pixel_compare_cache
      WHERE capture_a_sha = ? AND capture_b_sha = ? AND pipeline_version = ?`,
  );

  const lmCacheLookup = db.prepare<
    [string, string, string, string, string, string, string],
    {
      verdict: number | null;
      summary: string | null;
      confidence: number | null;
      comparison_id: string;
    }
  >(
    `SELECT verdict, summary, confidence, comparison_id
       FROM lm_verdict_cache
      WHERE capture_a_sha = ? AND capture_b_sha = ? AND prompt_id = ?
        AND user_instruction_id = ? AND model_id = ? AND invocation_reason = ?
        AND pipeline_version = ?`,
  );

  // Diagnostic: when a side's sha is missing, find the most recent capture
  // attempt for that (url, viewport_name) within the session so we can tell
  // the user *why* the row is pending (capture errored vs. never attempted).
  const recentCaptureLookup = db.prepare<
    [string, string, string],
    { status: string; error_message: string | null }
  >(
    `SELECT c.status, c.error_message
       FROM captures c
       JOIN capture_runs cr ON cr.id = c.capture_run_id
      WHERE cr.session_id = ? AND c.url = ? AND c.viewport_name = ?
      ORDER BY c.created_at DESC
      LIMIT 1`,
  );

  const captureStatusFor = (
    cacheCaptureId: string | null,
    pairId: string,
    viewportName: string,
    side: 'a' | 'b',
    url: string,
  ): import('../types.js').CaptureStatusInfo => {
    const latest = latestCapturesByKey.get(`${pairId}::${viewportName}::${side}`);

    // No cache row: nothing to display. Status comes from the latest
    // captures row (if any) — this is the diagnostic-pending path for
    // first-ever captures and config-changed captures.
    if (cacheCaptureId === null) {
      if (!latest) {
        // Fall back to (url, viewport) lookup so config-changed sessions
        // that have captures under a different opts_hash still surface a
        // status. is_stale doesn't apply when there's no displayed sha.
        const row = recentCaptureLookup.get(sessionId, url, viewportName);
        if (!row) return { status: 'missing', error_message: null, is_stale: false };
        if (row.status === 'error') {
          return { status: 'error', error_message: row.error_message, is_stale: false };
        }
        if (row.status === 'complete') {
          return { status: 'missing', error_message: null, is_stale: false };
        }
        return { status: 'in_progress', error_message: null, is_stale: false };
      }
      if (latest.status === 'error') {
        return { status: 'error', error_message: latest.error_message, is_stale: false };
      }
      if (latest.status === 'complete') {
        // Latest captures row is complete but no cache row for the current
        // opts_hash — config-changed scenario. Treat as missing.
        return { status: 'missing', error_message: null, is_stale: false };
      }
      return { status: 'in_progress', error_message: null, is_stale: false };
    }

    // Cache row exists; we have a sha to display. Decide freshness by
    // comparing against the latest captures row for this (pair, vp, side).
    if (!latest || latest.capture_id === cacheCaptureId) {
      return { status: 'complete', error_message: null, is_stale: false };
    }
    if (latest.status === 'error') {
      return { status: 'error', error_message: latest.error_message, is_stale: true };
    }
    if (latest.status === 'complete') {
      // Newer complete capture exists but the cache row hasn't rolled
      // forward (different opts_hash). Displayed sha is stale relative to
      // the newer attempt; surface as complete-but-stale.
      return { status: 'complete', error_message: null, is_stale: true };
    }
    return { status: 'in_progress', error_message: null, is_stale: true };
  };

  // Pre-load acceptances and per-pair config overrides for the session so
  // each row's acceptance_status check is a hash lookup, not a query.
  const acceptanceByKey = new Map<string, AcceptanceRow>();
  for (const a of listAcceptances(db, sessionId)) {
    acceptanceByKey.set(`${a.url_pair_id}::${a.viewport_name}`, a);
  }
  const overrideByPair = new Map<string, UrlPairConfigOverrideRow>();
  for (const o of db
    .prepare<unknown[], UrlPairConfigOverrideRow>(
      `SELECT url_pair_id, equivalence_level, region_match_config_json, updated_at
         FROM url_pair_config_overrides
        WHERE url_pair_id IN (
          SELECT id FROM url_pairs WHERE session_id = ?
        )`,
    )
    .all(sessionId)) {
    overrideByPair.set(o.url_pair_id, o);
  }

  const imagickRegionsLookup = db.prepare<[string], { bounding_box_json: string }>(
    `SELECT bounding_box_json FROM differences
      WHERE comparison_id = ? AND source = 'imagick' AND bounding_box_json IS NOT NULL`,
  );

  // Phase ε: rule-provenance + cluster lookups so SessionResultRow can
  // surface the cluster a row belongs to + whether its acceptance came
  // from a cluster/category rule fan-out.
  const ruleScopeByRuleId = new Map<string, AcceptanceRuleScope>();
  for (const r of db
    .prepare<[string], { id: string; scope: AcceptanceRuleScope }>(
      `SELECT id, scope FROM acceptance_rules WHERE session_id = ?`,
    )
    .all(sessionId)) {
    ruleScopeByRuleId.set(r.id, r.scope);
  }

  // Primary cluster per comparison: the v1-signature cluster with the
  // highest pair_count this comparison participates in. Surfaces in
  // SessionResultRow.cluster_id so Rows-mode actions can target the
  // most-leverage cluster. Rows whose comparisons have only v0
  // (geometric) clusters get cluster_id = null — v0 clusters aren't
  // useful as "the row's cluster" since they don't carry the taxonomy.
  const primaryClusterByComparisonId = new Map<
    string,
    { cluster_id: string; review_state: ClusterReviewState }
  >();
  for (const row of db
    .prepare<[string], { comparison_id: string; cluster_id: string; review_state: ClusterReviewState }>(
      `SELECT DISTINCT
              c.id           AS comparison_id,
              dc.id          AS cluster_id,
              dc.review_state AS review_state,
              dc.pair_count  AS pair_count
         FROM comparisons c
         JOIN url_pairs   p  ON p.id = c.url_pair_id
         JOIN differences d  ON d.comparison_id = c.id AND d.signature_version = 'v1'
         JOIN difference_clusters dc
              ON dc.session_id        = p.session_id
             AND dc.signature         = d.signature
             AND dc.signature_version = 'v1'
        WHERE p.session_id = ?
        ORDER BY c.id, dc.pair_count DESC, dc.id`,
    )
    .all(sessionId)) {
    // First row per comparison_id (ORDER BY pair_count DESC) wins.
    if (!primaryClusterByComparisonId.has(row.comparison_id)) {
      primaryClusterByComparisonId.set(row.comparison_id, {
        cluster_id: row.cluster_id,
        review_state: row.review_state,
      });
    }
  }

  // Build a SessionConfig-shaped object for the resolver. The evaluator's
  // EvaluationConfig already carries target_level + region_match_config but
  // not in the SessionConfig shape; we synthesize one for resolvePairConfig.
  const sessionShape: SessionConfig = {
    default_viewports: config.viewports,
    default_capture_options: config.capture_options,
    default_equivalence_level: config.target_level,
    region_match_config: config.region_match_config,
    filter_query: config.filter_query,
    // Synthesized shape doesn't drive any pair-level decision in
    // resolvePairConfig; default to false so the field is well-defined.
    default_invoke_lm: false,
  };

  const out: SessionResultRow[] = [];
  for (const pair of enabledPairs) {
    for (const vp of config.viewports) {
      const optsHash = captureOptsHashFor(vp, config.capture_options);
      const aRow = captureCacheLookup.get(pair.url_a, vp.name, optsHash) ?? null;
      const bRow = captureCacheLookup.get(pair.url_b, vp.name, optsHash) ?? null;
      const aSha = aRow?.screenshot_sha256 ?? null;
      const bSha = bRow?.screenshot_sha256 ?? null;
      const aMissing = aRow?.is_missing === 1;
      const bMissing = bRow?.is_missing === 1;
      const pairOutcome: PairOutcome =
        aMissing && bMissing
          ? 'both_missing'
          : aMissing
            ? 'a_missing'
            : bMissing
              ? 'b_missing'
              : 'both_present';
      const captureAStatus = captureStatusFor(
        aRow?.capture_id ?? null,
        pair.id,
        vp.name,
        'a',
        pair.url_a,
      );
      const captureBStatus = captureStatusFor(
        bRow?.capture_id ?? null,
        pair.id,
        vp.name,
        'b',
        pair.url_b,
      );
      const acceptance = acceptanceByKey.get(`${pair.id}::${vp.name}`) ?? null;
      const pairOverride = overrideByPair.get(pair.id) ?? null;
      const resolved = resolvePairConfig(sessionShape, pairOverride);
      const row: SessionResultRow = {
        url_pair_id: pair.id,
        url_a: pair.url_a,
        url_b: pair.url_b,
        label: pair.label,
        viewport_name: vp.name,
        matched_at_level: null,
        matched_decided_by: null,
        capture_a_sha: aSha,
        capture_b_sha: bSha,
        comparison_id: null,
        capture_a_status: captureAStatus,
        capture_b_status: captureBStatus,
        pixel: null,
        lm: null,
        acceptance_status: acceptance ? 'accepted' : 'unaccepted',
        status: 'pending',
        pair_outcome: pairOutcome,
        // Phase ε: rule-provenance from the acceptance row, scope from
        // the rule-scope lookup. cluster_id + cluster_review_state are
        // filled in the post-loop pass once comparison_id is known.
        acceptance_rule_id: acceptance?.acceptance_rule_id ?? null,
        acceptance_rule_scope:
          acceptance?.acceptance_rule_id
            ? (ruleScopeByRuleId.get(acceptance.acceptance_rule_id) ?? null)
            : null,
        cluster_id: null,
        cluster_review_state: null,
      };

      // Missing-page rows are terminal: no visual diff was performed, so
      // there's nothing to look up in the pixel/LM caches. Mark the row
      // 'cached' (no further work expected) and emit it.
      if (pairOutcome !== 'both_present') {
        row.status = 'cached';
        out.push(row);
        continue;
      }

      if (aSha && bSha) {
        const pipelineVersion = pipelineVersionFor(config.target_level);
        const pixel = pixelCacheLookup.get(aSha, bSha, pipelineVersion);
        if (pixel) {
          row.pixel = {
            changed_pct: pixel.changed_pct,
            ssim: pixel.ssim,
            bbox_area_pct: pixel.bbox_area_pct,
            component_count: pixel.component_count,
            im_diff_sha256: pixel.im_diff_sha256,
          };
          // Default to the pixel-cache comparison_id; the LM branch below
          // overrides it when an LM verdict is the source of truth.
          row.comparison_id = pixel.comparison_id;
          const { pixelMatchedAtLevel, inTargetAmbiguityBand } = computeMatchedAtLevel({
            changedPixelPercentage: pixel.changed_pct ?? 0,
            ssim: pixel.ssim,
            targetLevel: config.target_level,
          });
          // Read-side gate: probe the LM cache whenever an LM verdict
          // *could* exist for this row, regardless of `config.invoke_lm`.
          // The flag governs whether a NEW LM call fires on a cache miss
          // (planner's job); for display, we always surface a persisted
          // verdict. Without this, toggling "LM second pass" off would hide
          // verdicts the user already paid for and confuse the list-vs-detail
          // sync.
          let lmReason: LmInvocationReason | null = null;
          if (inTargetAmbiguityBand) {
            lmReason = 'ambiguous_pixel_result';
          } else if (!isAtLeastAsStrict(pixelMatchedAtLevel, config.target_level)) {
            lmReason = 'target_level_failure';
          }
          let lm:
            | { verdict: number | null; summary: string | null; confidence: number | null; comparison_id: string }
            | null = null;
          if (lmReason) {
            const promptId = lookupPromptId(config, lmReason);
            lm = promptId
              ? lmCacheLookup.get(
                  aSha,
                  bSha,
                  promptId,
                  userInstructionTemplateId(lmReason, {
                    includeDiffImage: config.lm_include_diff_image,
                  }),
                  config.lm_model_id,
                  lmReason,
                  pipelineVersion,
                ) ?? null
              : null;
          }
          if (lmReason && lm) {
            // IM-area guardrail (mirrors the write-side check in
            // runOneComparison). A vision LM that returned equivalent
            // while the IM pipeline found more than the override
            // threshold of changed-pixel area is treated as having not
            // engaged with the diff; we keep the pixel walk's verdict
            // and flip matched_decided_by back to 'pixel'. Applying it
            // here too means the histogram and filter chips reflect the
            // corrected verdict on every read, even when the
            // lm_verdict_cache still carries the raw equivalent=1 (e.g.
            // for rows persisted before this guardrail existed).
            const bboxAreaPct = pixel.bbox_area_pct ?? 0;
            const imAreaOverride =
              lm.verdict === 1 && bboxAreaPct > IM_AREA_OVERRIDE_THRESHOLD_PCT;
            const effectivelyEquivalent = lm.verdict === 1 && !imAreaOverride;
            const summaryForRow = imAreaOverride
              ? `[im_area_override ${bboxAreaPct.toFixed(1)}%>${IM_AREA_OVERRIDE_THRESHOLD_PCT}%] ${lm.summary ?? ''}`
              : lm.summary;
            row.lm = {
              invocation_reason: lmReason,
              verdict: lm.verdict,
              diff_summary: summaryForRow,
              confidence: lm.confidence,
            };
            row.matched_decided_by = imAreaOverride ? 'pixel' : 'lm';
            row.matched_at_level = effectivelyEquivalent
              ? config.target_level
              : pixelMatchedAtLevel;
            row.comparison_id = lm.comparison_id;
            row.status = 'cached';
          } else if (lmReason && config.invoke_lm) {
            // LM call would fire on next eval but no cached verdict yet —
            // keep the row pending so the UI can show "review pending".
          } else {
            // Either no LM is needed (pixel reached target) or invoke_lm is
            // off and there's no cached verdict — surface pixel-only.
            row.matched_at_level = pixelMatchedAtLevel;
            row.matched_decided_by = 'pixel';
            row.status = 'cached';
          }

          // Acceptance check: only meaningful once we have a definitive
          // matched_at_level. Pending rows (LM cache missing) keep the
          // optimistic 'accepted' label set above; the read-time check is
          // re-run after the LM call lands.
          if (row.matched_at_level !== null && acceptance) {
            const regions = parseImagickRegions(
              row.comparison_id,
              imagickRegionsLookup,
            );
            row.acceptance_status = computeAcceptanceStatus({
              acceptance,
              current: {
                matched_at_level: row.matched_at_level,
                pixel_pct: pixel.changed_pct,
                regions,
              },
              config: resolved.region_match_config,
            });
          }
        }
      }
      out.push(row);
    }
  }
  // Phase ε post-pass: attach the row's primary cluster (highest-leverage
  // v1 cluster the comparison participates in). Done after the build loop
  // because comparison_id can be set in either the pixel-cache or LM-cache
  // branch above; one final walk avoids threading the assignment through
  // every push site.
  for (const row of out) {
    if (!row.comparison_id) continue;
    const primary = primaryClusterByComparisonId.get(row.comparison_id);
    if (!primary) continue;
    row.cluster_id = primary.cluster_id;
    row.cluster_review_state = primary.review_state;
  }
  return out;
}

function parseImagickRegions(
  comparisonId: string | null,
  lookup: ReturnType<Db['prepare']>,
): BoundingBoxPercent[] {
  if (!comparisonId) return [];
  const rows = (lookup as unknown as {
    all(id: string): { bounding_box_json: string }[];
  }).all(comparisonId);
  const out: BoundingBoxPercent[] = [];
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.bounding_box_json);
      if (parsed && typeof parsed === 'object') out.push(parsed as BoundingBoxPercent);
    } catch {
      // Skip malformed rows.
    }
  }
  return out;
}
