import { describe, expect, it } from 'vitest';
import { computeMatchedAtLevel } from '../src/services/equivalence.js';

// New SSIM-dominant levels (see constants/equivalence.ts):
//   pixel-perfect: pct=0, ssim=any
//   strict:        ssim ≥ 0.99, pct ≤ 2,  ambig band ±0.005
//   tolerant:      ssim ≥ 0.96, pct ≤ 10, ambig band ±0.015
//   loose:         ssim ≥ 0.90, pct ≤ 25, ambig band ±0.025

describe('computeMatchedAtLevel', () => {
  it('returns pixel-perfect when both metrics are perfect', () => {
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 0,
      ssim: 1,
      targetLevel: 'tolerant',
    });
    expect(r.pixelMatchedAtLevel).toBe('pixel-perfect');
    expect(r.inTargetAmbiguityBand).toBe(false);
  });

  it('returns strict when SSIM passes strict floor and pct under guard', () => {
    // ssim 0.995 ≥ 0.99 floor, pct 0.5 ≤ 2 guard.
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 0.5,
      ssim: 0.995,
      targetLevel: 'strict',
    });
    expect(r.pixelMatchedAtLevel).toBe('strict');
    // 0.995 is exactly inside strict's band [0.985, 0.995].
    expect(r.inTargetAmbiguityBand).toBe(true);
  });

  it('returns tolerant when SSIM is in tolerant range but below strict floor', () => {
    // ssim 0.97 < 0.99 (strict) but ≥ 0.96 (tolerant); pct 1 within guards.
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 1,
      ssim: 0.97,
      targetLevel: 'tolerant',
    });
    expect(r.pixelMatchedAtLevel).toBe('tolerant');
  });

  it('falls through to loose when SSIM passes loose but not tolerant', () => {
    // ssim 0.92: < 0.96 (tolerant) but ≥ 0.90 (loose); pct 5 within guards.
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 5,
      ssim: 0.92,
      targetLevel: 'tolerant',
    });
    expect(r.pixelMatchedAtLevel).toBe('loose');
  });

  it('returns none when SSIM is below the loose floor', () => {
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 5,
      ssim: 0.5,
      targetLevel: 'tolerant',
    });
    expect(r.pixelMatchedAtLevel).toBe('none');
  });

  it('returns none when pct exceeds the loose safety guard regardless of high SSIM', () => {
    // Even at SSIM 0.99, a 30% pixel diff trips the catastrophic guard.
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 30,
      ssim: 0.99,
      targetLevel: 'tolerant',
    });
    expect(r.pixelMatchedAtLevel).toBe('none');
  });

  it('flags inTargetAmbiguityBand when SSIM lands in the target band', () => {
    // tolerant: min_ssim=0.96, band=0.015 → [0.945, 0.975]
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 1,
      ssim: 0.955,
      targetLevel: 'tolerant',
    });
    expect(r.inTargetAmbiguityBand).toBe(true);
  });

  it('inTargetAmbiguityBand is false outside the target band', () => {
    // ssim 0.90 is on loose's floor, not in tolerant's band.
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 5,
      ssim: 0.90,
      targetLevel: 'tolerant',
    });
    expect(r.inTargetAmbiguityBand).toBe(false);
  });

  it('pixel-perfect target has no ambiguity band', () => {
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 0,
      ssim: 1,
      targetLevel: 'pixel-perfect',
    });
    expect(r.inTargetAmbiguityBand).toBe(false);
  });

  it('null SSIM does not block on the SSIM gate but the pixel guard still applies', () => {
    // pct=1 passes strict's pct guard (≤2); null SSIM is treated as
    // "no signal" so we don't reject on the SSIM gate. Strict matches.
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 1,
      ssim: null,
      targetLevel: 'tolerant',
    });
    expect(r.pixelMatchedAtLevel).toBe('strict');
    // No SSIM → band check is false even at the target.
    expect(r.inTargetAmbiguityBand).toBe(false);
  });
});
