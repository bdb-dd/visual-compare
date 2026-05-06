import { describe, expect, it } from 'vitest';
import { computeMatchedAtLevel } from '../src/services/equivalence.js';

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

  it('returns strict when pct just above 0 but below strict threshold', () => {
    // strict: threshold=0.5, band=0.25 → in target band when pct ∈ [0.25, 0.75]
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 0.1,
      ssim: null,
      targetLevel: 'strict',
    });
    expect(r.pixelMatchedAtLevel).toBe('strict');
    expect(r.inTargetAmbiguityBand).toBe(false);
  });

  it('returns tolerant when pct is over strict but under tolerant', () => {
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 1,
      ssim: 0.99,
      targetLevel: 'tolerant',
    });
    expect(r.pixelMatchedAtLevel).toBe('tolerant');
  });

  it('SSIM floor at tolerant skips to loose when SSIM is below 0.95', () => {
    // pct=1 satisfies tolerant pct (≤5) but SSIM 0.9 < 0.95 floor.
    // loose: pct≤15 ✓, SSIM≥0.85 ✓ → loose.
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 1,
      ssim: 0.9,
      targetLevel: 'tolerant',
    });
    expect(r.pixelMatchedAtLevel).toBe('loose');
  });

  it('returns none when pct exceeds the loose threshold', () => {
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 20,
      ssim: 0.9,
      targetLevel: 'tolerant',
    });
    expect(r.pixelMatchedAtLevel).toBe('none');
  });

  it('returns none when SSIM is below the loose floor', () => {
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 10,
      ssim: 0.5,
      targetLevel: 'loose',
    });
    expect(r.pixelMatchedAtLevel).toBe('none');
  });

  it('flags inTargetAmbiguityBand when pct lands in the target band', () => {
    // tolerant: threshold=5, band=2 → band is [3, 7]
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 4.5,
      ssim: 0.99,
      targetLevel: 'tolerant',
    });
    expect(r.inTargetAmbiguityBand).toBe(true);
  });

  it('inTargetAmbiguityBand is false outside the band even if a different level is in its band', () => {
    // pct=14 is in loose's band ([10, 20]) but not strict's, so when target=strict
    // we should not flag the band.
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 14,
      ssim: 0.9,
      targetLevel: 'strict',
    });
    expect(r.inTargetAmbiguityBand).toBe(false);
  });

  it('pixel-perfect target has no ambiguity band', () => {
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 0,
      ssim: null,
      targetLevel: 'pixel-perfect',
    });
    expect(r.inTargetAmbiguityBand).toBe(false);
  });

  it('null SSIM does not block any level (treated as no signal)', () => {
    const r = computeMatchedAtLevel({
      changedPixelPercentage: 1,
      ssim: null,
      targetLevel: 'tolerant',
    });
    expect(r.pixelMatchedAtLevel).toBe('tolerant');
  });
});
