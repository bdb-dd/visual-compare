import { Router } from 'express';
import multer from 'multer';
import type { Db } from '../db/client.js';
import { parseSessionCsv } from '../services/csv.js';
import {
  createSession,
  deleteSession,
  getSession,
  getSessionConfig,
  listSessions,
  listUrlPairs,
  rowToSessionConfig,
  sessionConfigSchema,
  updateSession,
  updateSessionConfig,
} from '../services/sessions.js';
import {
  evaluationConfigInputSchema,
  listEvaluations,
  loadSessionPromptIds,
  planEvaluation,
  readSessionResults,
  resolveEvaluationConfig,
  type Evaluator,
} from '../services/evaluator.js';
import { parseEvaluationRow } from './evaluations.js';
import {
  getSessionPrompt,
  listSessionPrompts,
  updateSessionPrompt,
  type LmPromptInvocationReason,
} from '../services/lm-prompts.js';
import { z } from 'zod';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MiB
});

export function sessionsRouter(db: Db, evaluator: Evaluator): Router {
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
    const promptIds = loadSessionPromptIds(db, id, undefined);
    const config = resolveEvaluationConfig(
      parsed.data,
      sessionConfig,
      undefined,
      promptIds,
    );
    const plan = planEvaluation(db, id, config);
    res.json({
      session_id: id,
      config,
      plan: {
        enabled_pair_count: plan.enabled_pair_count,
        capture_misses: plan.capture_misses.length,
        comparison_misses: plan.comparison_misses.length,
        cache_hits: plan.cache_hits,
      },
      results: readSessionResults(db, id, config),
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
    res.json({ prompts: listSessionPrompts(db, id) });
  });

  const promptReasonSchema = z.enum(['semantic_mode', 'ambiguous_pixel_result']);
  const promptBodySchema = z
    .object({ prompt_text: z.string().min(1) })
    .strict();

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
    res.json({ prompt: row });
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
    const updated = updateSessionPrompt(
      db,
      id,
      reasonParse.data as LmPromptInvocationReason,
      bodyParse.data.prompt_text,
    );
    res.json({ prompt: updated });
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
    res.json({ evaluations: rows.map(parseEvaluationRow) });
  });

  return router;
}
