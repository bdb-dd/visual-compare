import type { ClusterReviewState, MatchedAtLevel, PairOutcome, SessionResultRow } from '@visual-compare/api/types';

/**
 * Shared filter state for the unified review surface (Phase δ). The same
 * shape is consumed by all three modes (Clusters / Rows / Anomalies); each
 * mode interprets the fields against its own underlying record. The state
 * is fully URL-driven so deep links work and back/forward navigates
 * between filter states.
 *
 * URL contract:
 *   ?status=needs_review               (default, omitted from canonical URL)
 *   ?level=tolerant,loose              (comma-separated multi-select)
 *   ?region=nav_primary,...            (comma-separated multi-select)
 *   ?change=text_changed,...           (comma-separated multi-select)
 *   ?outcome=present,capture-failed    (comma-separated multi-select)
 *
 * Default state (= what /sessions/:id renders without query string):
 *   { status: 'needs_review', levels: [], regions: [], changes: [], outcomes: ['present'] }
 */

export type Status = 'all' | 'needs_review' | 'accepted' | 'rejected' | 'regressed' | 'expanded';
export type Level = MatchedAtLevel | 'pending' | 'missing';
// 'capture-failed' is orthogonal to the pair_outcome bucket (a pair can be
// 'present' from the planner's perspective and still have failed captures
// in the latest run, or vice versa). Outcomes are multi-select; selected
// values are OR'd together. Empty = no outcome filter.
export type Outcome = 'present' | 'a-missing' | 'b-missing' | 'both-missing' | 'capture-failed';

export interface FilterState {
  status: Status;
  /** Empty array = no level filter (all levels match). */
  levels: Level[];
  /** Empty array = no region filter. */
  regions: string[];
  /** Empty array = no change_type filter. */
  changes: string[];
  /** Empty array = no outcome filter (all rows match). Selected values OR'd. */
  outcomes: Outcome[];
}

export const DEFAULT_FILTER_STATE: FilterState = {
  status: 'needs_review',
  levels: [],
  regions: [],
  changes: [],
  outcomes: ['present'],
};

const STATUS_VALUES: readonly Status[] = ['all', 'needs_review', 'accepted', 'rejected', 'regressed', 'expanded'];
const LEVEL_VALUES: readonly Level[] = ['pixel-perfect', 'strict', 'tolerant', 'loose', 'none', 'pending', 'missing'];
const OUTCOME_VALUES: readonly Outcome[] = ['present', 'a-missing', 'b-missing', 'both-missing', 'capture-failed'];

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
  const rawOutcome = searchParams.get('outcome');
  // Distinguish "no param" (use default) from "?outcome=" (explicitly empty,
  // = no outcome filter, show all). parseSet returns [] in both cases, so
  // check the raw value to recover the intent.
  const outcomes = rawOutcome === null
    ? DEFAULT_FILTER_STATE.outcomes
    : parseSet(rawOutcome, OUTCOME_VALUES);
  return {
    status: parseEnum(searchParams.get('status'), STATUS_VALUES, DEFAULT_FILTER_STATE.status),
    levels: parseSet(searchParams.get('level'), LEVEL_VALUES),
    regions: parseFreeSet(searchParams.get('region')),
    changes: parseFreeSet(searchParams.get('change')),
    outcomes,
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
  const defaultOutcomes = DEFAULT_FILTER_STATE.outcomes.join(',');
  const currentOutcomes = state.outcomes.join(',');
  if (currentOutcomes !== defaultOutcomes) {
    // An empty selection is meaningful — encode as "outcome=" so the parser
    // can distinguish "no param" (use default) from "explicitly empty".
    sp.set('outcome', currentOutcomes);
  } else {
    sp.delete('outcome');
  }
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
 * Pair-outcome filter check shared by rows + anomalies modes. Returns true
 * when the row matches ANY of the selected outcomes, OR when no outcomes
 * are selected (empty = no filter). `capture-failed` is orthogonal to
 * pair_outcome — it's a property of the latest capture attempt rather than
 * a property of the page content, so it gets its own predicate.
 */
export function outcomeMatches(
  outcomes: Outcome[],
  row: Pick<SessionResultRow, 'pair_outcome' | 'capture_a_status' | 'capture_b_status'>,
): boolean {
  if (outcomes.length === 0) return true;
  return outcomes.some((o) => {
    switch (o) {
      case 'present': return row.pair_outcome === 'both_present';
      case 'a-missing': return row.pair_outcome === 'a_missing';
      case 'b-missing': return row.pair_outcome === 'b_missing';
      case 'both-missing': return row.pair_outcome === 'both_missing';
      case 'capture-failed':
        return row.capture_a_status.status === 'error'
          || row.capture_b_status.status === 'error';
    }
  });
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
