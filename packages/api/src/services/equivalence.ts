import { getEquivalenceLevel } from '../constants/equivalence.js';
import type { EquivalenceLevelId, LmInvocationReason } from '../types.js';

/**
 * True when this level has a non-zero ambiguity band where a pixel-result
 * could fall in and trigger an LM tiebreaker.
 */
export function levelMayInvokeLm(id: EquivalenceLevelId): boolean {
  const def = getEquivalenceLevel(id);
  return def.ambiguity_band_percentage > 0;
}

export interface EquivalenceDecisionInput {
  level: EquivalenceLevelId;
  changedPixelPercentage: number;
  ssim: number | null;
}

export interface EquivalenceDecision {
  /** True/false when pixel rules can decide on their own; null when LM tiebreaker is required. */
  imDeterminedEquivalent: boolean | null;
  /** True if pixel rules decided directly (no LM needed). */
  decidedByPixels: boolean;
  /** True if the result fell inside the configured ambiguity band. */
  inAmbiguityBand: boolean;
  /** Reason for invoking LM, if any. Phase 2 also returns 'target_level_failure' here. */
  lmInvocationReason: LmInvocationReason | null;
}

/**
 * Decide equivalence for a single level using only pixel metrics.
 *
 * - `pixel-perfect`: any non-zero pixel change is non-equivalent.
 * - `strict`/`tolerant`/`loose`: equivalent when pct <= threshold and (when configured)
 *   SSIM >= min_ssim. Pct inside the ambiguity band returns null (LM tiebreaker).
 *
 * TODO(phase-2): replace with `computeMatchedAtLevel` that walks all levels
 * strictest -> loosest in one call, returning the first match. This function
 * is retained as a helper used by that walk.
 */
export function decideEquivalence(input: EquivalenceDecisionInput): EquivalenceDecision {
  const def = getEquivalenceLevel(input.level);

  const { changedPixelPercentage: pct, ssim } = input;
  const threshold = def.max_changed_pixel_percentage;
  const band = def.ambiguity_band_percentage;

  const lowerBand = Math.max(0, threshold - band);
  const upperBand = threshold + band;

  const inBand = band > 0 && pct >= lowerBand && pct <= upperBand;
  if (inBand) {
    return {
      imDeterminedEquivalent: null,
      decidedByPixels: false,
      inAmbiguityBand: true,
      lmInvocationReason: 'ambiguous_pixel_result',
    };
  }

  let equivalent = pct <= threshold;
  if (equivalent && def.min_ssim !== null && ssim !== null) {
    equivalent = ssim >= def.min_ssim;
  }

  return {
    imDeterminedEquivalent: equivalent,
    decidedByPixels: true,
    inAmbiguityBand: false,
    lmInvocationReason: null,
  };
}
