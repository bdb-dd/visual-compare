import { describe, expect, it } from 'vitest';
import { compareRegionSets } from '../src/services/region-match.js';
import type { BoundingBoxPercent, RegionMatchConfig } from '../src/types.js';

const knobs: RegionMatchConfig = {
  growth_margin_pct: 0.5,
  displacement_tolerance_pct: 1,
  pixel_pct_delta: 0.5,
};

const box = (
  x: number,
  y: number,
  width: number,
  height: number,
): BoundingBoxPercent => ({ x, y, width, height });

describe('compareRegionSets', () => {
  it('identical regions are covered', () => {
    const r = box(10, 10, 20, 5);
    const result = compareRegionSets([r], [r], knobs);
    expect(result.status).toBe('covered');
    expect(result.expanded_indices).toEqual([]);
    expect(result.displaced_indices).toEqual([]);
  });

  it('empty current with non-empty accepted is covered (nothing new)', () => {
    const result = compareRegionSets([box(10, 10, 20, 5)], [], knobs);
    expect(result.status).toBe('covered');
  });

  it('empty accepted with non-empty current is displaced', () => {
    const result = compareRegionSets([], [box(10, 10, 20, 5)], knobs);
    expect(result.status).toBe('displaced');
    expect(result.displaced_indices).toEqual([0]);
  });

  it('shift within displacement_tolerance_pct is covered', () => {
    const accepted = [box(10, 10, 20, 5)];
    // Center of accepted: (20, 12.5). Shift center by (0.5, 0.5) — within 1.
    const current = [box(10.5, 10.5, 20, 5)];
    const result = compareRegionSets(accepted, current, knobs);
    expect(result.status).toBe('covered');
  });

  it('shift beyond displacement_tolerance_pct is displaced', () => {
    const accepted = [box(10, 10, 20, 5)];
    // Center of accepted: (20, 12.5). Shift center by (2, 0) — over 1.
    const current = [box(12, 10, 20, 5)];
    const result = compareRegionSets(accepted, current, knobs);
    expect(result.status).toBe('displaced');
  });

  it('grew within growth_margin_pct on both axes is covered', () => {
    const accepted = [box(10, 10, 20, 5)];
    // Width grew by 0.4, height grew by 0.3. Both within 0.5.
    // Center of accepted: (20, 12.5). New center: (20.2, 12.65). Within 1.
    const current = [box(10, 10, 20.4, 5.3)];
    const result = compareRegionSets(accepted, current, knobs);
    expect(result.status).toBe('covered');
  });

  it('grew beyond growth_margin_pct on width is expanded', () => {
    const accepted = [box(10, 10, 20, 5)];
    // Width grew by 1 (over 0.5). Keep center close so it still matches by displacement.
    // Original center (20, 12.5); new center: (20.5, 12.5). Δx=0.5 ≤ 1 ✓.
    const current = [box(10, 10, 21, 5)];
    const result = compareRegionSets(accepted, current, knobs);
    expect(result.status).toBe('expanded');
    expect(result.expanded_indices).toEqual([0]);
  });

  it('new region outside any accepted match is displaced', () => {
    const accepted = [box(10, 10, 20, 5)];
    const current = [
      box(10, 10, 20, 5), // matches accepted
      box(60, 60, 10, 10), // far away, no match
    ];
    const result = compareRegionSets(accepted, current, knobs);
    expect(result.status).toBe('displaced');
    expect(result.displaced_indices).toEqual([1]);
  });

  it('reports displaced in preference to expanded when both apply', () => {
    const accepted = [box(10, 10, 20, 5)];
    const current = [
      box(10, 10, 21, 5), // expanded match
      box(60, 60, 5, 5), // displaced (new)
    ];
    const result = compareRegionSets(accepted, current, knobs);
    expect(result.status).toBe('displaced');
    expect(result.expanded_indices).toEqual([0]);
    expect(result.displaced_indices).toEqual([1]);
  });

  it('multiple accepted regions: first by-center match wins', () => {
    const accepted = [box(10, 10, 5, 5), box(50, 50, 5, 5)];
    const current = [box(50, 50, 5, 5)]; // exact match for second
    const result = compareRegionSets(accepted, current, knobs);
    expect(result.status).toBe('covered');
  });
});
