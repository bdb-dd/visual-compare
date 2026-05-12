import type { ClusterReviewState, MatchedAtLevel, PairOutcome } from '@visual-compare/api/types';

/**
 * Shared filter state for the unified review surface (Phase δ). The same
 * shape is consumed by all three modes (Clusters / Rows / Anomalies); each
 * mode interprets the fields against its own underlying record. The state
 * is fully URL-driven so deep links work and back/forward navigates
 * between filter states.
 *
 * URL contract:
 *   ?status=needs_review     (default, omitted from canonical URL)
 *   ?level=tolerant,loose    (comma-separated multi-select)
 *   ?region=nav_primary,...  (comma-separated multi-select)
 *   ?change=text_changed,... (comma-separated multi-select)
 *   ?outcome=present         (default, omitted from canonical URL)
 *
 * Default state (= what /sessions/:id renders without query string):
 *   { status: 'needs_review', levels: [], regions: [], changes: [], outcome: 'present' }
 */

export type Status = 'all' | 'needs_review' | 'accepted' | 'rejected' | 'regressed' | 'expanded';
export type Level = MatchedAtLevel | 'pending' | 'missing';
export type Outcome = 'present' | 'a-missing' | 'b-missing' | 'both-missing';

export interface FilterState {
  status: Status;
  /** Empty array = no level filter (all levels match). */
  levels: Level[];
  /** Empty array = no region filter. */
  regions: string[];
  /** Empty array = no change_type filter. */
  changes: string[];
  outcome: Outcome;
}

export const DEFAULT_FILTER_STATE: FilterState = {
  status: 'needs_review',
  levels: [],
  regions: [],
  changes: [],
  outcome: 'present',
};

const STATUS_VALUES: readonly Status[] = ['all', 'needs_review', 'accepted', 'rejected', 'regressed', 'expanded'];
const LEVEL_VALUES: readonly Level[] = ['pixel-perfect', 'strict', 'tolerant', 'loose', 'none', 'pending', 'missing'];
const OUTCOME_VALUES: readonly Outcome[] = ['present', 'a-missing', 'b-missing', 'both-missing'];

function parseEnum<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function parseSet<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  if (!raw) return [];
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const out = new Set<T>();
  for (const p of parts) {
    if ((allowed as readonly string[]).includes(p)) out.add(p as T);
  }
  return [...out].sort();
}

function parseFreeSet(raw: string | null): string[] {
  if (!raw) return [];
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(parts)].sort();
}

export function parseFilterState(searchParams: URLSearchParams): FilterState {
  return {
    status: parseEnum(searchParams.get('status'), STATUS_VALUES, DEFAULT_FILTER_STATE.status),
    levels: parseSet(searchParams.get('level'), LEVEL_VALUES),
    regions: parseFreeSet(searchParams.get('region')),
    changes: parseFreeSet(searchParams.get('change')),
    outcome: parseEnum(searchParams.get('outcome'), OUTCOME_VALUES, DEFAULT_FILTER_STATE.outcome),
  };
}

/**
 * Write the filter state into the given URLSearchParams (mutated in place).
 * Defaults are omitted so the canonical URL stays clean.
 */
export function applyFilterStateToParams(state: FilterState, sp: URLSearchParams): void {
  if (state.status !== DEFAULT_FILTER_STATE.status) sp.set('status', state.status);
  else sp.delete('status');
  if (state.levels.length > 0) sp.set('level', state.levels.join(','));
  else sp.delete('level');
  if (state.regions.length > 0) sp.set('region', state.regions.join(','));
  else sp.delete('region');
  if (state.changes.length > 0) sp.set('change', state.changes.join(','));
  else sp.delete('change');
  if (state.outcome !== DEFAULT_FILTER_STATE.outcome) sp.set('outcome', state.outcome);
  else sp.delete('outcome');
}

/**
 * Convenience: maps the shared `status` filter to the cluster review_state
 * the API understands. Returns `undefined` for statuses that aren't
 * cluster-applicable (the chip should be disabled in those cases).
 */
export function statusToClusterReviewState(s: Status): ClusterReviewState | 'all' | undefined {
  switch (s) {
    case 'all': return 'all';
    case 'needs_review': return 'open';
    case 'accepted': return 'accepted';
    case 'rejected': return 'rejected';
    case 'regressed':
    case 'expanded':
      return undefined; // not applicable to clusters
  }
}

/**
 * Pair-outcome filter check shared by rows + anomalies modes.
 */
export function outcomeMatches(outcome: Outcome, pairOutcome: PairOutcome): boolean {
  switch (outcome) {
    case 'present': return pairOutcome === 'both_present';
    case 'a-missing': return pairOutcome === 'a_missing';
    case 'b-missing': return pairOutcome === 'b_missing';
    case 'both-missing': return pairOutcome === 'both_missing';
  }
}

/**
 * Level filter check. Empty `levels` means no filter (any level matches).
 * Mirrors the bucketing in `services/evaluator.ts:summariseResults`:
 * missing-page rows always bucket as 'missing'; rows without a verdict
 * bucket as 'pending'; everything else falls into its matched_at_level.
 */
export function levelMatches(
  levels: Level[],
  matchedAtLevel: MatchedAtLevel | null,
  pairOutcome: PairOutcome,
): boolean {
  if (levels.length === 0) return true;
  const bucket: Level =
    pairOutcome !== 'both_present'
      ? 'missing'
      : matchedAtLevel === null
        ? 'pending'
        : matchedAtLevel;
  return levels.includes(bucket);
}
