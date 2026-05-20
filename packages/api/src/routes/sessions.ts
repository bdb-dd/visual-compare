import { Router } from 'express';
import multer from 'multer';
import type { Db } from '../db/client.js';
import type { LmClient } from '../services/lm.js';
import { parseSessionCsv } from '../services/csv.js';
import {
  addUrlPairs,
  addUrlPairsInputSchema,
  createSession,
  deleteSession,
  getSession,
  getSessionConfig,
  listSessions,
  listUrlPairs,
  patchUrlPair,
  patchUrlPairInputSchema,
  rowToSessionConfig,
  sessionConfigSchema,
  updateSession,
  updateSessionConfig,
} from '../services/sessions.js';
import {
  evaluationConfigInputSchema,
  listChangedPairKeysSince,
  listEvaluations,
  loadSessionPromptIds,
  planEvaluation,
  readSessionResults,
  resolveEvaluationConfig,
  summariseResults,
  type Evaluator,
} from '../services/evaluator.js';
import { parseEvaluationRow } from './evaluations.js';
import {
  buildSessionPromptView,
  getSessionPrompt,
  listSessionPrompts,
  resetSessionPromptToDefault,
  updateSessionPrompt,
  updateSessionPromptStructured,
  type LmPromptInvocationReason,
} from '../services/lm-prompts.js';
import { promptGuidanceSchema } from '../services/lm-prompt-guidance.js';
import { computeCaptureEta } from '../services/capture-eta.js';
import { computeReviewDashboard } from '../services/dashboard.js';
import {
  acceptanceInputSchema,
  deleteAcceptance,
  listAcceptances,
  upsertAcceptance,
} from '../services/acceptances.js';
import { clustersRouter } from './clusters.js';
import { z } from 'zod';
import type { PairOutcome } from '../types.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MiB
});

const PAIR_OUTCOME_VALUES = new Set<string>([
  'both_present',
  'a_missing',
  'b_missing',
  'both_missing',
]);

/**
 * Scope for a recapture request. The route translates this into an
 * EvaluationConfig with `force_recapture` set, so the recapture flows
 * through the standard evaluator orchestrator (captures + comparisons in
 * parallel, Stop button works, etc.).
 *
 *   {}                          → every enabled pair, both sides
 *   { side: 'b' }               → every enabled pair, B side
 *   { pair_ids: [...] }         → those pairs, both sides
 *   { pair_ids: [...], side:'a'}→ those pairs, A side only
 */
const recaptureScopeSchema = z
  .object({
    pair_ids: z.array(z.string().min(1)).optional(),
    side: z.enum(['a', 'b']).optional(),
  })
  .strict();

export interface SessionsRouterDeps {
  db: Db;
  evaluator: Evaluator;
  lm?: LmClient;
}

export function sessionsRouter(deps: SessionsRouterDeps): Router {
  const { db, evaluator, lm } = deps;
  const router = Router();

  router.get('/', (req, res) => {
    const include_archived = req.query.include_archived === 'true';
    res.json({ sessions: listSessions(db, { include_archived }) });
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
      config: rowToSessionConfig(session),
      url_pairs: listUrlPairs(db, id),
    });
  });

  router.patch('/:id', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'id is required' });
      return;
    }
    try {
      const updated = updateSession(db, id, req.body ?? {});
      if (!updated) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ session: updated, config: rowToSessionConfig(updated) });
    } catch (err) {
      res.status(400).json({
        error: 'invalid_patch',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/:id/config', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'id is required' });
      return;
    }
    const config = getSessionConfig(db, id);
    if (!config) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ config });
  });

  router.put('/:id/config', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'id is required' });
      return;
    }
    const parsed = sessionConfigSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_config',
        message: parsed.error.message,
        issues: parsed.error.issues,
      });
      return;
    }
    const updated = updateSessionConfig(db, id, parsed.data);
    if (!updated) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ config: updated });
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

  router.post('/:id/evaluate', (req, res) => {
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
    const parsed = evaluationConfigInputSchema.safeParse(req.body?.config ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_config',
        message: parsed.error.message,
        issues: parsed.error.issues,
      });
      return;
    }
    const result = evaluator.start(id, parsed.data);
    res.status(202).json(result);
  });

  router.get('/:id/results', (req, res) => {
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
    let configInput: unknown = {};
    if (typeof req.query.config === 'string' && req.query.config.length > 0) {
      try {
        configInput = JSON.parse(req.query.config);
      } catch {
        res.status(400).json({
          error: 'invalid_config',
          message: 'config query param must be valid JSON',
        });
        return;
      }
    }
    const parsed = evaluationConfigInputSchema.safeParse(configInput);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_config', message: parsed.error.message });
      return;
    }
    const sessionConfig = getSessionConfig(db, id) ?? undefined;
    const promptIds = loadSessionPromptIds(db, id, lm);
    const config = resolveEvaluationConfig(parsed.data, sessionConfig, lm, promptIds);

    // Delta poll mode: ?since=<iso> returns a tiny payload (plan + summary +
    // latest_evaluation + changed_pair_keys + cursor) without the rows. The
    // client follows up with ?keys=<list> to fetch the actual changed rows.
    // Captured BEFORE we run any queries so a comparison completing during
    // this request still gets reported on the next tick.
    const sinceParam = req.query.since;
    const since =
      typeof sinceParam === 'string' && /\d{4}-\d{2}-\d{2}T/.test(sinceParam)
        ? sinceParam
        : null;
    if (since) {
      const cursor = new Date().toISOString();
      const plan = planEvaluation(db, id, config);
      // The delta poll only needs counts + per-bucket summary, so we still
      // run readSessionResults to compute summary. This is the heavy part of
      // a normal /results call but it's CPU-only on the server (no rows
      // serialized to the client). If it ever becomes a bottleneck we can
      // extend summariseResults to accept the planner output directly.
      const fullResults = readSessionResults(db, id, config);
      const summary = summariseResults(fullResults, config.target_level);
      const changed = listChangedPairKeysSince(db, id, since);
      const evalRows = listEvaluations(db, id);
      const latestEvaluation = evalRows.length > 0
        ? parseEvaluationRow(db, evalRows[0]!)
        : null;
      res.json({
        session_id: id,
        config,
        plan: {
          enabled_pair_count: plan.enabled_pair_count,
          capture_misses: plan.capture_misses.length,
          comparison_misses: plan.comparison_misses.length,
          cache_hits: plan.cache_hits,
        },
        results: [],
        summary,
        changed_pair_keys: changed,
        cursor,
        latest_evaluation: latestEvaluation,
      });
      return;
    }

    const plan = planEvaluation(db, id, config);
    const results = readSessionResults(db, id, config);

    // Optional pair_outcome filter. Summary is computed over the unfiltered
    // set so chip counts reflect totals regardless of the active filter.
    const summary = summariseResults(results, config.target_level);
    const outcomeParam = req.query.outcome;
    const outcomeFilter =
      typeof outcomeParam === 'string' && PAIR_OUTCOME_VALUES.has(outcomeParam)
        ? (outcomeParam as PairOutcome)
        : null;

    // ?keys=<a::b,c::d> returns only the rows for those compound keys —
    // used by the polling client after a delta tick reports changed_pair_keys.
    // Unknown keys are silently dropped (consistent with summary chips
    // computed over the unfiltered set).
    const keysParam = req.query.keys;
    const keysFilter =
      typeof keysParam === 'string' && keysParam.length > 0
        ? new Set(keysParam.split(',').filter((k) => k.includes('::')))
        : null;

    let filteredResults = results;
    if (outcomeFilter) {
      filteredResults = filteredResults.filter((r) => r.pair_outcome === outcomeFilter);
    }
    if (keysFilter) {
      filteredResults = filteredResults.filter((r) =>
        keysFilter.has(`${r.url_pair_id}::${r.viewport_name}`),
      );
    }

    res.json({
      session_id: id,
      config,
      plan: {
        enabled_pair_count: plan.enabled_pair_count,
        capture_misses: plan.capture_misses.length,
        comparison_misses: plan.comparison_misses.length,
        cache_hits: plan.cache_hits,
      },
      results: filteredResults,
      summary,
    });
  });

  router.get('/:id/lm-prompts', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'id is required' });
      return;
    }
    if (!getSession(db, id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const rows = listSessionPrompts(db, id);
    res.json({ prompts: rows.map((r) => buildSessionPromptView(db, r)) });
  });

  const promptReasonSchema = z.enum(['target_level_failure', 'ambiguous_pixel_result']);
  // Discriminated union: structured (toggles + house_rules) or advanced (raw text).
  const promptBodySchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('structured'), guidance: promptGuidanceSchema }).strict(),
    z.object({ mode: z.literal('advanced'), prompt_text: z.string().min(1) }).strict(),
  ]);

  router.get('/:id/lm-prompts/:reason', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'id is required' });
      return;
    }
    const reasonParse = promptReasonSchema.safeParse(req.params.reason);
    if (!reasonParse.success) {
      res.status(400).json({ error: 'invalid_reason' });
      return;
    }
    const row = getSessionPrompt(db, id, reasonParse.data as LmPromptInvocationReason);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ prompt: buildSessionPromptView(db, row) });
  });

  router.put('/:id/lm-prompts/:reason', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'id is required' });
      return;
    }
    if (!getSession(db, id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const reasonParse = promptReasonSchema.safeParse(req.params.reason);
    if (!reasonParse.success) {
      res.status(400).json({ error: 'invalid_reason' });
      return;
    }
    const bodyParse = promptBodySchema.safeParse(req.body);
    if (!bodyParse.success) {
      res.status(400).json({
        error: 'invalid_body',
        message: bodyParse.error.message,
      });
      return;
    }
    const reason = reasonParse.data as LmPromptInvocationReason;
    const updated =
      bodyParse.data.mode === 'structured'
        ? updateSessionPromptStructured(db, id, reason, bodyParse.data.guidance)
        : updateSessionPrompt(db, id, reason, bodyParse.data.prompt_text);
    if (!updated) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ prompt: buildSessionPromptView(db, updated) });
  });

  router.post('/:id/lm-prompts/:reason/reset', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'id is required' });
      return;
    }
    if (!getSession(db, id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const reasonParse = promptReasonSchema.safeParse(req.params.reason);
    if (!reasonParse.success) {
      res.status(400).json({ error: 'invalid_reason' });
      return;
    }
    const updated = resetSessionPromptToDefault(
      db,
      id,
      reasonParse.data as LmPromptInvocationReason,
    );
    if (!updated) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ prompt: buildSessionPromptView(db, updated) });
  });

  router.post('/:id/url-pairs', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'id is required' });
      return;
    }
    if (!getSession(db, id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const parsed = addUrlPairsInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_body',
        message: parsed.error.message,
        issues: parsed.error.issues,
      });
      return;
    }
    const added = addUrlPairs(db, id, parsed.data);
    res.status(201).json({ url_pairs: added });
  });

  router.patch('/:id/url-pairs/:pair_id', (req, res) => {
    const id = req.params.id;
    const pairId = req.params.pair_id;
    if (!id || !pairId) {
      res.status(400).json({ error: 'invalid_request', message: 'id and pair_id are required' });
      return;
    }
    if (!getSession(db, id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const parsed = patchUrlPairInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_body',
        message: parsed.error.message,
        issues: parsed.error.issues,
      });
      return;
    }
    const result = patchUrlPair(db, id, pairId, parsed.data);
    if (!result) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(result);
  });

  router.post('/:id/recapture', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'id is required' });
      return;
    }
    if (!getSession(db, id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const parsed = recaptureScopeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_body',
        message: parsed.error.message,
        issues: parsed.error.issues,
      });
      return;
    }
    // Validate pair scope before kicking off the eval so callers get a 400
    // for "no such pair" instead of a silent evaluator no-op.
    if (parsed.data.pair_ids !== undefined) {
      const known = new Set(listUrlPairs(db, id).map((p) => p.id));
      const unknown = parsed.data.pair_ids.filter((pid) => !known.has(pid));
      const valid = parsed.data.pair_ids.filter((pid) => known.has(pid));
      if (valid.length === 0) {
        res.status(400).json({
          error: 'recapture_failed',
          message: 'No url_pairs match the supplied pair_ids',
          unknown_pair_ids: unknown,
        });
        return;
      }
      const result = evaluator.start(id, {
        url_pair_ids: valid,
        invoke_lm: true,
        force_recapture: { sides: parsed.data.side ? [parsed.data.side] : [] },
      });
      res.status(202).json({ ...result, unknown_pair_ids: unknown });
      return;
    }
    const result = evaluator.start(id, {
      invoke_lm: true,
      force_recapture: { sides: parsed.data.side ? [parsed.data.side] : [] },
    });
    res.status(202).json({ ...result, unknown_pair_ids: [] });
  });

  // Per-(pair, viewport) ETA for the session's currently in-flight capture
  // run. Used by the Rows + Clusters surfaces to render "Stale · recapturing
  // (~Xs)" next to each stale row/member. Returns an empty map when nothing
  // is in flight, so the UI can stop polling.
  router.get('/:id/capture-eta', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'id is required' });
      return;
    }
    if (!getSession(db, id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(computeCaptureEta(db, id));
  });

  // Per-session aggregate. Folds the three per-session pollers
  // (evaluation, results-delta, capture-eta) into one request so the
  // dashboard polls a single endpoint instead of fanning out. See
  // services/dashboard.ts for the design rationale.
  router.get('/:id/dashboard', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'id is required' });
      return;
    }
    if (!getSession(db, id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const sinceParam = req.query.since;
    const since =
      typeof sinceParam === 'string' && /\d{4}-\d{2}-\d{2}T/.test(sinceParam)
        ? sinceParam
        : undefined;
    const evalParam = req.query.eval;
    const evaluationId =
      typeof evalParam === 'string' && evalParam.length > 0 ? evalParam : undefined;
    res.json(computeReviewDashboard(db, id, lm, { since, evaluationId }));
  });

  // Capture + comparison errors for a session, flattened into one list
  // for the detail pane's "Errors" tab. Both captures.error_message and
  // comparisons.error_message are persisted (see schema.sql); this route
  // surfaces them with enough context (pair urls, viewport, timestamp)
  // for an operator to track down what failed without diving into rows.
  router.get('/:id/errors', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'id is required' });
      return;
    }
    if (!getSession(db, id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    interface CaptureErrorRow {
      id: string;
      url_pair_id: string;
      side: string;
      url: string;
      viewport_name: string;
      error_message: string;
      timestamp: string;
      url_pair_label: string | null;
      url_a: string;
      url_b: string;
    }
    const captureErrors = db
      .prepare<[string], CaptureErrorRow>(
        `SELECT c.id           AS id,
                c.url_pair_id  AS url_pair_id,
                c.side         AS side,
                c.url          AS url,
                c.viewport_name AS viewport_name,
                c.error_message AS error_message,
                COALESCE(c.captured_at, c.created_at) AS timestamp,
                p.label        AS url_pair_label,
                p.url_a        AS url_a,
                p.url_b        AS url_b
           FROM captures c
           JOIN capture_runs cr ON cr.id = c.capture_run_id
           JOIN url_pairs p     ON p.id = c.url_pair_id
          WHERE cr.session_id = ?
            AND c.status = 'error'
            AND c.error_message IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT 500`,
      )
      .all(id);
    interface ComparisonErrorRow {
      id: string;
      url_pair_id: string;
      viewport_name: string;
      error_message: string;
      timestamp: string;
      url_pair_label: string | null;
      url_a: string;
      url_b: string;
    }
    const comparisonErrors = db
      .prepare<[string], ComparisonErrorRow>(
        `SELECT cmp.id           AS id,
                cmp.url_pair_id  AS url_pair_id,
                cmp.viewport_name AS viewport_name,
                cmp.error_message AS error_message,
                COALESCE(cmp.completed_at, cmp.created_at) AS timestamp,
                p.label          AS url_pair_label,
                p.url_a          AS url_a,
                p.url_b          AS url_b
           FROM comparisons cmp
           JOIN comparison_runs cr ON cr.id = cmp.comparison_run_id
           JOIN url_pairs p        ON p.id = cmp.url_pair_id
          WHERE cr.session_id = ?
            AND cmp.status = 'error'
            AND cmp.error_message IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT 500`,
      )
      .all(id);
    res.json({
      errors: [
        ...captureErrors.map((r) => ({ kind: 'capture' as const, ...r })),
        ...comparisonErrors.map((r) => ({ kind: 'comparison' as const, side: null, url: null, ...r })),
      ].sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    });
  });

  router.get('/:id/evaluations', (req, res) => {
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
    const rows = listEvaluations(db, id);
    res.json({ evaluations: rows.map((row) => parseEvaluationRow(db, row)) });
  });

  // -------------------------------------------------------------------------
  // Acceptances
  // -------------------------------------------------------------------------

  router.get('/:id/acceptances', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'id is required' });
      return;
    }
    if (!getSession(db, id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ acceptances: listAcceptances(db, id) });
  });

  router.post('/:id/acceptances', (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'id is required' });
      return;
    }
    if (!getSession(db, id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const parsed = acceptanceInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_acceptance',
        message: parsed.error.message,
        details: parsed.error.issues,
      });
      return;
    }
    const acceptance = upsertAcceptance(db, id, parsed.data);
    res.status(201).json({ acceptance });
  });

  router.delete('/:id/acceptances/:acceptance_id', (req, res) => {
    const id = req.params.id;
    const acceptanceId = req.params.acceptance_id;
    if (!id || !acceptanceId) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    if (!getSession(db, id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const ok = deleteAcceptance(db, id, acceptanceId);
    if (!ok) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(204).end();
  });

  // Cluster review (Phase A): mounted as a sub-router so the parent ':id'
  // is in req.params. Read-only for now; mutation arrives in Phase D.
  router.use('/:id/clusters', clustersRouter(db));

  return router;
}
