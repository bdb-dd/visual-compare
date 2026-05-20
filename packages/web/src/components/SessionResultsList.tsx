import { useEffect, useMemo, useRef, type JSX } from 'react';
import { isAtLeastAsStrict } from '@visual-compare/api/constants/equivalence';
import type {
  EquivalenceLevelId,
  SessionResultRow,
  SessionResultsSummary,
} from '@visual-compare/api/types';
import { RecapturePairButton } from './RecapturePairButton.js';
import { useReviewCaptureEta } from '../hooks/useReviewDashboard.js';
import { CaptureStatusChip } from './CaptureStatusChip.js';
import {
  levelMatches,
  outcomeMatches,
  type FilterState,
  type Level,
} from '../api/filterState.js';

interface Props {
  results: SessionResultRow[];
  summary: SessionResultsSummary | null;
  targetLevel: EquivalenceLevelId;
  selectedKey: string | null;
  onSelect: (key: string | null, row: SessionResultRow | null) => void;
  /**
   * Phase δ: shared filter state. The component reads status/levels/outcome
   * from this and filters rows accordingly. region/change fields are
   * ignored (rows don't carry the cluster taxonomy directly).
   */
  filter: FilterState;
  onFilterChange: (next: FilterState) => void;
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

function rowMatchesStatus(
  r: SessionResultRow,
  filter: FilterState,
  targetLevel: EquivalenceLevelId,
): boolean {
  switch (filter.status) {
    case 'all': return true;
    case 'needs_review': return isNeedsReview(r, targetLevel);
    case 'accepted': return r.acceptance_status === 'accepted';
    case 'regressed': return r.acceptance_status === 'regressed';
    case 'expanded': return r.acceptance_status === 'expanded_diff';
    // 'rejected' is a cluster-only state; FilterStrip disables the chip
    // in Rows mode, but if the URL carries it we fall through to nothing
    // matching to keep semantics consistent.
    case 'rejected': return false;
  }
}

function rowMatchesFilter(
  r: SessionResultRow,
  filter: FilterState,
  targetLevel: EquivalenceLevelId,
): boolean {
  if (!rowMatchesStatus(r, filter, targetLevel)) return false;
  if (!outcomeMatches(filter.outcomes, r)) return false;
  if (!levelMatches(filter.levels, r.matched_at_level, r.pair_outcome)) return false;
  if (filter.viewports.length > 0 && !filter.viewports.includes(r.viewport_name)) return false;
  return true;
}

function sortAndFilter(
  rows: SessionResultRow[],
  filter: FilterState,
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
  const listRef = useRef<HTMLDivElement | null>(null);

  // ETA map is provided by the shared ReviewDashboardProvider — one
  // poll per session, distributed via context. No local polling here.
  const etaByKey = useReviewCaptureEta();

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
    onSelect,
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
        <div className="muted filter-hint">j/k to navigate · a to accept · use the filter strip above</div>
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
            const aErr = r.capture_a_status.status === 'error';
            const bErr = r.capture_b_status.status === 'error';
            const errored = aErr || bErr;
            return (
              <div
                key={key}
                className={`comparison-row-wrap ${isSelected ? 'selected' : ''} verdict-${verdict}`}
              >
                <div
                  role="button"
                  tabIndex={0}
                  data-row-key={key}
                  className={`comparison-row ${isSelected ? 'selected' : ''} verdict-${verdict}`}
                  onClick={() => onSelect(key, r)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(key, r);
                    }
                  }}
                >
                  <div className="thumb">
                    {thumb ? (
                      <img src={thumb} alt="" loading="lazy" />
                    ) : (
                      <div className="thumb-empty">—</div>
                    )}
                    {r.acceptance_rule_id && (
                      <span
                        className="provenance-badge"
                        title={`Accepted via ${r.acceptance_rule_scope ?? 'rule'} fan-out (rule id ${r.acceptance_rule_id.slice(0, 8)}…)`}
                      >
                        via {r.acceptance_rule_scope ?? 'rule'}
                      </span>
                    )}
                  </div>
                  <div className="meta">
                    <div className="row-line">
                      <span className="label" title={label}>{label}</span>
                      <span className="row-line__actions">
                        <span className={`verdict-chip verdict-${verdict}`}>{verdictGlyph(verdict)}</span>
                        {sessionId && (
                          <RecapturePairButton
                            sessionId={sessionId}
                            pairId={r.url_pair_id}
                            iconOnly
                            onTriggered={onRecaptured}
                          />
                        )}
                      </span>
                    </div>
                    <div className="row-line muted">
                      <span className="viewport-badge">{r.viewport_name}</span>
                      <CaptureStatusChip
                        statusA={r.capture_a_status}
                        statusB={r.capture_b_status}
                        etaMs={etaByKey.get(key)?.eta_ms}
                      />
                      {missing ? (
                        <span className="viewport-badge">{missing}</span>
                      ) : !errored && (
                        <>
                          <span className="viewport-badge">{r.matched_at_level ?? '—'}</span>
                          <span className="changed-pct">{fmtPct(r.pixel?.changed_pct)}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
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
 *
 * Phase δ: clicking a cell toggles that level in/out of the multi-select
 * level filter in the shared FilterState (single click → narrow to that
 * level; click again → drop it back out). The filter-strip's Level zone
 * shows the same chips up at the top of the page; the histogram
 * provides a count-aware in-place toggle.
 */
function HistogramStrip({
  summary,
  targetLevel,
  filter,
  onFilterChange,
}: {
  summary: SessionResultsSummary;
  targetLevel: EquivalenceLevelId;
  filter: FilterState;
  onFilterChange: (next: FilterState) => void;
}): JSX.Element {
  return (
    <div className="histogram-strip" role="toolbar" aria-label="Filter by matched level">
      {LEVEL_ORDER.map((lvl) => {
        const count = summary.by_level[lvl];
        const isTarget = lvl === targetLevel;
        const isActive = filter.levels.includes(lvl as Level);
        const onClick = () => {
          const next = isActive
            ? filter.levels.filter((l) => l !== lvl)
            : [...filter.levels, lvl as Level].sort();
          onFilterChange({ ...filter, levels: next });
        };
        return (
          <button
            key={lvl}
            type="button"
            className={`hist-cell ${isTarget ? 'target' : ''} ${count === 0 ? 'empty' : ''} ${isActive ? 'active' : ''}`}
            title={`${LEVEL_LABEL[lvl]}: ${count}${isActive ? ' (click to remove from level filter)' : ' (click to narrow to this level)'}`}
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
