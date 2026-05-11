import { createHash } from 'node:crypto';
import type { Db } from '../db/client.js';
import {
  LM_PROMPT_DEFAULTS,
  SEEDABLE_INVOCATION_REASONS,
  type SeedableInvocationReason,
} from '../constants/lm-prompts.js';
import {
  assemblePromptText,
  EMPTY_GUIDANCE,
  parseGuidanceJson,
  serialiseGuidance,
  type PromptGuidance,
} from './lm-prompt-guidance.js';

export type LmPromptInvocationReason = SeedableInvocationReason;

export type LmPromptMode = 'structured' | 'advanced';

export interface LmPromptDefaultRow {
  invocation_reason: LmPromptInvocationReason;
  prompt_text: string;
  prompt_id: string;
  source: 'seed' | 'override';
  guidance_json: string | null;
  updated_at: string;
}

export interface LmPromptRow {
  session_id: string;
  invocation_reason: LmPromptInvocationReason;
  prompt_text: string;
  prompt_id: string;
  guidance_json: string | null;
  updated_at: string;
}

/**
 * The view the UI consumes — same data as the row plus the parsed guidance
 * and the resolved base prompt text (so the editor can show "what does the
 * default look like?" without a second round-trip). `mode` is derived from
 * `guidance_json`: non-null → structured, null → advanced.
 */
export interface LmPromptView {
  invocation_reason: LmPromptInvocationReason;
  prompt_text: string;
  prompt_id: string;
  guidance: PromptGuidance | null;
  mode: LmPromptMode;
  base_prompt_text: string;
  updated_at: string;
}

export function hashPrompt(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Populate `lm_prompt_defaults` from the constants file on first startup.
 * Idempotent: an already-seeded row is left alone so an admin's later
 * override doesn't get clobbered by the next deploy. Returns the number of
 * rows newly inserted (for logging). Seeds with `guidance_json='{}'` so the
 * defaults start in structured mode with no rules applied.
 */
export function seedLmPromptDefaults(db: Db): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO lm_prompt_defaults
       (invocation_reason, prompt_text, prompt_id, source, guidance_json, updated_at)
       VALUES (?, ?, ?, 'seed', ?, ?)`,
  );
  const now = new Date().toISOString();
  const initialGuidance = serialiseGuidance(EMPTY_GUIDANCE);
  let inserted = 0;
  for (const reason of SEEDABLE_INVOCATION_REASONS) {
    const text = LM_PROMPT_DEFAULTS[reason];
    const info = insert.run(reason, text, hashPrompt(text), initialGuidance, now);
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
 * call inside its own transaction. The default's guidance_json (and the
 * resulting prompt_text/prompt_id) is copied verbatim so the session starts
 * in the same mode the admin defined for the default.
 */
export function copyDefaultsToSession(db: Db, sessionId: string): void {
  const defaults = listLmPromptDefaults(db);
  const insert = db.prepare(
    `INSERT INTO lm_prompts
       (session_id, invocation_reason, prompt_text, prompt_id, guidance_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, invocation_reason) DO NOTHING`,
  );
  const now = new Date().toISOString();
  for (const d of defaults) {
    insert.run(
      sessionId,
      d.invocation_reason,
      d.prompt_text,
      d.prompt_id,
      d.guidance_json,
      now,
    );
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

/**
 * Advanced-mode default override. Stores `prompt_text` verbatim and clears
 * `guidance_json` so the editor knows to show the raw-text affordance.
 * Cache invalidates automatically because prompt_id is the SHA of prompt_text.
 */
export function updateLmPromptDefault(
  db: Db,
  reason: LmPromptInvocationReason,
  promptText: string,
): LmPromptDefaultRow {
  const promptId = hashPrompt(promptText);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO lm_prompt_defaults
       (invocation_reason, prompt_text, prompt_id, source, guidance_json, updated_at)
       VALUES (?, ?, ?, 'override', NULL, ?)
     ON CONFLICT (invocation_reason) DO UPDATE SET
       prompt_text   = excluded.prompt_text,
       prompt_id     = excluded.prompt_id,
       source        = 'override',
       guidance_json = NULL,
       updated_at    = excluded.updated_at`,
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

/**
 * Advanced-mode session edit: writes prompt_text verbatim and clears
 * guidance_json so the editor presents the raw-text affordance on next read.
 */
export function updateSessionPrompt(
  db: Db,
  sessionId: string,
  reason: LmPromptInvocationReason,
  promptText: string,
): LmPromptRow | null {
  return writeSessionPromptRow(db, sessionId, reason, {
    promptText,
    guidanceJson: null,
  });
}

/**
 * Structured-mode session edit: takes a guidance object, looks up the base
 * prompt from the corresponding default, assembles the final text, and
 * writes both. The assembled text drives the SHA → cache key, so flipping
 * any toggle or rule invalidates the LM verdict cache for that prompt.
 */
export function updateSessionPromptStructured(
  db: Db,
  sessionId: string,
  reason: LmPromptInvocationReason,
  guidance: PromptGuidance,
): LmPromptRow | null {
  const base = resolveBasePromptText(db, reason);
  const promptText = assemblePromptText(base, guidance);
  return writeSessionPromptRow(db, sessionId, reason, {
    promptText,
    guidanceJson: serialiseGuidance(guidance),
  });
}

/**
 * Reset a session prompt to whatever the current default is — including the
 * default's mode (so a default with structured guidance lands the session
 * back in structured mode with the same guidance).
 */
export function resetSessionPromptToDefault(
  db: Db,
  sessionId: string,
  reason: LmPromptInvocationReason,
): LmPromptRow | null {
  const def = getLmPromptDefault(db, reason);
  if (!def) return null;
  return writeSessionPromptRow(db, sessionId, reason, {
    promptText: def.prompt_text,
    guidanceJson: def.guidance_json,
  });
}

interface WriteRowArgs {
  promptText: string;
  guidanceJson: string | null;
}

function writeSessionPromptRow(
  db: Db,
  sessionId: string,
  reason: LmPromptInvocationReason,
  { promptText, guidanceJson }: WriteRowArgs,
): LmPromptRow | null {
  const promptId = hashPrompt(promptText);
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `UPDATE lm_prompts
          SET prompt_text = ?, prompt_id = ?, guidance_json = ?, updated_at = ?
        WHERE session_id = ? AND invocation_reason = ?`,
    )
    .run(promptText, promptId, guidanceJson, now, sessionId, reason);
  if (info.changes === 0) {
    // Session row missing the seed (very old or partially-set-up session);
    // insert it so the edit isn't silently lost.
    db.prepare(
      `INSERT INTO lm_prompts
         (session_id, invocation_reason, prompt_text, prompt_id, guidance_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, reason, promptText, promptId, guidanceJson, now);
  }
  return getSessionPrompt(db, sessionId, reason);
}

/**
 * The base text used to assemble structured prompts. Reads the current
 * `lm_prompt_defaults` row (which carries either the seed text or an admin
 * override). Falls back to the in-code constant if the table is empty
 * (shouldn't happen post-seed but keeps the function total).
 */
function resolveBasePromptText(db: Db, reason: LmPromptInvocationReason): string {
  const def = getLmPromptDefault(db, reason);
  return def ? def.prompt_text : LM_PROMPT_DEFAULTS[reason];
}

export function buildSessionPromptView(
  db: Db,
  row: LmPromptRow,
): LmPromptView {
  const guidance = parseGuidanceJson(row.guidance_json);
  return {
    invocation_reason: row.invocation_reason,
    prompt_text: row.prompt_text,
    prompt_id: row.prompt_id,
    guidance,
    mode: guidance ? 'structured' : 'advanced',
    base_prompt_text: resolveBasePromptText(db, row.invocation_reason),
    updated_at: row.updated_at,
  };
}
