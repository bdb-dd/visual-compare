import { createHash } from 'node:crypto';
import type { BoundingBoxPercent, DifferenceSource } from '../types.js';

/**
 * Cluster signatures group `differences` rows that represent the same kind
 * of change. Two signature schemes coexist:
 *
 *   v0 — geometric/heuristic. Falls back to bbox cell + size band + source.
 *        Used for imagick-sourced rows and for LM-sourced rows that don't
 *        yet have v1 taxonomy tags (e.g. legacy v2-prompt cached responses).
 *
 *   v1 — structured. Hash of the LM-emitted taxonomy tuple. Requires
 *        change_type, region_role, and element_label on the row.
 *
 * See `experiments/v1-taxonomy.md` for the design and validation.
 */

export type SignatureVersion = 'v0' | 'v1';

export interface SignatureResult {
  signature: string;
  signature_version: SignatureVersion;
}

// ---------------------------------------------------------------------------
// v0 — geometric
// ---------------------------------------------------------------------------

const GRID = 10;

const SIZE_BANDS: ReadonlyArray<{ name: string; ceiling: number }> = [
  { name: 'xs', ceiling: 0.1 },
  { name: 's',  ceiling: 1.0 },
  { name: 'm',  ceiling: 5.0 },
  { name: 'l',  ceiling: 20.0 },
  { name: 'xl', ceiling: Number.POSITIVE_INFINITY },
];

function sizeBand(areaPct: number): string {
  for (const b of SIZE_BANDS) {
    if (areaPct < b.ceiling) return b.name;
  }
  return 'xl';
}

function gridCell(bbox: BoundingBoxPercent): string {
  const cx = clamp(bbox.x + bbox.width / 2, 0, 99.999);
  const cy = clamp(bbox.y + bbox.height / 2, 0, 99.999);
  const col = Math.floor(cx / (100 / GRID));
  const row = Math.floor(cy / (100 / GRID));
  return `${row}-${col}`;
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

export function computeV0Signature(
  viewportName: string,
  bbox: BoundingBoxPercent,
  source: DifferenceSource,
): string {
  const cell = gridCell(bbox);
  const band = sizeBand(bbox.width * bbox.height);
  const raw = `${viewportName}|${cell}|${band}|${source}`;
  return sha1(raw);
}

// ---------------------------------------------------------------------------
// v1 — structured
// ---------------------------------------------------------------------------

/**
 * Normalise the LM-emitted element_label. Intentionally minimal —
 * canonicalisation is the prompt's job (see SYSTEM_PROMPT_V3 in lm.ts).
 * Strip punctuation except hyphens/apostrophes, lowercase, collapse
 * whitespace.
 */
export function normalizeElementLabel(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s\-']+/g, '')
    .replace(/\s+/g, ' ');
}

export function computeV1Signature(
  viewportName: string,
  regionRole: string,
  changeType: string,
  elementLabel: string,
): string {
  const label = elementLabel && elementLabel !== 'other'
    ? normalizeElementLabel(elementLabel)
    : '__none__';
  const raw = `${viewportName}|${regionRole}|${changeType}|${label}`;
  return sha1(raw);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface SignatureInput {
  source: DifferenceSource;
  viewport_name: string;
  bbox: BoundingBoxPercent | null;
  change_type: string | null;
  region_role: string | null;
  element_label: string | null;
}

/**
 * Pick v1 when all three taxonomy fields are present; otherwise fall back
 * to v0. Returns null when there isn't enough information for either
 * (e.g. an imagick row with no bbox).
 */
export function computeSignature(input: SignatureInput): SignatureResult | null {
  if (input.change_type && input.region_role && input.element_label) {
    return {
      signature: computeV1Signature(
        input.viewport_name,
        input.region_role,
        input.change_type,
        input.element_label,
      ),
      signature_version: 'v1',
    };
  }
  if (input.bbox) {
    return {
      signature: computeV0Signature(input.viewport_name, input.bbox, input.source),
      signature_version: 'v0',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12);
}
