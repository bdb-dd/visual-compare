import type { EquivalenceLevelId, MatchedAtLevel } from '../types.js';

export interface EquivalenceLevelDef {
  id: EquivalenceLevelId;
  name: string;
  description: string;
  // Threshold expressed as percent (0-100). A comparison is equivalent when
  // changed_pixel_percentage <= max_changed_pixel_percentage.
  max_changed_pixel_percentage: number;
  // Ambiguity band (in percent points) around the threshold where LM Studio
  // would be invoked as a tiebreaker.
  ambiguity_band_percentage: number;
  // Minimum SSIM (0-1) accepted as a perceptual signal for `tolerant`/`loose`
  // levels. `pixel-perfect` and `strict` ignore SSIM.
  min_ssim: number | null;
}

// Levels are ordered strictest -> loosest. The single-pass pipeline walks them
// in this order and records the first one that passes as `matched_at_level`.
export const EQUIVALENCE_LEVELS: EquivalenceLevelDef[] = [
  {
    id: 'pixel-perfect',
    name: 'Pixel Perfect',
    description: 'Zero changed pixels.',
    max_changed_pixel_percentage: 0,
    ambiguity_band_percentage: 0,
    min_ssim: null,
  },
  {
    id: 'strict',
    name: 'Strict',
    description: 'Very small pixel difference allowed.',
    max_changed_pixel_percentage: 0.5,
    ambiguity_band_percentage: 0.25,
    min_ssim: null,
  },
  {
    id: 'tolerant',
    name: 'Tolerant',
    description: 'Moderate pixel/layout variance accepted.',
    max_changed_pixel_percentage: 5,
    ambiguity_band_percentage: 2,
    min_ssim: 0.95,
  },
  {
    id: 'loose',
    name: 'Loose',
    description: 'Broad visual similarity accepted.',
    max_changed_pixel_percentage: 15,
    ambiguity_band_percentage: 5,
    min_ssim: 0.85,
  },
];

export const EQUIVALENCE_LEVEL_IDS: EquivalenceLevelId[] = EQUIVALENCE_LEVELS.map(
  (l) => l.id,
);

// Order index used to compare strictness. Lower index = stricter.
// `none` is sentinel for "no level matched" and is treated as weaker than `loose`.
export const MATCHED_AT_LEVEL_ORDER: MatchedAtLevel[] = [
  'pixel-perfect',
  'strict',
  'tolerant',
  'loose',
  'none',
];

export function getEquivalenceLevel(id: EquivalenceLevelId): EquivalenceLevelDef {
  const level = EQUIVALENCE_LEVELS.find((l) => l.id === id);
  if (!level) {
    throw new Error(`Unknown equivalence level: ${id}`);
  }
  return level;
}

/** True if `a` is at least as strict as `b`. `none` is the weakest. */
export function isAtLeastAsStrict(a: MatchedAtLevel, b: MatchedAtLevel): boolean {
  return MATCHED_AT_LEVEL_ORDER.indexOf(a) <= MATCHED_AT_LEVEL_ORDER.indexOf(b);
}

export const DEFAULT_EQUIVALENCE_LEVEL: EquivalenceLevelId = 'tolerant';

export const DEFAULT_REGION_MATCH_CONFIG = {
  growth_margin_px: 8,
  displacement_tolerance_px: 16,
  pixel_pct_delta: 0.5,
} as const;
