import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { ParsedCsvRow } from './csv.js';
import type {
  AllowListEntry,
  EquivalenceLevelId,
  FilterQuery,
  SessionConfig,
  SessionRow,
  UrlPairRow,
  ViewportDef,
} from '../types.js';

export interface CreateSessionInput {
  name: string;
  csv_filename: string;
  rows: ParsedCsvRow[];
}

export interface CreateSessionOutput {
  session: SessionRow;
  url_pairs: UrlPairRow[];
}

export function createSession(db: Db, input: CreateSessionInput): CreateSessionOutput {
  const { name, csv_filename, rows } = input;
  if (rows.length === 0) {
    throw new Error('createSession requires at least one row');
  }

  const sessionId = randomUUID();
  const now = new Date().toISOString();

  const insertSession = db.prepare(
    'INSERT INTO sessions (id, name, csv_filename, created_at) VALUES (?, ?, ?, ?)',
  );
  const insertPair = db.prepare(
    `INSERT INTO url_pairs
       (id, session_id, url_a, url_b, label, row_index, raw_row_json,
        language, category, subcategory, path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const created: UrlPairRow[] = [];
  const tx = db.transaction(() => {
    insertSession.run(sessionId, name, csv_filename, now);
    rows.forEach((row, idx) => {
      const id = randomUUID();
      const label = row.label ?? null;
      const rawJson = JSON.stringify(row.raw_row);
      const language = row.metadata?.language ?? null;
      const category = row.metadata?.category ?? null;
      const subcategory = row.metadata?.subcategory ?? null;
      const path = row.metadata?.path ?? null;
      insertPair.run(
        id,
        sessionId,
        row.url_a,
        row.url_b,
        label,
        idx,
        rawJson,
        language,
        category,
        subcategory,
        path,
        now,
      );
      created.push({
        id,
        session_id: sessionId,
        url_a: row.url_a,
        url_b: row.url_b,
        label,
        row_index: idx,
        raw_row_json: rawJson,
        language,
        category,
        subcategory,
        path,
        disabled: 0,
        created_at: now,
      });
    });
  });
  tx();

  return {
    session: getSession(db, sessionId)!,
    url_pairs: created,
  };
}

export function getSession(db: Db, id: string): SessionRow | null {
  const row = db
    .prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?')
    .get(id);
  return row ?? null;
}

export interface ListSessionsOptions {
  /** Include archived sessions. Defaults to false. */
  include_archived?: boolean;
}

export function listSessions(
  db: Db,
  opts: ListSessionsOptions = {},
): Array<SessionRow & { url_pair_count: number }> {
  const where = opts.include_archived ? '' : 'WHERE s.archived_at IS NULL';
  return db
    .prepare<unknown[], SessionRow & { url_pair_count: number }>(
      `SELECT s.*,
              (SELECT COUNT(*) FROM url_pairs p WHERE p.session_id = s.id) AS url_pair_count
         FROM sessions s
         ${where}
         ORDER BY s.created_at DESC`,
    )
    .all();
}

export function listUrlPairs(db: Db, sessionId: string): UrlPairRow[] {
  return db
    .prepare<[string], UrlPairRow>(
      'SELECT * FROM url_pairs WHERE session_id = ? ORDER BY row_index',
    )
    .all(sessionId);
}

export function deleteSession(db: Db, id: string): boolean {
  const info = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Session config (Phase 3): persistent, editable knobs that the evaluator
// reads when no per-call override is supplied. Empty defaults mean "no
// override"; the evaluator falls back to system defaults.
// ---------------------------------------------------------------------------

const equivalenceLevelSchema = z.enum([
  'pixel-perfect',
  'strict',
  'tolerant',
  'loose',
  'semantic',
]);

const viewportSchema = z.object({
  name: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive(),
  orientation: z.enum(['portrait', 'landscape']),
});

const filterQuerySchema = z
  .object({
    language: z.array(z.string().min(1)).optional(),
    category: z.array(z.string().min(1)).optional(),
    subcategory: z.array(z.string().min(1)).optional(),
    path_prefix: z.string().min(1).optional(),
  })
  .strict();

const allowListEntrySchema = z
  .object({
    url_pair_id: z.string().min(1),
    level: equivalenceLevelSchema,
    viewport_name: z.string().min(1),
  })
  .strict();

export const sessionConfigSchema = z
  .object({
    default_viewports: z.array(viewportSchema).default([]),
    default_capture_options: z.record(z.unknown()).default({}),
    default_equivalence_levels: z.array(equivalenceLevelSchema).default([]),
    filter_query: filterQuerySchema.default({}),
    allow_list: z.array(allowListEntrySchema).default([]),
  })
  .strict();

export type SessionConfigInput = z.input<typeof sessionConfigSchema>;

const sessionPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    archived: z.boolean().optional(),
  })
  .strict();

export type SessionPatch = z.infer<typeof sessionPatchSchema>;

const EMPTY_CONFIG: SessionConfig = {
  default_viewports: [],
  default_capture_options: {},
  default_equivalence_levels: [],
  filter_query: {},
  allow_list: [],
};

function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function rowToSessionConfig(row: SessionRow): SessionConfig {
  return {
    default_viewports: parseJsonField<ViewportDef[]>(row.default_viewports, []),
    default_capture_options: parseJsonField<SessionConfig['default_capture_options']>(
      row.default_capture_options,
      {},
    ),
    default_equivalence_levels: parseJsonField<EquivalenceLevelId[]>(
      row.default_equivalence_levels,
      [],
    ),
    filter_query: parseJsonField<FilterQuery>(row.filter_query, {}),
    allow_list: parseJsonField<AllowListEntry[]>(row.allow_list, []),
  };
}

export function getSessionConfig(db: Db, id: string): SessionConfig | null {
  const row = getSession(db, id);
  return row ? rowToSessionConfig(row) : null;
}

export function updateSessionConfig(
  db: Db,
  id: string,
  patch: Partial<SessionConfigInput>,
): SessionConfig | null {
  const current = getSessionConfig(db, id);
  if (!current) return null;
  const merged = sessionConfigSchema.parse({ ...current, ...patch });
  db.prepare(
    `UPDATE sessions
        SET default_viewports = ?,
            default_capture_options = ?,
            default_equivalence_levels = ?,
            filter_query = ?,
            allow_list = ?
      WHERE id = ?`,
  ).run(
    JSON.stringify(merged.default_viewports),
    JSON.stringify(merged.default_capture_options),
    JSON.stringify(merged.default_equivalence_levels),
    JSON.stringify(merged.filter_query),
    JSON.stringify(merged.allow_list),
    id,
  );
  return merged;
}

export function updateSession(
  db: Db,
  id: string,
  patchInput: unknown,
): SessionRow | null {
  const patch = sessionPatchSchema.parse(patchInput);
  const setFragments: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    setFragments.push('name = ?');
    params.push(patch.name);
  }
  if (patch.archived !== undefined) {
    setFragments.push('archived_at = ?');
    params.push(patch.archived ? new Date().toISOString() : null);
  }
  if (setFragments.length === 0) return getSession(db, id);
  params.push(id);
  const info = db
    .prepare(`UPDATE sessions SET ${setFragments.join(', ')} WHERE id = ?`)
    .run(...(params as never[]));
  if (info.changes === 0) return null;
  return getSession(db, id);
}

export { EMPTY_CONFIG };
