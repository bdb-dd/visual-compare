import {
  EQUIVALENCE_LEVELS,
  getEquivalenceLevel,
} from '../constants/equivalence.js';
import type { EquivalenceLevelId, MatchedAtLevel } from '../types.js';

/**
 * True when the target level has a non-zero ambiguity band where a pixel
 * result could fall and trigger an LM tiebreaker.
 */
export function levelMayInvokeLm(id: EquivalenceLevelId): boolean {
  const def = getEquivalenceLevel(id);
  return def.ambiguity_band_percentage > 0;
}

export interface ComputeMatchedAtLevelInput {
  changedPixelPercentage: number;
  ssim: number | null;
  /**
   * The session's target level. Used only for ambiguity-band detection —
   * the pixel walk itself is independent of target.
   */
  targetLevel: EquivalenceLevelId;
}

export interface ComputeMatchedAtLevelOutput {
  /**
   * Strictest level the pixel metrics confirm. Walks levels strictest →
   * loosest and returns the first that passes (`pct ≤ threshold` and SSIM
   * floor satisfied if configured). 'none' when no level matches.
   */
  pixelMatchedAtLevel: MatchedAtLevel;
  /**
   * True when the pixel result lands inside the *target* level's ambiguity
   * band — the case where LM is invoked to break the tie.
   */
  inTargetAmbiguityBand: boolean;
}

/**
 * Single-pass equivalence: from one set of pixel metrics, return the
 * strictest level that passes plus an "in target's ambiguity band" flag
 * for LM-gating decisions.
 *
 * Why one pass: levels are monotonic in their pct threshold (each looser
 * level subsumes the stricter one's pct check). SSIM floors are also
 * monotonic (looser = lower floor). So walking strictest → loosest and
 * stopping at the first pass gives the canonical strictness result.
 *
 * The ambiguity band is *not* used in the pixel walk itself; it's a
 * separate signal applied at the target level only, used to decide
 * whether to invoke LM as a tiebreaker.
 */
export function computeMatchedAtLevel(
  input: ComputeMatchedAtLevelInput,
): ComputeMatchedAtLevelOutput {
  const { changedPixelPercentage: pct, ssim, targetLevel } = input;

  let pixelMatchedAtLevel: MatchedAtLevel = 'none';
  for (const level of EQUIVALENCE_LEVELS) {
    if (pct > level.max_changed_pixel_percentage) continue;
    if (level.min_ssim !== null && ssim !== null && ssim < level.min_ssim) continue;
    pixelMatchedAtLevel = level.id;
    break;
  }

  const target = getEquivalenceLevel(targetLevel);
  const band = target.ambiguity_band_percentage;
  const lowerBand = Math.max(0, target.max_changed_pixel_percentage - band);
  const upperBand = target.max_changed_pixel_percentage + band;
  const inTargetAmbiguityBand = band > 0 && pct >= lowerBand && pct <= upperBand;

  return { pixelMatchedAtLevel, inTargetAmbiguityBand };
}
