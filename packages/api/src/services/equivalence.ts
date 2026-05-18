import {
  EQUIVALENCE_LEVELS,
  getEquivalenceLevel,
} from '../constants/equivalence.js';
import type { EquivalenceLevelId, MatchedAtLevel } from '../types.js';

/**
 * True when the target level has a non-zero SSIM ambiguity band where a
 * pixel result could fall and trigger an LM tiebreaker.
 */
export function levelMayInvokeLm(id: EquivalenceLevelId): boolean {
  const def = getEquivalenceLevel(id);
  return def.ambiguity_band_ssim > 0;
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
   * loosest and returns the first that passes both:
   *   - the SSIM gate (`ssim ≥ min_ssim`, the primary signal), and
   *   - the pixel-% safety guard (`pct ≤ max_changed_pixel_percentage`).
   * 'none' when no level matches.
   */
  pixelMatchedAtLevel: MatchedAtLevel;
  /**
   * True when the result lands inside the *target* level's SSIM ambiguity
   * band — the case where LM is invoked to break the tie.
   */
  inTargetAmbiguityBand: boolean;
}

/**
 * Single-pass equivalence: from one set of pixel metrics, return the
 * strictest level that passes plus an "in target's ambiguity band" flag
 * for LM-gating decisions.
 *
 * Gating model: SSIM is the primary signal. Pixel-% is a safety guard
 * that exists so a catastrophic pixel diff (e.g. >25% of pixels changed)
 * can't pass even when SSIM happens to be high — SSIM can be misleadingly
 * generous on uniform shifts. Both must hold for a level to match.
 *
 * Why one pass: levels are monotonic in both axes (looser → lower SSIM
 * floor, higher pct guard). Walking strictest → loosest and stopping at
 * the first pass gives the canonical strictness result.
 *
 * Null SSIM means "no signal" rather than "fail": we don't block on SSIM
 * when the metric isn't available, so legacy / pixel-perfect rows still
 * resolve. The pixel-% guard still applies.
 */
export function computeMatchedAtLevel(
  input: ComputeMatchedAtLevelInput,
): ComputeMatchedAtLevelOutput {
  const { changedPixelPercentage: pct, ssim, targetLevel } = input;

  let pixelMatchedAtLevel: MatchedAtLevel = 'none';
  for (const level of EQUIVALENCE_LEVELS) {
    // SSIM gate (primary). Null SSIM is treated as "no signal" and
    // doesn't block — same backwards-compat behaviour as before.
    if (level.min_ssim !== null && ssim !== null && ssim < level.min_ssim) continue;
    // Pixel-% safety guard (secondary catastrophic-change rejector).
    if (pct > level.max_changed_pixel_percentage) continue;
    pixelMatchedAtLevel = level.id;
    break;
  }

  // Ambiguity band is computed over SSIM around the target level's floor.
  // For the pixel-perfect target (no SSIM floor / zero band) and for the
  // null-SSIM case this collapses to false.
  const target = getEquivalenceLevel(targetLevel);
  const band = target.ambiguity_band_ssim;
  let inTargetAmbiguityBand = false;
  if (band > 0 && target.min_ssim !== null && ssim !== null) {
    const lower = Math.max(0, target.min_ssim - band);
    const upper = Math.min(1, target.min_ssim + band);
    inTargetAmbiguityBand = ssim >= lower && ssim <= upper;
  }

  return { pixelMatchedAtLevel, inTargetAmbiguityBand };
}
