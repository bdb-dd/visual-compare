import type { EquivalenceLevelId, MatchedAtLevel } from '../types.js';

export interface EquivalenceLevelDef {
  id: EquivalenceLevelId;
  name: string;
  description: string;
  // Pixel-% safety guard, expressed as percent (0-100). A level can only
  // match when `changed_pixel_percentage <= max_changed_pixel_percentage`.
  // SSIM is the primary gate (see `min_ssim`); this guard exists so a
  // catastrophic pixel diff can't sneak through on a misleadingly-high
  // SSIM score (e.g. uniformly shifted images that happen to remain
  // structurally similar). Generous values are intentional.
  max_changed_pixel_percentage: number;
  // Ambiguity band (0-1) around the SSIM floor where LM Studio is invoked
  // as a tiebreaker. A comparison is "in the target's ambiguity band"
  // when its SSIM falls in [min_ssim - band, min_ssim + band].
  ambiguity_band_ssim: number;
  // Minimum SSIM (0-1) required for this level. SSIM is the PRIMARY gate;
  // a level only matches when ssim ≥ min_ssim AND the pixel safety guard
  // is satisfied. Null at pixel-perfect (where pct=0 alone is sufficient
  // and SSIM cannot be computed in degenerate cases).
  min_ssim: number | null;
  // ImageMagick fuzz tolerance and blur for the per-pixel diff. Higher
  // values absorb more anti-aliasing noise at the cost of missing subtle
  // changes. The cache key includes the level so the same captures can
  // be measured at different tolerances without colliding.
  tolerance: { fuzzPercent: number; blurSigma: number };
}

// Levels are ordered strictest -> loosest. The single-pass pipeline walks them
// in this order and records the first one that passes as `matched_at_level`.
export const EQUIVALENCE_LEVELS: EquivalenceLevelDef[] = [
  {
    id: 'pixel-perfect',
    name: 'Pixel Perfect',
    description: 'Zero changed pixels.',
    max_changed_pixel_percentage: 0,
    ambiguity_band_ssim: 0,
    min_ssim: null,
    tolerance: { fuzzPercent: 0, blurSigma: 0 },
  },
  {
    id: 'strict',
    name: 'Strict',
    description: 'Practically pixel-identical (SSIM ≥ 0.99).',
    max_changed_pixel_percentage: 2,
    ambiguity_band_ssim: 0.005,
    min_ssim: 0.99,
    tolerance: { fuzzPercent: 5, blurSigma: 0 },
  },
  {
    id: 'tolerant',
    name: 'Tolerant',
    description: 'Minor anti-aliasing or sub-pixel shift (SSIM ≥ 0.96).',
    max_changed_pixel_percentage: 10,
    ambiguity_band_ssim: 0.015,
    min_ssim: 0.96,
    tolerance: { fuzzPercent: 8, blurSigma: 0.3 },
  },
  {
    id: 'loose',
    name: 'Loose',
    description: 'Noticeable but tolerable variance (SSIM ≥ 0.90).',
    max_changed_pixel_percentage: 25,
    ambiguity_band_ssim: 0.025,
    min_ssim: 0.90,
    tolerance: { fuzzPercent: 12, blurSigma: 0.6 },
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
  growth_margin_pct: 0.5,
  displacement_tolerance_pct: 1,
  pixel_pct_delta: 0.5,
} as const;
