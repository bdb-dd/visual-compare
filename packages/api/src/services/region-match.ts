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
 * Return the index of the accepted region that best matches `current`. -1
 * if no accepted region is within `displacement_tolerance_pct` of the
 * current region's center.
 *
 * "Best" = nearest centroid (L1 distance), with dimension similarity as a
 * tiebreaker. The naive first-match version of this function had a real
 * failure mode: when two accepted regions had centroids within tolerance
 * of a single current region (e.g. one tiny CC sits next to the exact
 * region that should have matched), the matcher paired with whichever
 * came first in the array. That mis-pair then tripped the growth check
 * in compareRegionSets and produced false-positive expanded_diff
 * verdicts on un-changed comparisons.
 *
 * Best-match doesn't fix every pathological case (true bipartite
 * matching would, at the cost of complexity), but it eliminates the
 * common failure where the exact region IS in the accepted set but
 * just happens to be later in the array than a near-but-wrong one.
 */
function findAcceptedMatch(
  accepted: BoundingBoxPercent[],
  current: BoundingBoxPercent,
  config: RegionMatchConfig,
): number {
  const tol = config.displacement_tolerance_pct;
  const cx = current.x + current.width / 2;
  const cy = current.y + current.height / 2;
  let bestIdx = -1;
  let bestCentroid = Infinity;
  let bestDimDelta = Infinity;
  for (let i = 0; i < accepted.length; i += 1) {
    const a = accepted[i]!;
    const ax = a.x + a.width / 2;
    const ay = a.y + a.height / 2;
    const dx = Math.abs(cx - ax);
    const dy = Math.abs(cy - ay);
    if (dx > tol || dy > tol) continue;
    const centroidDist = dx + dy;
    const dimDelta =
      Math.abs(a.width - current.width) + Math.abs(a.height - current.height);
    // Prefer closer centroid; on ties (sub-1e-6) prefer more similar dimensions
    // so a same-dimension match beats a same-centroid different-size one.
    if (
      centroidDist < bestCentroid - 1e-6 ||
      (Math.abs(centroidDist - bestCentroid) <= 1e-6 && dimDelta < bestDimDelta)
    ) {
      bestIdx = i;
      bestCentroid = centroidDist;
      bestDimDelta = dimDelta;
    }
  }
  return bestIdx;
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
