import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  getLmPromptDefault,
  listLmPromptDefaults,
  updateLmPromptDefault,
  type LmPromptInvocationReason,
} from '../services/lm-prompts.js';

const reasonSchema = z.enum(['target_level_failure', 'ambiguous_pixel_result']);

const updateBodySchema = z
  .object({
    prompt_text: z.string().min(1),
  })
  .strict();

/**
 * Defaults table — admin-only override of the canonical seed values.
 * Per-session prompts live on the sessions router under
 * /api/sessions/:id/lm-prompts.
 */
export function lmPromptsRouter(db: Db): Router {
  const router = Router();

  router.get('/defaults', (_req, res) => {
    res.json({ defaults: listLmPromptDefaults(db) });
  });

  router.get('/defaults/:reason', (req, res) => {
    const parsed = reasonSchema.safeParse(req.params.reason);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_reason' });
      return;
    }
    const row = getLmPromptDefault(db, parsed.data as LmPromptInvocationReason);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ default: row });
  });

  router.put('/defaults/:reason', (req, res) => {
    const reasonParse = reasonSchema.safeParse(req.params.reason);
    if (!reasonParse.success) {
      res.status(400).json({ error: 'invalid_reason' });
      return;
    }
    const bodyParse = updateBodySchema.safeParse(req.body);
    if (!bodyParse.success) {
      res.status(400).json({
        error: 'invalid_body',
        message: bodyParse.error.message,
      });
      return;
    }
    const updated = updateLmPromptDefault(
      db,
      reasonParse.data as LmPromptInvocationReason,
      bodyParse.data.prompt_text,
    );
    res.json({ default: updated });
  });

  return router;
}
