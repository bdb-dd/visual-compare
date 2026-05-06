import { describe, expect, it } from 'vitest';
import { decideEquivalence } from '../src/services/equivalence.js';

describe('decideEquivalence', () => {
  it('pixel-perfect: 0% is equivalent', () => {
    const d = decideEquivalence({ level: 'pixel-perfect', changedPixelPercentage: 0, ssim: 1 });
    expect(d.imDeterminedEquivalent).toBe(true);
    expect(d.decidedByPixels).toBe(true);
  });

  it('pixel-perfect: any change is non-equivalent', () => {
    const d = decideEquivalence({ level: 'pixel-perfect', changedPixelPercentage: 0.001, ssim: 1 });
    expect(d.imDeterminedEquivalent).toBe(false);
  });

  it('strict: comfortably below band is equivalent', () => {
    // strict: threshold=0.5, band=0.25 → ambiguity band [0.25, 0.75]
    const d = decideEquivalence({ level: 'strict', changedPixelPercentage: 0.1, ssim: null });
    expect(d.imDeterminedEquivalent).toBe(true);
    expect(d.decidedByPixels).toBe(true);
  });

  it('strict: inside ambiguity band invokes LM', () => {
    const d = decideEquivalence({ level: 'strict', changedPixelPercentage: 0.4, ssim: null });
    expect(d.imDeterminedEquivalent).toBe(null);
    expect(d.lmInvocationReason).toBe('ambiguous_pixel_result');
  });

  it('strict: clearly over threshold is non-equivalent', () => {
    const d = decideEquivalence({ level: 'strict', changedPixelPercentage: 5, ssim: null });
    expect(d.imDeterminedEquivalent).toBe(false);
  });

  it('tolerant: low change + high SSIM is equivalent', () => {
    const d = decideEquivalence({ level: 'tolerant', changedPixelPercentage: 1, ssim: 0.99 });
    expect(d.imDeterminedEquivalent).toBe(true);
  });

  it('tolerant: low change but SSIM below floor is not equivalent', () => {
    const d = decideEquivalence({ level: 'tolerant', changedPixelPercentage: 1, ssim: 0.5 });
    expect(d.imDeterminedEquivalent).toBe(false);
  });

  it('loose: in ambiguity band invokes LM', () => {
    const d = decideEquivalence({ level: 'loose', changedPixelPercentage: 14, ssim: 0.9 });
    expect(d.lmInvocationReason).toBe('ambiguous_pixel_result');
  });
});
