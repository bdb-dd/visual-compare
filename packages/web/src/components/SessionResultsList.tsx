import { useEffect, useMemo, useRef, type JSX } from 'react';
import type { SessionResultRow } from '@visual-compare/api/types';

export type ResultsFilter = 'all' | 'failed' | 'passed' | 'pending';

interface Props {
  results: SessionResultRow[];
  selectedKey: string | null;
  onSelect: (key: string | null, row: SessionResultRow | null) => void;
  filter: ResultsFilter;
  onFilterChange: (next: ResultsFilter) => void;
}

type Verdict = 'failed' | 'passed' | 'accepted' | 'pending' | 'error';

function captureErrored(r: SessionResultRow): boolean {
  return r.capture_a_status.status === 'error' || r.capture_b_status.status === 'error';
}

function verdictOf(r: SessionResultRow): Verdict {
  if (r.acceptance_status === 'accepted') return 'accepted';
  if (r.status === 'pending' || r.matched_at_level === null) {
    return captureErrored(r) ? 'error' : 'pending';
  }
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
  if (v === 'error') return '!';
  return '…';
}

function verdictRank(r: SessionResultRow): number {
  const v = verdictOf(r);
  if (v === 'error') return 0;
  if (v === 'failed') return 1;
  if (v === 'pending') return 2;
  if (v === 'accepted') return 3;
  return 4;
}

function sortAndFilter(rows: SessionResultRow[], filter: ResultsFilter): SessionResultRow[] {
  const filtered = rows.filter((r) => {
    const v = verdictOf(r);
    if (filter === 'all') return true;
    if (filter === 'failed') return v === 'failed' || v === 'accepted' || v === 'error';
    if (filter === 'passed') return v === 'passed';
    return v === 'pending';
  });
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
  return sortAndFilter(rows, filter).length;
}

function nextFilter(f: ResultsFilter): ResultsFilter {
  if (f === 'all') return 'failed';
  if (f === 'failed') return 'passed';
  if (f === 'passed') return 'pending';
  return 'all';
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
  selectedKey,
  onSelect,
  filter,
  onFilterChange,
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

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        moveSelection(visible, selectedKey, 1, onSelect);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(visible, selectedKey, -1, onSelect);
      } else if (e.key === 'f') {
        e.preventDefault();
        onFilterChange(nextFilter(filter));
      } else if (e.key === 'Escape') {
        if (selectedKey !== null) {
          e.preventDefault();
          onSelect(null, null);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, selectedKey, filter, onSelect, onFilterChange]);

  return (
    <div className="comparison-list">
      <div className="comparison-list-header">
        <div className="filter-bar" role="tablist" aria-label="Filter results">
          {(['all', 'failed', 'passed', 'pending'] as ResultsFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`filter-btn ${filter === f ? 'active' : ''}`}
              onClick={() => onFilterChange(f)}
            >
              {f === 'all' ? 'All' : f === 'failed' ? 'Failed' : f === 'passed' ? 'Passed' : 'Pending'}
              <span className="filter-count"> {countFor(results, f)}</span>
            </button>
          ))}
        </div>
        <div className="muted filter-hint">j/k to navigate · f to cycle filter</div>
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
