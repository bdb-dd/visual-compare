import { getEquivalenceLevel } from '../constants/equivalence.js';
import type { EquivalenceLevelId } from '../types.js';

/**
 * True when this level *might* trigger an LM Studio call: either the LM is
 * always invoked (semantic) or the level has a non-zero ambiguity band where
 * a tiebreaker could fire.
 */
export function levelMayInvokeLm(id: EquivalenceLevelId): boolean {
  const def = getEquivalenceLevel(id);
  return def.semantic || def.ambiguity_band_percentage > 0;
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
  /** Reason for invoking LM, if any. */
  lmInvocationReason: 'semantic_mode' | 'ambiguous_pixel_result' | null;
}

/**
 * Decide equivalence for a non-LM pipeline run.
 *
 * - `pixel-perfect`: any non-zero pixel change is non-equivalent.
 * - `strict`/`tolerant`/`loose`: equivalent when pct <= threshold and (when configured)
 *   SSIM >= min_ssim. Pct inside the ambiguity band returns null (LM tiebreaker).
 * - `semantic`: always returns null with reason `semantic_mode`.
 */
export function decideEquivalence(input: EquivalenceDecisionInput): EquivalenceDecision {
  const def = getEquivalenceLevel(input.level);

  if (def.semantic) {
    return {
      imDeterminedEquivalent: null,
      decidedByPixels: false,
      inAmbiguityBand: false,
      lmInvocationReason: 'semantic_mode',
    };
  }

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
