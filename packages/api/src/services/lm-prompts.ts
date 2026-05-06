import { createHash } from 'node:crypto';
import type { Db } from '../db/client.js';
import {
  LM_PROMPT_DEFAULTS,
  SEEDABLE_INVOCATION_REASONS,
  type SeedableInvocationReason,
} from '../constants/lm-prompts.js';

export type LmPromptInvocationReason = SeedableInvocationReason;

export interface LmPromptDefaultRow {
  invocation_reason: LmPromptInvocationReason;
  prompt_text: string;
  prompt_id: string;
  source: 'seed' | 'override';
  updated_at: string;
}

export interface LmPromptRow {
  session_id: string;
  invocation_reason: LmPromptInvocationReason;
  prompt_text: string;
  prompt_id: string;
  updated_at: string;
}

export function hashPrompt(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Populate `lm_prompt_defaults` from the constants file on first startup.
 * Idempotent: an already-seeded row is left alone so an admin's later
 * override doesn't get clobbered by the next deploy. Returns the number of
 * rows newly inserted (for logging).
 */
export function seedLmPromptDefaults(db: Db): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO lm_prompt_defaults
       (invocation_reason, prompt_text, prompt_id, source, updated_at)
       VALUES (?, ?, ?, 'seed', ?)`,
  );
  const now = new Date().toISOString();
  let inserted = 0;
  for (const reason of SEEDABLE_INVOCATION_REASONS) {
    const text = LM_PROMPT_DEFAULTS[reason];
    const info = insert.run(reason, text, hashPrompt(text), now);
    if (info.changes > 0) inserted += 1;
  }
  return inserted;
}

/**
 * For each session that has no `lm_prompts` rows yet, copy the current
 * defaults across. Used at startup to backfill existing sessions on the
 * Phase-4 migration; new sessions go through `copyDefaultsToSession`
 * directly during `createSession`.
 */
export function backfillSessionPrompts(db: Db): number {
  const sessions = db
    .prepare<unknown[], { id: string }>(
      `SELECT s.id FROM sessions s
        WHERE NOT EXISTS (SELECT 1 FROM lm_prompts p WHERE p.session_id = s.id)`,
    )
    .all();
  let backfilled = 0;
  const tx = db.transaction(() => {
    for (const s of sessions) {
      copyDefaultsToSession(db, s.id);
      backfilled += 1;
    }
  });
  tx();
  return backfilled;
}

/**
 * Copy every `lm_prompt_defaults` row into `lm_prompts(session_id, ...)`.
 * Caller is responsible for transactionality; `createSession` wraps this
 * call inside its own transaction.
 */
export function copyDefaultsToSession(db: Db, sessionId: string): void {
  const defaults = listLmPromptDefaults(db);
  const insert = db.prepare(
    `INSERT INTO lm_prompts
       (session_id, invocation_reason, prompt_text, prompt_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (session_id, invocation_reason) DO NOTHING`,
  );
  const now = new Date().toISOString();
  for (const d of defaults) {
    insert.run(sessionId, d.invocation_reason, d.prompt_text, d.prompt_id, now);
  }
}

export function listLmPromptDefaults(db: Db): LmPromptDefaultRow[] {
  return db
    .prepare<unknown[], LmPromptDefaultRow>(
      'SELECT * FROM lm_prompt_defaults ORDER BY invocation_reason',
    )
    .all();
}

export function getLmPromptDefault(
  db: Db,
  reason: LmPromptInvocationReason,
): LmPromptDefaultRow | null {
  const row = db
    .prepare<[string], LmPromptDefaultRow>(
      'SELECT * FROM lm_prompt_defaults WHERE invocation_reason = ?',
    )
    .get(reason);
  return row ?? null;
}

export function updateLmPromptDefault(
  db: Db,
  reason: LmPromptInvocationReason,
  promptText: string,
): LmPromptDefaultRow {
  const promptId = hashPrompt(promptText);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO lm_prompt_defaults
       (invocation_reason, prompt_text, prompt_id, source, updated_at)
       VALUES (?, ?, ?, 'override', ?)
     ON CONFLICT (invocation_reason) DO UPDATE SET
       prompt_text = excluded.prompt_text,
       prompt_id   = excluded.prompt_id,
       source      = 'override',
       updated_at  = excluded.updated_at`,
  ).run(reason, promptText, promptId, now);
  return getLmPromptDefault(db, reason)!;
}

export function listSessionPrompts(db: Db, sessionId: string): LmPromptRow[] {
  return db
    .prepare<[string], LmPromptRow>(
      'SELECT * FROM lm_prompts WHERE session_id = ? ORDER BY invocation_reason',
    )
    .all(sessionId);
}

export function getSessionPrompt(
  db: Db,
  sessionId: string,
  reason: LmPromptInvocationReason,
): LmPromptRow | null {
  const row = db
    .prepare<[string, string], LmPromptRow>(
      `SELECT * FROM lm_prompts
         WHERE session_id = ? AND invocation_reason = ?`,
    )
    .get(sessionId, reason);
  return row ?? null;
}

export function updateSessionPrompt(
  db: Db,
  sessionId: string,
  reason: LmPromptInvocationReason,
  promptText: string,
): LmPromptRow | null {
  const promptId = hashPrompt(promptText);
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `UPDATE lm_prompts
          SET prompt_text = ?, prompt_id = ?, updated_at = ?
        WHERE session_id = ? AND invocation_reason = ?`,
    )
    .run(promptText, promptId, now, sessionId, reason);
  if (info.changes === 0) {
    // Session row missing the seed (very old or partially-set-up session);
    // insert it so the edit isn't silently lost.
    db.prepare(
      `INSERT INTO lm_prompts
         (session_id, invocation_reason, prompt_text, prompt_id, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(sessionId, reason, promptText, promptId, now);
  }
  return getSessionPrompt(db, sessionId, reason);
}
