import { useEffect, useMemo, useRef, type JSX } from 'react';
import type { ComparisonDto, UrlPairRow } from '@visual-compare/api/types';

export type ComparisonFilter = 'all' | 'failed' | 'passed';

interface Props {
  comparisons: ComparisonDto[];
  pairsById: Map<string, UrlPairRow>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  filter: ComparisonFilter;
  onFilterChange: (next: ComparisonFilter) => void;
}

export function ComparisonList({
  comparisons,
  pairsById,
  selectedId,
  onSelect,
  filter,
  onFilterChange,
}: Props): JSX.Element {
  const visible = useMemo(() => sortAndFilter(comparisons, filter), [comparisons, filter]);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (visible.length === 0) {
      if (selectedId !== null) onSelect(null);
      return;
    }
    if (selectedId === null || !visible.some((c) => c.id === selectedId)) {
      onSelect(visible[0]!.id);
    }
  }, [visible, selectedId, onSelect]);

  useEffect(() => {
    if (selectedId === null) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-comparison-id="${selectedId}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && isEditable(target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        moveSelection(visible, selectedId, 1, onSelect);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(visible, selectedId, -1, onSelect);
      } else if (e.key === 'f') {
        e.preventDefault();
        onFilterChange(nextFilter(filter));
      } else if (e.key === 'Escape') {
        if (selectedId !== null) {
          e.preventDefault();
          onSelect(null);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, selectedId, filter, onSelect, onFilterChange]);

  return (
    <div className="comparison-list">
      <div className="comparison-list-header">
        <div className="filter-bar" role="tablist" aria-label="Filter comparisons">
          {(['all', 'failed', 'passed'] as ComparisonFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`filter-btn ${filter === f ? 'active' : ''}`}
              onClick={() => onFilterChange(f)}
            >
              {f === 'all' ? 'All' : f === 'failed' ? 'Failed' : 'Passed'}
              <span className="filter-count"> {countFor(comparisons, f)}</span>
            </button>
          ))}
        </div>
        <div className="muted filter-hint">j/k to navigate · f to cycle filter</div>
      </div>
      <div className="comparison-list-rows" ref={listRef}>
        {visible.length === 0 ? (
          <p className="muted" style={{ padding: 12 }}>No comparisons match.</p>
        ) : (
          visible.map((c) => {
            const pair = pairsById.get(c.url_pair_id);
            const label = pair?.label?.trim() || pair?.url_a || c.url_pair_id.slice(0, 8);
            const verdict = verdictOf(c);
            const isSelected = c.id === selectedId;
            return (
              <button
                key={c.id}
                type="button"
                data-comparison-id={c.id}
                className={`comparison-row ${isSelected ? 'selected' : ''} verdict-${verdict}`}
                onClick={() => onSelect(c.id)}
              >
                <div className="thumb">
                  {c.im_diff_url ? (
                    <img src={c.im_diff_url} alt="" loading="lazy" />
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
                    <span className="viewport-badge">{c.viewport_name}</span>
                    <span className="changed-pct">{fmtPct(c.changed_pixel_percentage)}</span>
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

type Verdict = 'failed' | 'passed' | 'unknown';

function verdictOf(c: ComparisonDto): Verdict {
  if (c.is_equivalent === 0) return 'failed';
  if (c.is_equivalent === 1) return 'passed';
  return 'unknown';
}

function verdictGlyph(v: Verdict): string {
  if (v === 'failed') return '✗';
  if (v === 'passed') return '✓';
  return '…';
}

function sortAndFilter(rows: ComparisonDto[], filter: ComparisonFilter): ComparisonDto[] {
  const filtered = rows.filter((c) => {
    if (filter === 'all') return true;
    if (filter === 'failed') return c.is_equivalent === 0;
    return c.is_equivalent === 1;
  });
  return [...filtered].sort((a, b) => {
    const av = verdictRank(a);
    const bv = verdictRank(b);
    if (av !== bv) return av - bv;
    const ap = a.changed_pixel_percentage ?? -1;
    const bp = b.changed_pixel_percentage ?? -1;
    return bp - ap;
  });
}

function verdictRank(c: ComparisonDto): number {
  if (c.is_equivalent === 0) return 0;
  if (c.is_equivalent === null) return 1;
  return 2;
}

function countFor(rows: ComparisonDto[], filter: ComparisonFilter): number {
  if (filter === 'all') return rows.length;
  if (filter === 'failed') return rows.filter((c) => c.is_equivalent === 0).length;
  return rows.filter((c) => c.is_equivalent === 1).length;
}

function nextFilter(f: ComparisonFilter): ComparisonFilter {
  if (f === 'all') return 'failed';
  if (f === 'failed') return 'passed';
  return 'all';
}

function moveSelection(
  visible: ComparisonDto[],
  selectedId: string | null,
  delta: number,
  onSelect: (id: string | null) => void,
): void {
  if (visible.length === 0) return;
  const currentIdx = selectedId === null ? -1 : visible.findIndex((c) => c.id === selectedId);
  let nextIdx: number;
  if (currentIdx === -1) {
    nextIdx = delta > 0 ? 0 : visible.length - 1;
  } else {
    nextIdx = currentIdx + delta;
    if (nextIdx < 0) nextIdx = 0;
    if (nextIdx >= visible.length) nextIdx = visible.length - 1;
  }
  onSelect(visible[nextIdx]!.id);
}

function isEditable(el: HTMLElement): boolean {
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
}

function fmtPct(v: number | null): string {
  if (v === null) return '—';
  return `${v.toFixed(2)}%`;
}
