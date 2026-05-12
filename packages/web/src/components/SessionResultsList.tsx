import { useEffect, useMemo, useRef, type JSX } from 'react';
import { isAtLeastAsStrict } from '@visual-compare/api/constants/equivalence';
import type {
  EquivalenceLevelId,
  SessionResultRow,
  SessionResultsSummary,
} from '@visual-compare/api/types';
import { RecapturePairButton } from './RecapturePairButton.js';

export type ResultsFilter =
  | 'all'
  | 'needs_review'
  | 'accepted'
  | 'regressed'
  | 'expanded'
  | 'missing_b'
  | 'missing_a'
  | 'missing_both'
  // Level-bucket filters driven by clicking histogram cells. Kept separate
  // from the chip-row cycle (the chips are status-oriented; the histogram
  // cells provide drill-down by pixel/LM verdict level).
  | 'level_pixel_perfect'
  | 'level_strict'
  | 'level_tolerant'
  | 'level_loose'
  | 'level_none'
  | 'level_pending'
  | 'level_missing';

const FILTER_LABELS: Record<ResultsFilter, string> = {
  all: 'All',
  needs_review: 'Needs review',
  accepted: 'Accepted',
  regressed: 'Regressed',
  expanded: 'Expanded',
  missing_b: 'Missing on B',
  missing_a: 'Missing on A',
  missing_both: 'Both missing',
  level_pixel_perfect: 'pixel-perfect',
  level_strict: 'strict',
  level_tolerant: 'tolerant',
  level_loose: 'loose',
  level_none: 'none',
  level_pending: 'pending',
  level_missing: 'missing',
};

/** Map a histogram bucket key to its corresponding ResultsFilter value. */
const LEVEL_BUCKET_TO_FILTER: Record<
  keyof SessionResultsSummary['by_level'],
  Extract<ResultsFilter, `level_${string}`>
> = {
  'pixel-perfect': 'level_pixel_perfect',
  strict: 'level_strict',
  tolerant: 'level_tolerant',
  loose: 'level_loose',
  none: 'level_none',
  pending: 'level_pending',
  missing: 'level_missing',
};

interface Props {
  results: SessionResultRow[];
  summary: SessionResultsSummary | null;
  targetLevel: EquivalenceLevelId;
  selectedKey: string | null;
  onSelect: (key: string | null, row: SessionResultRow | null) => void;
  filter: ResultsFilter;
  onFilterChange: (next: ResultsFilter) => void;
  /** "a" — open the accept dialog for the selected row. */
  onAcceptShortcut?: (row: SessionResultRow | null) => void;
  /** "A" — accept with the last-used label, no dialog. */
  onQuickAcceptShortcut?: (row: SessionResultRow | null) => void;
  /** "r" — clear the selected row's acceptance. */
  onClearShortcut?: (row: SessionResultRow | null) => void;
  /** Enables the per-row Recapture button. When unset, rows render unchanged. */
  sessionId?: string;
  /** Fires after a successful recapture trigger so the caller can refresh. */
  onRecaptured?: () => void;
}

type Verdict =
  | 'failed'
  | 'passed'
  | 'accepted'
  | 'regressed'
  | 'expanded'
  | 'pending'
  | 'error'
  | 'missing';

function captureErrored(r: SessionResultRow): boolean {
  return r.capture_a_status.status === 'error' || r.capture_b_status.status === 'error';
}

/**
 * Row verdict drives the glyph and the row's color tint. Acceptance state
 * takes precedence over the raw matched_at_level — once the user has
 * accepted a row, its glyph reflects the acceptance bucket.
 *
 * "Passed" requires reaching the *session target*, not just any level.
 * A comparison whose pixel walk only reaches `loose` when the target is
 * `tolerant` is a fail — it didn't meet the bar the session is set to.
 */
function verdictOf(r: SessionResultRow, targetLevel: EquivalenceLevelId): Verdict {
  // Missing-page rows aren't pass/fail — they're a separate class and the
  // visual diff was skipped. Surface them with a dedicated verdict so they
  // can't be confused with a real verdict.
  if (r.pair_outcome !== 'both_present') return 'missing';
  if (r.status === 'pending' || r.matched_at_level === null) {
    return captureErrored(r) ? 'error' : 'pending';
  }
  if (r.acceptance_status === 'regressed') return 'regressed';
  if (r.acceptance_status === 'expanded_diff') return 'expanded';
  if (r.acceptance_status === 'accepted') return 'accepted';
  return isAtLeastAsStrict(r.matched_at_level, targetLevel) ? 'passed' : 'failed';
}

function missingLabel(o: SessionResultRow['pair_outcome']): string | null {
  if (o === 'a_missing') return 'missing on A';
  if (o === 'b_missing') return 'missing on B';
  if (o === 'both_missing') return 'both missing';
  return null;
}

function rowKey(r: SessionResultRow): string {
  return `${r.url_pair_id}::${r.viewport_name}`;
}

function thumbUrl(sha: string | null | undefined): string | null {
  if (!sha || !/^[0-9a-f]{64}$/.test(sha)) return null;
  return `/images/sha256/${sha.slice(0, 2)}/${sha}.png`;
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${v.toFixed(2)}%`;
}

function verdictGlyph(v: Verdict): string {
  if (v === 'failed') return '✗';
  if (v === 'passed') return '✓';
  if (v === 'accepted') return '~';
  if (v === 'regressed') return '↓';
  if (v === 'expanded') return '△';
  if (v === 'error') return '!';
  if (v === 'missing') return '∅';
  return '…';
}

function verdictRank(r: SessionResultRow, targetLevel: EquivalenceLevelId): number {
  const v = verdictOf(r, targetLevel);
  if (v === 'error') return 0;
  if (v === 'regressed') return 1;
  if (v === 'expanded') return 2;
  if (v === 'failed') return 3;
  if (v === 'missing') return 4;
  if (v === 'pending') return 5;
  if (v === 'accepted') return 6;
  return 7; // passed
}

/**
 * 'needs_review' surfaces rows the user hasn't yet signed off on:
 * unaccepted rows that didn't pass at the session target, plus any row
 * whose acceptance regressed or expanded since acceptance. Pending rows
 * also show up here so the user knows what's coming.
 */
function isNeedsReview(r: SessionResultRow, targetLevel: EquivalenceLevelId): boolean {
  if (r.status === 'pending' || r.matched_at_level === null) return true;
  if (r.acceptance_status === 'regressed' || r.acceptance_status === 'expanded_diff') {
    return true;
  }
  if (r.acceptance_status === 'accepted') return false;
  return !isAtLeastAsStrict(r.matched_at_level, targetLevel);
}

function rowMatchesFilter(
  r: SessionResultRow,
  filter: ResultsFilter,
  targetLevel: EquivalenceLevelId,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'needs_review') return isNeedsReview(r, targetLevel);
  if (filter === 'accepted') return r.acceptance_status === 'accepted';
  if (filter === 'regressed') return r.acceptance_status === 'regressed';
  if (filter === 'expanded') return r.acceptance_status === 'expanded_diff';
  if (filter === 'missing_b') return r.pair_outcome === 'b_missing';
  if (filter === 'missing_a') return r.pair_outcome === 'a_missing';
  if (filter === 'missing_both') return r.pair_outcome === 'both_missing';
  // Level-bucket filters mirror the histogram's bucketing in
  // summariseResults: missing-page rows bucket as 'missing' regardless of
  // matched_at_level; everything else falls into pending / its level.
  if (filter === 'level_missing') return r.pair_outcome !== 'both_present';
  if (filter === 'level_pending') {
    return r.pair_outcome === 'both_present' && r.matched_at_level === null;
  }
  if (filter === 'level_pixel_perfect') {
    return r.pair_outcome === 'both_present' && r.matched_at_level === 'pixel-perfect';
  }
  if (filter === 'level_strict') {
    return r.pair_outcome === 'both_present' && r.matched_at_level === 'strict';
  }
  if (filter === 'level_tolerant') {
    return r.pair_outcome === 'both_present' && r.matched_at_level === 'tolerant';
  }
  if (filter === 'level_loose') {
    return r.pair_outcome === 'both_present' && r.matched_at_level === 'loose';
  }
  if (filter === 'level_none') {
    return r.pair_outcome === 'both_present' && r.matched_at_level === 'none';
  }
  return false;
}

function sortAndFilter(
  rows: SessionResultRow[],
  filter: ResultsFilter,
  targetLevel: EquivalenceLevelId,
): SessionResultRow[] {
  const filtered = rows.filter((r) => rowMatchesFilter(r, filter, targetLevel));
  return [...filtered].sort((a, b) => {
    const av = verdictRank(a, targetLevel);
    const bv = verdictRank(b, targetLevel);
    if (av !== bv) return av - bv;
    const ap = a.pixel?.changed_pct ?? -1;
    const bp = b.pixel?.changed_pct ?? -1;
    return bp - ap;
  });
}

function countFor(
  rows: SessionResultRow[],
  filter: ResultsFilter,
  targetLevel: EquivalenceLevelId,
): number {
  let n = 0;
  for (const r of rows) if (rowMatchesFilter(r, filter, targetLevel)) n += 1;
  return n;
}

/**
 * Always shown — these are the row-state buckets reviewers need regardless
 * of whether there's anything in them. (Showing "0 accepted" still teaches
 * the user that the bucket exists.)
 */
const STABLE_FILTERS: ResultsFilter[] = [
  'all',
  'needs_review',
  'accepted',
  'regressed',
  'expanded',
];

/**
 * Conditional — shown only when their count > 0. Most sessions have zero
 * missing pages, and we don't want to clutter the filter bar with three
 * permanently-empty chips. They appear when there's something to filter to.
 */
const MISSING_FILTERS: ResultsFilter[] = ['missing_b', 'missing_a', 'missing_both'];

function visibleFilters(
  rows: SessionResultRow[],
  targetLevel: EquivalenceLevelId,
  active: ResultsFilter,
): ResultsFilter[] {
  const out = [...STABLE_FILTERS];
  for (const f of MISSING_FILTERS) {
    // Keep the active chip even if its count drops to 0 mid-session — better
    // to show "Missing on B (0)" briefly than to yank the active filter out
    // from under the user.
    if (active === f || countFor(rows, f, targetLevel) > 0) out.push(f);
  }
  return out;
}

function nextFilter(f: ResultsFilter, available: ResultsFilter[]): ResultsFilter {
  if (available.length === 0) return f;
  const idx = available.indexOf(f);
  if (idx === -1) return available[0]!;
  return available[(idx + 1) % available.length]!;
}

function isEditable(el: HTMLElement): boolean {
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
}

function moveSelection(
  visible: SessionResultRow[],
  selectedKey: string | null,
  delta: number,
  onSelect: (key: string | null, row: SessionResultRow | null) => void,
): void {
  if (visible.length === 0) return;
  const currentIdx = selectedKey === null ? -1 : visible.findIndex((r) => rowKey(r) === selectedKey);
  let next: number;
  if (currentIdx === -1) next = delta > 0 ? 0 : visible.length - 1;
  else {
    next = currentIdx + delta;
    if (next < 0) next = 0;
    if (next >= visible.length) next = visible.length - 1;
  }
  const r = visible[next]!;
  onSelect(rowKey(r), r);
}

export function SessionResultsList({
  results,
  summary,
  targetLevel,
  selectedKey,
  onSelect,
  filter,
  onFilterChange,
  onAcceptShortcut,
  onQuickAcceptShortcut,
  onClearShortcut,
  sessionId,
  onRecaptured,
}: Props): JSX.Element {
  const visible = useMemo(
    () => sortAndFilter(results, filter, targetLevel),
    [results, filter, targetLevel],
  );
  const filtersToShow = useMemo(
    () => visibleFilters(results, targetLevel, filter),
    [results, targetLevel, filter],
  );
  const listRef = useRef<HTMLDivElement | null>(null);

  // Auto-select the first visible row when the current selection drops out.
  useEffect(() => {
    if (visible.length === 0) {
      if (selectedKey !== null) onSelect(null, null);
      return;
    }
    const stillVisible = visible.some((r) => rowKey(r) === selectedKey);
    if (selectedKey === null || !stillVisible) {
      const r = visible[0]!;
      onSelect(rowKey(r), r);
    }
  }, [visible, selectedKey, onSelect]);

  useEffect(() => {
    if (selectedKey === null) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row-key="${selectedKey}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && isEditable(target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const selectedRow =
        selectedKey === null
          ? null
          : visible.find((r) => rowKey(r) === selectedKey) ?? null;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        moveSelection(visible, selectedKey, 1, onSelect);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(visible, selectedKey, -1, onSelect);
      } else if (e.key === 'f') {
        e.preventDefault();
        onFilterChange(nextFilter(filter, filtersToShow));
      } else if (e.key === 'a' && !e.shiftKey) {
        e.preventDefault();
        onAcceptShortcut?.(selectedRow);
      } else if (e.key === 'A' && e.shiftKey) {
        e.preventDefault();
        onQuickAcceptShortcut?.(selectedRow);
      } else if (e.key === 'r' && !e.shiftKey) {
        e.preventDefault();
        onClearShortcut?.(selectedRow);
      } else if (e.key === 'Escape') {
        if (selectedKey !== null) {
          e.preventDefault();
          onSelect(null, null);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    visible,
    selectedKey,
    filter,
    filtersToShow,
    onSelect,
    onFilterChange,
    onAcceptShortcut,
    onQuickAcceptShortcut,
    onClearShortcut,
  ]);

  return (
    <div className="comparison-list">
      <div className="comparison-list-header">
        {summary && (
          <HistogramStrip
            summary={summary}
            targetLevel={targetLevel}
            filter={filter}
            onFilterChange={onFilterChange}
          />
        )}
        <div className="filter-bar" role="tablist" aria-label="Filter results">
          {filtersToShow.map((f, i) => {
            // Subtle separator between row-state filters and the conditional
            // missing-page filters so reviewers see them as a distinct class.
            const startsMissingGroup =
              i > 0 &&
              MISSING_FILTERS.includes(f) &&
              !MISSING_FILTERS.includes(filtersToShow[i - 1]!);
            return (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                className={`filter-btn ${filter === f ? 'active' : ''}${
                  startsMissingGroup ? ' filter-btn-group-start' : ''
                }`}
                onClick={() => onFilterChange(f)}
              >
                {FILTER_LABELS[f]}
                <span className="filter-count"> {countFor(results, f, targetLevel)}</span>
              </button>
            );
          })}
        </div>
        <div className="muted filter-hint">j/k to navigate · f to cycle filter · a to accept</div>
      </div>
      <div className="comparison-list-rows" ref={listRef}>
        {visible.length === 0 ? (
          <p className="muted" style={{ padding: 12 }}>No results match.</p>
        ) : (
          visible.map((r) => {
            const key = rowKey(r);
            const verdict = verdictOf(r, targetLevel);
            const label = r.label?.trim() || r.url_a;
            const isSelected = key === selectedKey;
            const thumb = thumbUrl(r.pixel?.im_diff_sha256);
            const missing = missingLabel(r.pair_outcome);
            return (
              <div
                key={key}
                className={`comparison-row-wrap ${isSelected ? 'selected' : ''} verdict-${verdict}`}
              >
                <button
                  type="button"
                  data-row-key={key}
                  className={`comparison-row ${isSelected ? 'selected' : ''} verdict-${verdict}`}
                  onClick={() => onSelect(key, r)}
                >
                  <div className="thumb">
                    {thumb ? (
                      <img src={thumb} alt="" loading="lazy" />
                    ) : (
                      <div className="thumb-empty">—</div>
                    )}
                  </div>
                  <div className="meta">
                    <div className="row-line">
                      <span className="label" title={label}>{label}</span>
                      <span className={`verdict-chip verdict-${verdict}`}>{verdictGlyph(verdict)}</span>
                    </div>
                    <div className="row-line muted">
                      <span className="viewport-badge">{r.viewport_name}</span>
                      {missing ? (
                        <span className="viewport-badge">{missing}</span>
                      ) : (
                        <>
                          <span className="viewport-badge">{r.matched_at_level ?? '—'}</span>
                          <span className="changed-pct">{fmtPct(r.pixel?.changed_pct)}</span>
                        </>
                      )}
                    </div>
                  </div>
                </button>
                {sessionId && (
                  <div className="comparison-row-actions">
                    <RecapturePairButton
                      sessionId={sessionId}
                      pairId={r.url_pair_id}
                      compact
                      onTriggered={onRecaptured}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

const LEVEL_ORDER: Array<keyof SessionResultsSummary['by_level']> = [
  'pixel-perfect',
  'strict',
  'tolerant',
  'loose',
  'none',
  'pending',
  // Missing rows (one or both sides rendered as a missing page) have no
  // matched_at_level. Showing them in their own bucket keeps `pending`
  // honest about how much real visual-diff work is left to do.
  'missing',
];

const LEVEL_LABEL: Record<keyof SessionResultsSummary['by_level'], string> = {
  'pixel-perfect': 'pixel-perfect',
  strict: 'strict',
  tolerant: 'tolerant',
  loose: 'loose',
  none: 'none',
  pending: 'pending',
  missing: 'missing',
};

/**
 * Per-level counts strip. The session target is highlighted so users can
 * see at a glance how many comparisons reach it. Zero-count buckets are
 * dimmed but still rendered to keep horizontal positions stable across
 * evaluations.
 */
function HistogramStrip({
  summary,
  targetLevel,
  filter,
  onFilterChange,
}: {
  summary: SessionResultsSummary;
  targetLevel: EquivalenceLevelId;
  filter: ResultsFilter;
  onFilterChange: (next: ResultsFilter) => void;
}): JSX.Element {
  return (
    <div className="histogram-strip" role="toolbar" aria-label="Filter by matched level">
      {LEVEL_ORDER.map((lvl) => {
        const count = summary.by_level[lvl];
        const isTarget = lvl === targetLevel;
        const cellFilter = LEVEL_BUCKET_TO_FILTER[lvl];
        const isActive = filter === cellFilter;
        // Toggle: clicking the already-active cell clears the filter back
        // to 'all'. Clicking a different cell switches to that bucket.
        // Zero-count cells stay clickable but render dimmer (parity with
        // the "empty" class behaviour).
        const onClick = () => onFilterChange(isActive ? 'all' : cellFilter);
        return (
          <button
            key={lvl}
            type="button"
            className={`hist-cell ${isTarget ? 'target' : ''} ${count === 0 ? 'empty' : ''} ${isActive ? 'active' : ''}`}
            title={`${LEVEL_LABEL[lvl]}: ${count}${isActive ? ' (click to clear filter)' : ' (click to filter)'}`}
            aria-pressed={isActive}
            onClick={onClick}
          >
            <span className="hist-count">{count}</span>
            <span className="hist-label">{LEVEL_LABEL[lvl]}</span>
          </button>
        );
      })}
    </div>
  );
}
