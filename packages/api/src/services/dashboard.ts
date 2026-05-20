import type { Db } from '../db/client.js';
import type { LmClient } from './lm.js';
import {
  listChangedPairKeysSince,
  listEvaluations,
  loadSessionPromptIds,
  planEvaluation,
  readSessionResults,
  resolveEvaluationConfig,
  summariseResults,
  type EvaluationConfig,
  type EvaluationConfigInput,
} from './evaluator.js';
import { getEvaluation } from './evaluator.js';
import { computeCaptureEta, type CaptureEta } from './capture-eta.js';
import { getSessionConfig } from './sessions.js';
import { parseEvaluationRow } from '../routes/evaluations.js';
import type {
  EvaluationStatusDto,
  SessionResultsSummary,
} from '../types.js';

/**
 * Per-session "review dashboard" aggregate. Folds the three highest-rate
 * pollers a session-detail page used to fire independently:
 *
 *   - `/api/evaluations/:id`                         (1.5s, PlanAndEvaluate)
 *   - `/api/sessions/:id/results?since=<cursor>`     (5s, delta tick)
 *   - `/api/sessions/:id/capture-eta`                (2.5s, useCaptureEta)
 *
 * Into a single request the client polls at the fastest cadence the
 * dashboard cares about. ETag (Express default) still 304s the whole
 * payload when nothing has moved.
 *
 * `since` is optional — when omitted, `results_delta` is null and callers
 * should hit `/results` for the initial full payload. `eval_id` is also
 * optional — when present, `evaluation` is fetched for that id; otherwise
 * we fall back to the session's most-recent evaluation row.
 *
 * Read-only; no DB writes here.
 */

export interface ReviewDashboardResultsDelta {
  plan: {
    enabled_pair_count: number;
    capture_misses: number;
    comparison_misses: number;
    cache_hits: { captures: number; pixel: number; lm: number };
  };
  summary: SessionResultsSummary;
  cursor: string;
  latest_evaluation: EvaluationStatusDto | null;
  changed_pair_keys: string[];
}

export interface ReviewDashboard {
  session_id: string;
  evaluation: EvaluationStatusDto | null;
  results_delta: ReviewDashboardResultsDelta | null;
  capture_eta: CaptureEta;
  /** Resolved config used to compute `results_delta`. Echoed for parity with /results. */
  config: EvaluationConfig | null;
}

export interface ComputeReviewDashboardOptions {
  /** ISO timestamp — when present the response includes results_delta. */
  since?: string;
  /** Specific evaluation id to fetch; falls back to most-recent. */
  evaluationId?: string;
  /** Optional EvaluationConfigInput override (typically empty for the dashboard). */
  configInput?: EvaluationConfigInput;
}

export function computeReviewDashboard(
  db: Db,
  sessionId: string,
  lm: LmClient | undefined,
  opts: ComputeReviewDashboardOptions = {},
): ReviewDashboard {
  // Capture cursor BEFORE running queries so a comparison completing
  // during this request gets reported on the next tick (matches the
  // /results?since= behavior).
  const cursor = opts.since ? new Date().toISOString() : null;

  // Resolve config once; both results_delta and (potentially) future
  // sub-fields need it.
  let config: EvaluationConfig | null = null;
  if (opts.since) {
    const sessionConfig = getSessionConfig(db, sessionId) ?? undefined;
    const promptIds = loadSessionPromptIds(db, sessionId, lm);
    config = resolveEvaluationConfig(opts.configInput, sessionConfig, lm, promptIds);
  }

  let results_delta: ReviewDashboardResultsDelta | null = null;
  if (opts.since && cursor && config) {
    const plan = planEvaluation(db, sessionId, config);
    const fullResults = readSessionResults(db, sessionId, config);
    const summary = summariseResults(fullResults, config.target_level);
    const changed = listChangedPairKeysSince(db, sessionId, opts.since);
    const evalRows = listEvaluations(db, sessionId);
    const latestEvaluation =
      evalRows.length > 0 ? parseEvaluationRow(db, evalRows[0]!) : null;
    results_delta = {
      plan: {
        enabled_pair_count: plan.enabled_pair_count,
        capture_misses: plan.capture_misses.length,
        comparison_misses: plan.comparison_misses.length,
        cache_hits: plan.cache_hits,
      },
      summary,
      cursor,
      latest_evaluation: latestEvaluation,
      changed_pair_keys: changed,
    };
  }

  // Evaluation lookup: explicit id wins; fall back to most-recent row.
  let evaluation: EvaluationStatusDto | null = null;
  if (opts.evaluationId) {
    const row = getEvaluation(db, opts.evaluationId);
    evaluation = row ? parseEvaluationRow(db, row) : null;
  } else {
    // Reuse results_delta's listEvaluations result if we already loaded it.
    const candidate =
      results_delta?.latest_evaluation ??
      (() => {
        const rows = listEvaluations(db, sessionId);
        return rows.length > 0 ? parseEvaluationRow(db, rows[0]!) : null;
      })();
    evaluation = candidate;
  }

  return {
    session_id: sessionId,
    evaluation,
    results_delta,
    capture_eta: computeCaptureEta(db, sessionId),
    config,
  };
}
