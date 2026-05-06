import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { ArtifactStore } from './artifact-store.js';
import type { CaptureWorker } from './capture.js';
import type { ComparisonImagick } from './comparison.js';
import type { LmClient } from './lm.js';
import type { JobQueue } from './queue.js';
import {
  captureRunOptionsSchema,
  startCaptureRun,
  type CaptureRunOptionsParsed,
} from './capture.js';
import {
  startComparisonRunForPairs,
  type ExplicitComparisonPair,
} from './comparison.js';
import { getSessionConfig, listUrlPairs } from './sessions.js';
import { decideEquivalence } from './equivalence.js';
import { captureOptsHashFor } from './capture-opts-hash.js';
import { PIPELINE_VERSION } from '../constants/pipeline.js';
import {
  DEFAULT_VIEWPORTS,
  DEFAULT_VIEWPORT_NAME,
} from '../constants/viewports.js';
import { DEFAULT_EQUIVALENCE_LEVEL } from '../constants/equivalence.js';
import type {
  AllowListEntry,
  CaptureSide,
  EquivalenceLevelId,
  FilterQuery,
  LmInvocationReason,
  SessionConfig,
  UrlPairRow,
  ViewportDef,
} from '../types.js';

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
  'semantic',
]);

export const evaluationConfigInputSchema = z
  .object({
    viewports: z.array(viewportSchema).min(1).optional(),
    equivalence_levels: z.array(equivalenceLevelSchema).min(1).optional(),
    capture_options: z.record(z.unknown()).optional(),
    url_pair_ids: z.array(z.string()).optional(),
    lm_prompt_id: z.string().min(1).optional(),
    lm_model_id: z.string().min(1).optional(),
  })
  .strict();

export type EvaluationConfigInput = z.infer<typeof evaluationConfigInputSchema>;

export interface EvaluationConfig {
  viewports: ViewportDef[];
  equivalence_levels: EquivalenceLevelId[];
  capture_options: CaptureRunOptionsParsed;
  /**
   * Explicit pair selection. When non-null, takes precedence over
   * `filter_query`. Null means "use the filter."
   */
  url_pair_ids: string[] | null;
  filter_query: FilterQuery;
  allow_list: AllowListEntry[];
  lm_prompt_id: string;
  lm_model_id: string;
}

export interface PlannedCapture {
  url_pair_id: string;
  viewport_name: string;
  side: CaptureSide;
  url: string;
}

export interface PlannedComparison {
  url_pair_id: string;
  viewport_name: string;
  level: EquivalenceLevelId;
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
 * Resolve an EvaluationConfigInput into the fully-defaulted config the
 * planner needs. Precedence (highest to lowest):
 *   1. Per-call overrides (`input`).
 *   2. Session config (`session`), when supplied.
 *   3. System defaults (constants files, LM client).
 *
 * `url_pair_ids` from `input` takes precedence over `filter_query` from
 * `session` — explicit pair selection trumps the DSL.
 */
export function resolveEvaluationConfig(
  input: EvaluationConfigInput | undefined,
  session: SessionConfig | undefined,
  lm: LmClient | undefined,
): EvaluationConfig {
  const sessionViewports = session?.default_viewports ?? [];
  const sessionLevels = session?.default_equivalence_levels ?? [];

  const viewports =
    input?.viewports ??
    (sessionViewports.length > 0
      ? sessionViewports
      : DEFAULT_VIEWPORTS.filter((v) => v.name === DEFAULT_VIEWPORT_NAME));

  const equivalence_levels =
    input?.equivalence_levels ??
    (sessionLevels.length > 0 ? sessionLevels : [DEFAULT_EQUIVALENCE_LEVEL]);

  const capture_options = captureRunOptionsSchema.parse({
    ...(session?.default_capture_options ?? {}),
    ...(input?.capture_options ?? {}),
    viewports,
  });

  const lm_prompt_id =
    input?.lm_prompt_id ?? lm?.config.promptVersion ?? 'unknown';
  const lm_model_id = input?.lm_model_id ?? lm?.config.model ?? 'unknown';

  return {
    viewports,
    equivalence_levels,
    capture_options,
    url_pair_ids: input?.url_pair_ids ?? null,
    filter_query: session?.filter_query ?? {},
    allow_list: session?.allow_list ?? [],
    lm_prompt_id,
    lm_model_id,
  };
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
      if (!p.path || !p.path.startsWith(filter.path_prefix)) return false;
    }
    return true;
  });
}

/** True iff the (pair, level, viewport) triple matches an allow-list entry. */
export function isAllowListed(
  allow: AllowListEntry[],
  url_pair_id: string,
  level: EquivalenceLevelId,
  viewport_name: string,
): boolean {
  return allow.some(
    (a) =>
      a.url_pair_id === url_pair_id &&
      a.level === level &&
      a.viewport_name === viewport_name,
  );
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

  const captureCacheLookup = db.prepare<
    [string, string, string],
    CaptureCacheRow
  >(
    `SELECT url, viewport_name, capture_opts_hash, screenshot_sha256, capture_id
       FROM capture_cache
      WHERE url = ? AND viewport_name = ? AND capture_opts_hash = ?`,
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
    [string, string, string, string, string, string],
    { capture_a_sha: string }
  >(
    `SELECT capture_a_sha
       FROM lm_verdict_cache
      WHERE capture_a_sha = ? AND capture_b_sha = ? AND prompt_id = ?
        AND model_id = ? AND invocation_reason = ? AND pipeline_version = ?`,
  );

  const capture_misses: PlannedCapture[] = [];
  const captureShaByKey = new Map<string, string>(); // pair_id::vp_name::side → sha
  let captureHits = 0;

  for (const pair of enabledPairs) {
    for (const vp of config.viewports) {
      const optsHash = captureOptsHashFor(vp, config.capture_options);
      for (const side of SIDES) {
        const url = side === 'a' ? pair.url_a : pair.url_b;
        const cached = captureCacheLookup.get(url, vp.name, optsHash);
        if (cached) {
          captureShaByKey.set(`${pair.id}::${vp.name}::${side}`, cached.screenshot_sha256);
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

  for (const pair of enabledPairs) {
    for (const vp of config.viewports) {
      const aSha = captureShaByKey.get(`${pair.id}::${vp.name}::a`) ?? null;
      const bSha = captureShaByKey.get(`${pair.id}::${vp.name}::b`) ?? null;
      for (const level of config.equivalence_levels) {
        if (!aSha || !bSha) {
          comparison_misses.push({
            url_pair_id: pair.id,
            viewport_name: vp.name,
            level,
            capture_a_sha: aSha,
            capture_b_sha: bSha,
          });
          continue;
        }
        const pixel = pixelCacheLookup.get(aSha, bSha, PIPELINE_VERSION);
        if (!pixel) {
          comparison_misses.push({
            url_pair_id: pair.id,
            viewport_name: vp.name,
            level,
            capture_a_sha: aSha,
            capture_b_sha: bSha,
          });
          continue;
        }
        pixelHits += 1;

        const decision = decideEquivalence({
          level,
          changedPixelPercentage: pixel.changed_pct ?? 0,
          ssim: pixel.ssim,
        });
        const reason: LmInvocationReason | null = decision.lmInvocationReason;
        if (reason !== null) {
          const lmHit = lmCacheLookup.get(
            aSha,
            bSha,
            config.lm_prompt_id,
            config.lm_model_id,
            reason,
            PIPELINE_VERSION,
          );
          if (!lmHit) {
            comparison_misses.push({
              url_pair_id: pair.id,
              viewport_name: vp.name,
              level,
              capture_a_sha: aSha,
              capture_b_sha: bSha,
            });
            continue;
          }
          lmHits += 1;
        }
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
}

interface EvaluationRow {
  id: string;
  session_id: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  capture_run_id: string | null;
  comparison_run_ids: string;
  cache_hits: string;
  config_snapshot_json: string;
  enabled_pair_count: number;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

export class Evaluator {
  #deps: EvaluatorDeps;
  #pending = new Map<string, Promise<void>>();

  constructor(deps: EvaluatorDeps) {
    this.#deps = deps;
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
    const config = resolveEvaluationConfig(configInput, sessionConfig, this.#deps.lm);
    const initialPlan = planEvaluation(db, sessionId, config);

    const evaluationId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO evaluations
         (id, session_id, config_snapshot_json, enabled_pair_count,
          capture_run_id, comparison_run_ids, cache_hits, status, started_at)
         VALUES (?, ?, ?, ?, NULL, '[]', '{}', 'pending', ?)`,
    ).run(
      evaluationId,
      sessionId,
      JSON.stringify(config),
      initialPlan.enabled_pair_count,
      now,
    );

    const promise = this.#orchestrate(evaluationId, sessionId, config, initialPlan)
      .catch((err) => {
        // Already recorded inside #orchestrate; swallow so unhandled rejection
        // doesn't crash the process.
        // eslint-disable-next-line no-console
        console.error(`[evaluator] orchestration failed: ${(err as Error).message}`);
      })
      .finally(() => {
        this.#pending.delete(evaluationId);
      });
    this.#pending.set(evaluationId, promise);

    return { evaluation_id: evaluationId, coalesced: false };
  }

  /** Promise that resolves once the named evaluation finishes orchestrating. */
  waitFor(evaluationId: string): Promise<void> | undefined {
    return this.#pending.get(evaluationId);
  }

  /** Wait for every in-flight evaluation. Used by tests. */
  async drainAll(): Promise<void> {
    while (this.#pending.size > 0) {
      const pending = [...this.#pending.values()];
      await Promise.all(pending);
    }
  }

  async #orchestrate(
    evaluationId: string,
    sessionId: string,
    config: EvaluationConfig,
    initialPlan: EvaluationPlan,
  ): Promise<void> {
    const { db, queue } = this.#deps;
    db.prepare(`UPDATE evaluations SET status = 'running' WHERE id = ?`).run(evaluationId);

    try {
      // 1) Capture run for missing captures.
      let captureRunId: string | null = null;
      if (initialPlan.capture_misses.length > 0) {
        const missingPairIds = Array.from(
          new Set(initialPlan.capture_misses.map((c) => c.url_pair_id)),
        );
        const missingViewportNames = new Set(
          initialPlan.capture_misses.map((c) => c.viewport_name),
        );
        const captureViewports = config.viewports.filter((v) =>
          missingViewportNames.has(v.name),
        );
        const captureOpts = captureRunOptionsSchema.parse({
          ...config.capture_options,
          viewports: captureViewports,
          urlPairIds: missingPairIds,
        });
        const captureResult = startCaptureRun(this.#deps, {
          sessionId,
          options: captureOpts,
        });
        captureRunId = captureResult.capture_run_id;
        db.prepare(`UPDATE evaluations SET capture_run_id = ? WHERE id = ?`).run(
          captureRunId,
          evaluationId,
        );
        const wait = queue.waitForJob(captureResult.job_id);
        if (wait) await wait;
      }

      // 2) Re-plan now that captures are written. Determine remaining
      //    comparison work and resolve sha pairs to capture-row ids.
      const plan2 = planEvaluation(db, sessionId, config);
      const captureRowsByPair = this.#loadCapturesForMisses(plan2.comparison_misses);

      // 3) One comparison run per equivalence level, scoped to the (pair,
      //    viewport) entries that level actually needs.
      const fallbackCaptureRunId = captureRunId ?? this.#anyCaptureRunForSession(sessionId);
      const comparisonRunIds: string[] = [];

      for (const level of config.equivalence_levels) {
        const pairs: ExplicitComparisonPair[] = [];
        for (const m of plan2.comparison_misses) {
          if (m.level !== level) continue;
          const key = `${m.url_pair_id}::${m.viewport_name}`;
          const ids = captureRowsByPair.get(key);
          if (!ids?.a || !ids?.b) continue;
          pairs.push({
            url_pair_id: m.url_pair_id,
            viewport_name: m.viewport_name,
            capture_a_id: ids.a,
            capture_b_id: ids.b,
          });
        }
        if (pairs.length === 0) continue;
        if (!fallbackCaptureRunId) {
          throw new Error(
            'No capture run available to associate with this comparison run; ' +
              'this should be impossible when comparisons are missing.',
          );
        }
        const result = startComparisonRunForPairs(this.#deps, {
          sessionId,
          captureRunId: fallbackCaptureRunId,
          options: { equivalenceLevel: level },
          pairs,
        });
        comparisonRunIds.push(result.comparison_run_id);
        const wait = queue.waitForJob(result.job_id);
        if (wait) await wait;
      }

      // 4) Recompute cache_hits from the final state and mark complete.
      const finalPlan = planEvaluation(db, sessionId, config);
      db.prepare(
        `UPDATE evaluations
           SET status = 'complete',
               comparison_run_ids = ?,
               cache_hits = ?,
               completed_at = ?
         WHERE id = ?`,
      ).run(
        JSON.stringify(comparisonRunIds),
        JSON.stringify(finalPlan.cache_hits),
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

export function listEvaluations(db: Db, sessionId: string): EvaluationRow[] {
  return db
    .prepare<[string], EvaluationRow>(
      `SELECT * FROM evaluations WHERE session_id = ? ORDER BY started_at DESC`,
    )
    .all(sessionId);
}

export interface SessionResultRow {
  url_pair_id: string;
  url_a: string;
  url_b: string;
  label: string | null;
  viewport_name: string;
  level: EquivalenceLevelId;
  capture_a_sha: string | null;
  capture_b_sha: string | null;
  pixel: {
    changed_pct: number | null;
    ssim: number | null;
    bbox_area_pct: number | null;
    component_count: number | null;
    im_diff_sha256: string | null;
  } | null;
  lm: {
    invocation_reason: LmInvocationReason;
    verdict: number | null;
    summary: string | null;
    confidence: number | null;
  } | null;
  is_equivalent: number | null;
  /** True when an allow-list entry matches this (pair, level, viewport). */
  is_allowed: boolean;
  status: 'pending' | 'cached';
}

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
    { screenshot_sha256: string }
  >(
    `SELECT screenshot_sha256 FROM capture_cache
       WHERE url = ? AND viewport_name = ? AND capture_opts_hash = ?`,
  );

  const pixelCacheLookup = db.prepare<
    [string, string, string],
    {
      changed_pct: number | null;
      ssim: number | null;
      bbox_area_pct: number | null;
      component_count: number | null;
      im_diff_sha256: string | null;
    }
  >(
    `SELECT changed_pct, ssim, bbox_area_pct, component_count, im_diff_sha256
       FROM pixel_compare_cache
      WHERE capture_a_sha = ? AND capture_b_sha = ? AND pipeline_version = ?`,
  );

  const lmCacheLookup = db.prepare<
    [string, string, string, string, string, string],
    { verdict: number | null; summary: string | null; confidence: number | null }
  >(
    `SELECT verdict, summary, confidence
       FROM lm_verdict_cache
      WHERE capture_a_sha = ? AND capture_b_sha = ? AND prompt_id = ?
        AND model_id = ? AND invocation_reason = ? AND pipeline_version = ?`,
  );

  const out: SessionResultRow[] = [];
  for (const pair of enabledPairs) {
    for (const vp of config.viewports) {
      const optsHash = captureOptsHashFor(vp, config.capture_options);
      const aSha =
        captureCacheLookup.get(pair.url_a, vp.name, optsHash)?.screenshot_sha256 ??
        null;
      const bSha =
        captureCacheLookup.get(pair.url_b, vp.name, optsHash)?.screenshot_sha256 ??
        null;
      for (const level of config.equivalence_levels) {
        const row: SessionResultRow = {
          url_pair_id: pair.id,
          url_a: pair.url_a,
          url_b: pair.url_b,
          label: pair.label,
          viewport_name: vp.name,
          level,
          capture_a_sha: aSha,
          capture_b_sha: bSha,
          pixel: null,
          lm: null,
          is_equivalent: null,
          is_allowed: isAllowListed(config.allow_list, pair.id, level, vp.name),
          status: 'pending',
        };

        if (aSha && bSha) {
          const pixel = pixelCacheLookup.get(aSha, bSha, PIPELINE_VERSION);
          if (pixel) {
            row.pixel = pixel;
            const decision = decideEquivalence({
              level,
              changedPixelPercentage: pixel.changed_pct ?? 0,
              ssim: pixel.ssim,
            });
            if (decision.lmInvocationReason) {
              const lm = lmCacheLookup.get(
                aSha,
                bSha,
                config.lm_prompt_id,
                config.lm_model_id,
                decision.lmInvocationReason,
                PIPELINE_VERSION,
              );
              if (lm) {
                row.lm = {
                  invocation_reason: decision.lmInvocationReason,
                  verdict: lm.verdict,
                  summary: lm.summary,
                  confidence: lm.confidence,
                };
                row.is_equivalent = lm.verdict;
                row.status = 'cached';
              }
            } else if (decision.imDeterminedEquivalent !== null) {
              row.is_equivalent = decision.imDeterminedEquivalent ? 1 : 0;
              row.status = 'cached';
            }
          }
        }
        out.push(row);
      }
    }
  }
  return out;
}
