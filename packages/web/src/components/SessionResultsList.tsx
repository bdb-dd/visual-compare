import { useEffect, useMemo, useRef, type JSX } from 'react';
import type {
  EquivalenceLevelId,
  SessionResultRow,
  SessionResultsSummary,
} from '@visual-compare/api/types';

export type ResultsFilter =
  | 'all'
  | 'needs_review'
  | 'accepted'
  | 'regressed'
  | 'expanded';

const FILTER_LABELS: Record<ResultsFilter, string> = {
  all: 'All',
  needs_review: 'Needs review',
  accepted: 'Accepted',
  regressed: 'Regressed',
  expanded: 'Expanded',
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
}

type Verdict =
  | 'failed'
  | 'passed'
  | 'accepted'
  | 'regressed'
  | 'expanded'
  | 'pending'
  | 'error';

function captureErrored(r: SessionResultRow): boolean {
  return r.capture_a_status.status === 'error' || r.capture_b_status.status === 'error';
}

/**
 * Row verdict drives the glyph and the row's color tint. Acceptance state
 * takes precedence over the raw matched_at_level — once the user has
 * accepted a row, its glyph reflects the acceptance bucket.
 */
function verdictOf(r: SessionResultRow): Verdict {
  if (r.status === 'pending' || r.matched_at_level === null) {
    return captureErrored(r) ? 'error' : 'pending';
  }
  if (r.acceptance_status === 'regressed') return 'regressed';
  if (r.acceptance_status === 'expanded_diff') return 'expanded';
  if (r.acceptance_status === 'accepted') return 'accepted';
  return r.matched_at_level !== 'none' ? 'passed' : 'failed';
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
  return '…';
}

function verdictRank(r: SessionResultRow): number {
  const v = verdictOf(r);
  if (v === 'error') return 0;
  if (v === 'regressed') return 1;
  if (v === 'expanded') return 2;
  if (v === 'failed') return 3;
  if (v === 'pending') return 4;
  if (v === 'accepted') return 5;
  return 6; // passed
}

/**
 * 'needs_review' surfaces rows the user hasn't yet signed off on:
 * unaccepted rows that didn't pass at the session target, plus any row
 * whose acceptance regressed or expanded since acceptance. Pending rows
 * also show up here so the user knows what's coming.
 */
function isNeedsReview(r: SessionResultRow): boolean {
  if (r.status === 'pending' || r.matched_at_level === null) return true;
  if (r.acceptance_status === 'regressed' || r.acceptance_status === 'expanded_diff') {
    return true;
  }
  if (r.acceptance_status === 'accepted') return false;
  return r.matched_at_level === 'none';
}

function rowMatchesFilter(r: SessionResultRow, filter: ResultsFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'needs_review') return isNeedsReview(r);
  if (filter === 'accepted') return r.acceptance_status === 'accepted';
  if (filter === 'regressed') return r.acceptance_status === 'regressed';
  return r.acceptance_status === 'expanded_diff';
}

function sortAndFilter(rows: SessionResultRow[], filter: ResultsFilter): SessionResultRow[] {
  const filtered = rows.filter((r) => rowMatchesFilter(r, filter));
  return [...filtered].sort((a, b) => {
    const av = verdictRank(a);
    const bv = verdictRank(b);
    if (av !== bv) return av - bv;
    const ap = a.pixel?.changed_pct ?? -1;
    const bp = b.pixel?.changed_pct ?? -1;
    return bp - ap;
  });
}

function countFor(rows: SessionResultRow[], filter: ResultsFilter): number {
  let n = 0;
  for (const r of rows) if (rowMatchesFilter(r, filter)) n += 1;
  return n;
}

const FILTER_ORDER: ResultsFilter[] = [
  'all',
  'needs_review',
  'accepted',
  'regressed',
  'expanded',
];

function nextFilter(f: ResultsFilter): ResultsFilter {
  const idx = FILTER_ORDER.indexOf(f);
  return FILTER_ORDER[(idx + 1) % FILTER_ORDER.length]!;
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
}: Props): JSX.Element {
  const visible = useMemo(() => sortAndFilter(results, filter), [results, filter]);
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
        onFilterChange(nextFilter(filter));
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
    onFilterChange,
    onAcceptShortcut,
    onQuickAcceptShortcut,
    onClearShortcut,
  ]);

  return (
    <div className="comparison-list">
      <div className="comparison-list-header">
        {summary && <HistogramStrip summary={summary} targetLevel={targetLevel} />}
        <div className="filter-bar" role="tablist" aria-label="Filter results">
          {FILTER_ORDER.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`filter-btn ${filter === f ? 'active' : ''}`}
              onClick={() => onFilterChange(f)}
            >
              {FILTER_LABELS[f]}
              <span className="filter-count"> {countFor(results, f)}</span>
            </button>
          ))}
        </div>
        <div className="muted filter-hint">j/k to navigate · f to cycle filter · a to accept</div>
      </div>
      <div className="comparison-list-rows" ref={listRef}>
        {visible.length === 0 ? (
          <p className="muted" style={{ padding: 12 }}>No results match.</p>
        ) : (
          visible.map((r) => {
            const key = rowKey(r);
            const verdict = verdictOf(r);
            const label = r.label?.trim() || r.url_a;
            const isSelected = key === selectedKey;
            const thumb = thumbUrl(r.pixel?.im_diff_sha256);
            return (
              <button
                key={key}
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
                    <span className="viewport-badge">{r.matched_at_level ?? '—'}</span>
                    <span className="changed-pct">{fmtPct(r.pixel?.changed_pct)}</span>
                  </div>
                </div>
              </button>
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
];

const LEVEL_LABEL: Record<keyof SessionResultsSummary['by_level'], string> = {
  'pixel-perfect': 'pixel-perfect',
  strict: 'strict',
  tolerant: 'tolerant',
  loose: 'loose',
  none: 'none',
  pending: 'pending',
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
}: {
  summary: SessionResultsSummary;
  targetLevel: EquivalenceLevelId;
}): JSX.Element {
  return (
    <div className="histogram-strip" aria-label="Counts by matched level">
      {LEVEL_ORDER.map((lvl) => {
        const count = summary.by_level[lvl];
        const isTarget = lvl === targetLevel;
        return (
          <div
            key={lvl}
            className={`hist-cell ${isTarget ? 'target' : ''} ${count === 0 ? 'empty' : ''}`}
            title={`${LEVEL_LABEL[lvl]}: ${count}`}
          >
            <span className="hist-count">{count}</span>
            <span className="hist-label">{LEVEL_LABEL[lvl]}</span>
          </div>
        );
      })}
    </div>
  );
}
