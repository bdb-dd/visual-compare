import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { ParsedCsvRow } from './csv.js';
import type {
  EquivalenceLevelId,
  FilterQuery,
  RegionMatchConfig,
  SessionConfig,
  SessionRow,
  UrlPairRow,
  ViewportDef,
} from '../types.js';
import {
  DEFAULT_EQUIVALENCE_LEVEL,
  DEFAULT_REGION_MATCH_CONFIG,
} from '../constants/equivalence.js';
import { copyDefaultsToSession } from './lm-prompts.js';

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

  // New sessions default `default_invoke_lm` to 1 (LM second-pass on).
  // The DB column DEFAULT is still 0 for backwards compatibility with
  // existing rows; explicit `1` here overrides for newly created sessions.
  const insertSession = db.prepare(
    'INSERT INTO sessions (id, name, csv_filename, created_at, default_invoke_lm) VALUES (?, ?, ?, ?, 1)',
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
    copyDefaultsToSession(db, sessionId);
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

const regionMatchConfigSchema = z
  .object({
    growth_margin_pct: z.number().nonnegative(),
    displacement_tolerance_pct: z.number().nonnegative(),
    pixel_pct_delta: z.number().nonnegative(),
  })
  .strict();

export const sessionConfigSchema = z
  .object({
    default_viewports: z.array(viewportSchema).default([]),
    default_capture_options: z.record(z.unknown()).default({}),
    default_equivalence_level: equivalenceLevelSchema.default(DEFAULT_EQUIVALENCE_LEVEL),
    region_match_config: regionMatchConfigSchema.default({ ...DEFAULT_REGION_MATCH_CONFIG }),
    filter_query: filterQuerySchema.default({}),
    default_invoke_lm: z.boolean().default(true),
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
  default_equivalence_level: DEFAULT_EQUIVALENCE_LEVEL,
  region_match_config: { ...DEFAULT_REGION_MATCH_CONFIG },
  filter_query: {},
  default_invoke_lm: true,
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
    default_equivalence_level: row.default_equivalence_level ?? DEFAULT_EQUIVALENCE_LEVEL,
    region_match_config: normaliseRegionMatchConfig(
      parseJsonField<Record<string, unknown>>(row.region_match_config_json, {}),
    ),
    filter_query: parseJsonField<FilterQuery>(row.filter_query, {}),
    // Tolerate the SQLite int. Migration adds the column with default 0,
    // so any pre-migration read also resolves to false.
    default_invoke_lm: (row.default_invoke_lm ?? 0) === 1,
  };
}

/**
 * Tolerate legacy column shapes when reading config back from the DB. Older
 * rows used px-named knobs (`growth_margin_px`, `displacement_tolerance_px`)
 * before phase 3 switched the units to percent. We map those forward and
 * fill in any missing knobs from defaults so the result always satisfies
 * the strict zod schema on the way back out.
 */
function normaliseRegionMatchConfig(raw: Record<string, unknown>): RegionMatchConfig {
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  return {
    growth_margin_pct:
      num(raw.growth_margin_pct) ??
      num(raw.growth_margin_px) ??
      DEFAULT_REGION_MATCH_CONFIG.growth_margin_pct,
    displacement_tolerance_pct:
      num(raw.displacement_tolerance_pct) ??
      num(raw.displacement_tolerance_px) ??
      DEFAULT_REGION_MATCH_CONFIG.displacement_tolerance_pct,
    pixel_pct_delta:
      num(raw.pixel_pct_delta) ?? DEFAULT_REGION_MATCH_CONFIG.pixel_pct_delta,
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
            default_equivalence_level = ?,
            region_match_config_json = ?,
            filter_query = ?,
            default_invoke_lm = ?
      WHERE id = ?`,
  ).run(
    JSON.stringify(merged.default_viewports),
    JSON.stringify(merged.default_capture_options),
    merged.default_equivalence_level,
    JSON.stringify(merged.region_match_config),
    JSON.stringify(merged.filter_query),
    merged.default_invoke_lm ? 1 : 0,
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

// ---------------------------------------------------------------------------
// URL-pair mutations (Phase 7).
//
// The doc's "edit-as-add+disable" rule: changing a URL on an existing pair
// creates a fresh url_pairs row at the next row_index and disables the old
// one. Old captures stay attached to the old row so cache and history
// remain intact. Metadata-only edits (label, language, etc.) update the
// existing row directly because they don't affect the captured pixels.
// ---------------------------------------------------------------------------

export interface AddUrlPairInput {
  url_a: string;
  url_b: string;
  label?: string | null;
  language?: string | null;
  category?: string | null;
  subcategory?: string | null;
  path?: string | null;
}

const urlSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'must be a valid http(s) URL' },
  );

const optionalText = z
  .string()
  .trim()
  .min(1)
  .nullable()
  .optional();

export const addUrlPairsInputSchema = z
  .object({
    pairs: z
      .array(
        z
          .object({
            url_a: urlSchema,
            url_b: urlSchema,
            label: optionalText,
            language: optionalText,
            category: optionalText,
            subcategory: optionalText,
            path: optionalText,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type AddUrlPairsInput = z.infer<typeof addUrlPairsInputSchema>;

export const patchUrlPairInputSchema = z
  .object({
    url_a: urlSchema.optional(),
    url_b: urlSchema.optional(),
    label: optionalText,
    language: optionalText,
    category: optionalText,
    subcategory: optionalText,
    path: optionalText,
    disabled: z.boolean().optional(),
  })
  .strict();

export type PatchUrlPairInput = z.infer<typeof patchUrlPairInputSchema>;

export function addUrlPairs(
  db: Db,
  sessionId: string,
  input: AddUrlPairsInput,
): UrlPairRow[] {
  if (!getSession(db, sessionId)) {
    throw new Error(`session ${sessionId} not found`);
  }
  const insert = db.prepare(
    `INSERT INTO url_pairs
       (id, session_id, url_a, url_b, label, row_index, raw_row_json,
        language, category, subcategory, path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const nextIndexStmt = db.prepare<[string], { next: number }>(
    `SELECT COALESCE(MAX(row_index) + 1, 0) AS next FROM url_pairs WHERE session_id = ?`,
  );

  const created: UrlPairRow[] = [];
  const tx = db.transaction(() => {
    let next = nextIndexStmt.get(sessionId)?.next ?? 0;
    const now = new Date().toISOString();
    for (const p of input.pairs) {
      const id = randomUUID();
      const label = p.label ?? null;
      const language = p.language ?? null;
      const category = p.category ?? null;
      const subcategory = p.subcategory ?? null;
      const path = p.path ?? null;
      const rawJson = JSON.stringify({
        url_a: p.url_a,
        url_b: p.url_b,
        label,
        language,
        category,
        subcategory,
        path,
      });
      insert.run(
        id,
        sessionId,
        p.url_a,
        p.url_b,
        label,
        next,
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
        url_a: p.url_a,
        url_b: p.url_b,
        label,
        row_index: next,
        raw_row_json: rawJson,
        language,
        category,
        subcategory,
        path,
        disabled: 0,
        created_at: now,
      });
      next += 1;
    }
  });
  tx();
  return created;
}

export interface PatchUrlPairResult {
  /** The row representing the pair after the patch. For URL-changing
   * edits this is the freshly-inserted replacement row; for metadata-only
   * edits and toggles it's the original row, updated in place. */
  pair: UrlPairRow;
  /** When a new row was minted, the disabled-out predecessor's id. */
  replaced_id: string | null;
}

export function patchUrlPair(
  db: Db,
  sessionId: string,
  pairId: string,
  patch: PatchUrlPairInput,
): PatchUrlPairResult | null {
  const existing = db
    .prepare<[string, string], UrlPairRow>(
      `SELECT * FROM url_pairs WHERE id = ? AND session_id = ?`,
    )
    .get(pairId, sessionId);
  if (!existing) return null;

  const urlChanged =
    (patch.url_a !== undefined && patch.url_a !== existing.url_a) ||
    (patch.url_b !== undefined && patch.url_b !== existing.url_b);

  if (urlChanged) {
    // Add+disable. Inherit unchanged metadata from the predecessor; allow
    // the patch to override any metadata field at the same time.
    const newPair = addUrlPairs(db, sessionId, {
      pairs: [
        {
          url_a: patch.url_a ?? existing.url_a,
          url_b: patch.url_b ?? existing.url_b,
          label: patch.label !== undefined ? patch.label : existing.label,
          language: patch.language !== undefined ? patch.language : existing.language,
          category: patch.category !== undefined ? patch.category : existing.category,
          subcategory:
            patch.subcategory !== undefined ? patch.subcategory : existing.subcategory,
          path: patch.path !== undefined ? patch.path : existing.path,
        },
      ],
    })[0]!;
    db.prepare(`UPDATE url_pairs SET disabled = 1 WHERE id = ?`).run(existing.id);
    return { pair: newPair, replaced_id: existing.id };
  }

  // Metadata-only or disabled-flag edit — update in place. Apply only the
  // fields the caller actually supplied so partial patches do the right
  // thing.
  const sets: string[] = [];
  const params: unknown[] = [];
  const apply = (col: string, value: unknown) => {
    sets.push(`${col} = ?`);
    params.push(value);
  };
  if (patch.label !== undefined) apply('label', patch.label);
  if (patch.language !== undefined) apply('language', patch.language);
  if (patch.category !== undefined) apply('category', patch.category);
  if (patch.subcategory !== undefined) apply('subcategory', patch.subcategory);
  if (patch.path !== undefined) apply('path', patch.path);
  if (patch.disabled !== undefined) apply('disabled', patch.disabled ? 1 : 0);
  if (sets.length > 0) {
    params.push(existing.id);
    db.prepare(
      `UPDATE url_pairs SET ${sets.join(', ')} WHERE id = ?`,
    ).run(...(params as never[]));
  }
  const updated = db
    .prepare<[string], UrlPairRow>('SELECT * FROM url_pairs WHERE id = ?')
    .get(existing.id);
  return { pair: updated!, replaced_id: null };
}
