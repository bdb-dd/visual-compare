import type { BoundingBoxPercent, RegionMatchConfig } from '../types.js';

/**
 * Compare a current set of diff regions against a previously-accepted set.
 *
 * `accepted` is the snapshot of bounding boxes (percent units) the user
 * approved. `current` is what the latest evaluation observed. The knobs in
 * `config` express tolerance in percentage points of image dimension —
 * regions are stored in percent so px-vs-percent unit drift is avoided.
 *
 * Result categories (caller chooses how to combine with metric checks):
 *   - 'covered'   — every current region matches an accepted one within
 *                   displacement + growth tolerance.
 *   - 'expanded'  — at least one current region matches an accepted region
 *                   in position, but its area grew beyond growth_margin_pct.
 *   - 'displaced' — at least one current region has no accepted match
 *                   (it's a new region the user hasn't seen).
 *
 * 'displaced' is reported in preference to 'expanded' when both apply,
 * because a new diff region is a stronger signal than an enlarged one.
 */
export type RegionMatchStatus = 'covered' | 'expanded' | 'displaced';

export interface RegionMatchResult {
  status: RegionMatchStatus;
  /** Indices into `current` whose bbox grew beyond growth_margin_pct of an accepted match. */
  expanded_indices: number[];
  /** Indices into `current` that had no accepted match within displacement_tolerance_pct. */
  displaced_indices: number[];
}

export function compareRegionSets(
  accepted: BoundingBoxPercent[],
  current: BoundingBoxPercent[],
  config: RegionMatchConfig,
): RegionMatchResult {
  const expanded_indices: number[] = [];
  const displaced_indices: number[] = [];

  for (let i = 0; i < current.length; i += 1) {
    const c = current[i]!;
    const matchIdx = findAcceptedMatch(accepted, c, config);
    if (matchIdx === -1) {
      displaced_indices.push(i);
      continue;
    }
    const a = accepted[matchIdx]!;
    if (regionGrewBeyondMargin(a, c, config)) {
      expanded_indices.push(i);
    }
  }

  let status: RegionMatchStatus = 'covered';
  if (displaced_indices.length > 0) status = 'displaced';
  else if (expanded_indices.length > 0) status = 'expanded';

  return { status, expanded_indices, displaced_indices };
}

/**
 * Return the index of the accepted region whose center is within
 * `displacement_tolerance_pct` of the current region's center. -1 if none.
 *
 * "Center distance" is the simplest match metric and works well when
 * accepted regions are roughly disjoint. If accepted regions overlap the
 * caller can still get the wrong match, but for the v1 use case
 * (distinct diff regions) this is a non-issue.
 */
function findAcceptedMatch(
  accepted: BoundingBoxPercent[],
  current: BoundingBoxPercent,
  config: RegionMatchConfig,
): number {
  const tol = config.displacement_tolerance_pct;
  const cx = current.x + current.width / 2;
  const cy = current.y + current.height / 2;
  for (let i = 0; i < accepted.length; i += 1) {
    const a = accepted[i]!;
    const ax = a.x + a.width / 2;
    const ay = a.y + a.height / 2;
    if (Math.abs(cx - ax) <= tol && Math.abs(cy - ay) <= tol) return i;
  }
  return -1;
}

/**
 * True when `current` is bigger than `accepted` by more than
 * `growth_margin_pct` on either axis. We compare the half-extents so a
 * symmetric-grow on both sides is treated the same as one-sided grow.
 */
function regionGrewBeyondMargin(
  accepted: BoundingBoxPercent,
  current: BoundingBoxPercent,
  config: RegionMatchConfig,
): boolean {
  const m = config.growth_margin_pct;
  const widthGrew = current.width - accepted.width > m;
  const heightGrew = current.height - accepted.height > m;
  return widthGrew || heightGrew;
}
