import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { isAtLeastAsStrict } from '../constants/equivalence.js';
import { compareRegionSets } from './region-match.js';
import type {
  AcceptanceRow,
  AcceptanceStatus,
  BoundingBoxPercent,
  MatchedAtLevel,
  RegionMatchConfig,
} from '../types.js';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const matchedAtLevelSchema = z.enum([
  'pixel-perfect',
  'strict',
  'tolerant',
  'loose',
  'none',
]);

const boundingBoxPercentSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();

export const acceptanceInputSchema = z
  .object({
    url_pair_id: z.string().min(1),
    viewport_name: z.string().min(1),
    accepted_level: matchedAtLevelSchema,
    accepted_pixel_pct: z.number().nullable().optional(),
    accepted_ssim: z.number().nullable().optional(),
    accepted_diff_regions: z.array(boundingBoxPercentSchema).default([]),
    accepted_capture_a_sha: z.string().min(1),
    accepted_capture_b_sha: z.string().min(1),
    accept_any: z.boolean().default(false),
    label: z.string().min(1).nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

export type AcceptanceInput = z.infer<typeof acceptanceInputSchema>;

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Create or update the acceptance for (session, url_pair, viewport). The
 * uniqueness key is enforced by the schema; re-accepting overwrites the
 * snapshot. Returns the resulting row.
 */
export function upsertAcceptance(
  db: Db,
  sessionId: string,
  input: AcceptanceInput,
): AcceptanceRow {
  const now = new Date().toISOString();
  const existing = getAcceptance(db, sessionId, input.url_pair_id, input.viewport_name);
  const id = existing?.id ?? randomUUID();
  const created_at = existing?.created_at ?? now;

  db.prepare(
    `INSERT INTO acceptances
       (id, session_id, url_pair_id, viewport_name, accepted_level,
        accepted_pixel_pct, accepted_ssim, accepted_diff_regions_json,
        accepted_capture_a_sha, accepted_capture_b_sha, accept_any,
        label, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, url_pair_id, viewport_name) DO UPDATE SET
       accepted_level             = excluded.accepted_level,
       accepted_pixel_pct         = excluded.accepted_pixel_pct,
       accepted_ssim              = excluded.accepted_ssim,
       accepted_diff_regions_json = excluded.accepted_diff_regions_json,
       accepted_capture_a_sha     = excluded.accepted_capture_a_sha,
       accepted_capture_b_sha     = excluded.accepted_capture_b_sha,
       accept_any                 = excluded.accept_any,
       label                      = excluded.label,
       notes                      = excluded.notes,
       updated_at                 = excluded.updated_at`,
  ).run(
    id,
    sessionId,
    input.url_pair_id,
    input.viewport_name,
    input.accepted_level,
    input.accepted_pixel_pct ?? null,
    input.accepted_ssim ?? null,
    JSON.stringify(input.accepted_diff_regions),
    input.accepted_capture_a_sha,
    input.accepted_capture_b_sha,
    input.accept_any ? 1 : 0,
    input.label ?? null,
    input.notes ?? null,
    created_at,
    now,
  );

  return getAcceptance(db, sessionId, input.url_pair_id, input.viewport_name)!;
}

export function getAcceptance(
  db: Db,
  sessionId: string,
  urlPairId: string,
  viewportName: string,
): AcceptanceRow | null {
  const row = db
    .prepare<[string, string, string], AcceptanceRow>(
      `SELECT * FROM acceptances
        WHERE session_id = ? AND url_pair_id = ? AND viewport_name = ?`,
    )
    .get(sessionId, urlPairId, viewportName);
  return row ?? null;
}

export function listAcceptances(db: Db, sessionId: string): AcceptanceRow[] {
  return db
    .prepare<[string], AcceptanceRow>(
      `SELECT * FROM acceptances WHERE session_id = ? ORDER BY url_pair_id, viewport_name`,
    )
    .all(sessionId);
}

export function deleteAcceptance(db: Db, sessionId: string, id: string): boolean {
  const info = db
    .prepare('DELETE FROM acceptances WHERE id = ? AND session_id = ?')
    .run(id, sessionId);
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Status computation
// ---------------------------------------------------------------------------

export interface AcceptanceCheckInput {
  /** Stored acceptance, or null when none exists for the (pair, viewport). */
  acceptance: AcceptanceRow | null;
  /** Current pixel result for this comparison. */
  current: {
    matched_at_level: MatchedAtLevel;
    pixel_pct: number | null;
    regions: BoundingBoxPercent[];
  };
  /** Region-match knobs (resolved per-pair, falling back to session). */
  config: RegionMatchConfig;
}

/**
 * Compare current state against the persisted acceptance snapshot.
 *
 * Order of checks:
 *   1. No acceptance → 'unaccepted'.
 *   2. accept_any flag → 'accepted' regardless of metrics.
 *   3. matched_at_level weaker than accepted_level → 'regressed'.
 *   4. pixel_pct delta over knob OR new/expanded regions → 'expanded_diff'.
 *   5. Otherwise → 'accepted'.
 */
export function computeAcceptanceStatus(input: AcceptanceCheckInput): AcceptanceStatus {
  const { acceptance, current, config } = input;
  if (!acceptance) return 'unaccepted';
  if (acceptance.accept_any === 1) return 'accepted';

  if (!isAtLeastAsStrict(current.matched_at_level, acceptance.accepted_level)) {
    return 'regressed';
  }

  // Pixel-pct delta check.
  if (
    acceptance.accepted_pixel_pct !== null &&
    current.pixel_pct !== null &&
    current.pixel_pct - acceptance.accepted_pixel_pct > config.pixel_pct_delta
  ) {
    return 'expanded_diff';
  }

  // Region-set check.
  const acceptedRegions = parseRegions(acceptance.accepted_diff_regions_json);
  const regionResult = compareRegionSets(acceptedRegions, current.regions, config);
  if (regionResult.status !== 'covered') return 'expanded_diff';

  return 'accepted';
}

function parseRegions(json: string): BoundingBoxPercent[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as BoundingBoxPercent[]) : [];
  } catch {
    return [];
  }
}
