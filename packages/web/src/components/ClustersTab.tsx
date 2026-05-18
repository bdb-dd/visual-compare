import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import {
  statusToClusterReviewState,
  type FilterState,
} from '../api/filterState.js';
import type {
  AcceptanceRow,
  ClusterDetailDto,
  ClusterListDto,
  ClusterMemberDto,
  ClusterSummaryDto,
} from '@visual-compare/api/types';

/**
 * Cluster review category index — the body of the cluster surface, extracted
 * from `pages/ClustersPage.tsx` in Phase α of the unified-review-surface
 * rollout so the same content can be hosted inside `SessionDetailPage`'s
 * mode-tab strip in Phase β.
 *
 * Behavior is intentionally identical to the previous ClustersPage body —
 * extraction is a pure refactor. State that the page used to own (data fetch,
 * filter, loading, totals) lives here now; future phases will hoist
 * filter state into a shared filter strip + URL-param store.
 *
 * Clusters with NULL region_role come from the v0 fallback signature —
 * mostly imagick rows and pre-v3-prompt LM rows. They land in the
 * "Untagged" group at the bottom because they don't carry the cluster
 * review's semantic intent.
 */

type CategoryKey = 'header_nav' | 'main' | 'banners' | 'footer_aside' | 'anomalies' | 'untagged';

interface Category {
  key: CategoryKey;
  label: string;
  roles: string[]; // matches against cluster.region_role
}

const CATEGORIES: Category[] = [
  { key: 'header_nav',   label: 'Header & Navigation', roles: ['header', 'nav_primary', 'nav_secondary'] },
  { key: 'main',         label: 'Main content',        roles: ['hero', 'main_content'] },
  { key: 'banners',      label: 'Banners & Overlays',  roles: ['alert_banner', 'overlay'] },
  { key: 'footer_aside', label: 'Footer & Aside',      roles: ['footer', 'aside'] },
];

/**
 * Display order for the category tab strip. `anomalies` and `untagged`
 * tail the regular roles. Tab labels are slightly shorter than the
 * section headings to keep the strip from wrapping on narrower viewports.
 */
const CATEGORY_TABS: { key: CategoryKey; label: string; sectionTitle: string; note?: string }[] = [
  { key: 'header_nav',   label: 'Header & Nav',     sectionTitle: 'Header & Navigation' },
  { key: 'main',         label: 'Main',             sectionTitle: 'Main content' },
  { key: 'banners',      label: 'Banners',          sectionTitle: 'Banners & Overlays' },
  { key: 'footer_aside', label: 'Footer & Aside',   sectionTitle: 'Footer & Aside' },
  { key: 'anomalies',    label: 'Anomalies',        sectionTitle: 'Anomalies (singleton clusters)' },
  { key: 'untagged',     label: 'Untagged',         sectionTitle: 'Untagged (v0 fallback)',
    note: 'These come from the v0 geometric signature — imagick rows and v2-era LM responses that pre-date the v3 prompt. Will reduce after re-evaluation under v3.' },
];

function categoryFor(cluster: ClusterSummaryDto): CategoryKey {
  if (cluster.pair_count === 1) return 'anomalies';
  if (!cluster.region_role) return 'untagged';
  for (const c of CATEGORIES) {
    if (c.roles.includes(cluster.region_role)) return c.key;
  }
  return 'untagged';
}

export interface ClustersTabProps {
  sessionId: string;
  /**
   * Phase δ: shared filter state. Status maps to the cluster review_state
   * the API understands; region + change-type apply in-memory to the
   * fetched cluster list. Required: callers that want defaults pass
   * `DEFAULT_FILTER_STATE` explicitly so a forgotten wire-up surfaces as a
   * type error instead of a silent fallback that ignores user input.
   */
  filter: FilterState;
  /**
   * Called when the reviewer clicks a cluster card. When omitted, the
   * card renders as a `<Link>` to the legacy standalone cluster page —
   * preserves behaviour for any caller still using the thin-shell
   * `ClustersPage`. The unified surface (Phase γ+) passes this callback
   * to open the cluster in the detail pane instead of navigating away.
   */
  onClusterFocus?: (clusterId: string) => void;
  /**
   * Called when keyboard nav (Shift+Arrow) moves focus to a sibling
   * cluster. Distinct from `onClusterFocus` so the parent can push a
   * history entry per step — back/forward then walk the keyboard
   * journey. Falls back to `onClusterFocus` when omitted.
   */
  onClusterStep?: (clusterId: string) => void;
  /** Cluster id currently highlighted by the parent (Phase γ+ focus state). */
  focusedClusterId?: string | null;
  /**
   * Cluster detail DTO for the focused cluster, populated by the detail
   * pane's onDataLoaded callback. When present, the inline Members list
   * renders under the focused cluster row.
   */
  focusedClusterDetail?: ClusterDetailDto | null;
  /** Which member is currently active in the right-side image triple. */
  focusedMemberId?: string | null;
  /** Selecting a member updates the right-side detail pane. */
  onMemberFocus?: (id: string | null) => void;
  /** Session acceptances — InlineMemberList tags accepted members with a ✓ pill. */
  acceptances?: AcceptanceRow[];
  /**
   * Bumped by the parent after cluster-shape-changing actions (Split,
   * Recapture) so this tab re-fetches its list. Accept/Reject also bump
   * it so review_state in the cluster list stays in sync with the
   * detail panel.
   */
  refreshTick?: number;
}

export function ClustersTab({
  sessionId,
  filter,
  onClusterFocus,
  onClusterStep,
  focusedClusterId,
  focusedClusterDetail,
  focusedMemberId,
  onMemberFocus,
  acceptances = [],
  refreshTick = 0,
}: ClustersTabProps): JSX.Element {
  const [data, setData] = useState<ClusterListDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // The status filter maps onto the cluster review_state query param —
  // server-side filter when applicable, no filter when the status is
  // 'all' or a row-only value ('regressed' / 'expanded').
  const reviewStateParam = useMemo(() => {
    const mapped = statusToClusterReviewState(filter.status);
    return mapped && mapped !== 'all' ? mapped : undefined;
  }, [filter.status]);

  const load = async (opts: { recompute?: boolean } = {}) => {
    setLoading(true);
    setError(null);
    try {
      const dto = await api.listClusters(sessionId, {
        reviewState: reviewStateParam,
        recompute: opts.recompute,
      });
      setData(dto);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [sessionId, reviewStateParam, refreshTick]);

  // Apply region + change-type in-memory. (Status is server-filtered via
  // reviewStateParam above.) Cluster lists are small enough that this
  // doesn't need memoised slicing structures; a plain filter walk is fine.
  const filteredClusters = useMemo(() => {
    if (!data) return [] as ClusterSummaryDto[];
    let out = data.clusters;
    if (filter.regions.length > 0) {
      out = out.filter((c) => c.region_role !== null && filter.regions.includes(c.region_role));
    }
    if (filter.changes.length > 0) {
      out = out.filter((c) => c.change_type !== null && filter.changes.includes(c.change_type));
    }
    return out;
  }, [data, filter.regions, filter.changes]);

  const grouped = useMemo(() => {
    const buckets: Record<CategoryKey, ClusterSummaryDto[]> = {
      header_nav: [], main: [], banners: [], footer_aside: [], anomalies: [], untagged: [],
    };
    for (const c of filteredClusters) buckets[categoryFor(c)].push(c);
    return buckets;
  }, [filteredClusters]);

  const totals = useMemo(() => {
    if (!data) return null;
    const totalPairs = filteredClusters.reduce((acc, c) => acc + c.pair_count, 0);
    const totalMembers = filteredClusters.reduce((acc, c) => acc + c.member_count, 0);
    return { clusters: filteredClusters.length, pairs: totalPairs, members: totalMembers };
  }, [data, filteredClusters]);

  // Category tab selection lives in the URL (`cat=`) so refresh / share
  // links keep the user on the same category. When the requested category
  // is empty (or the param is missing), fall back to the first non-empty
  // tab — picking an empty tab as the initial view is bad UX.
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedCat = searchParams.get('cat') as CategoryKey | null;
  const activeCat: CategoryKey = useMemo(() => {
    if (requestedCat && (CATEGORY_TABS.find((t) => t.key === requestedCat))) {
      return requestedCat;
    }
    const firstNonEmpty = CATEGORY_TABS.find((t) => grouped[t.key].length > 0);
    return firstNonEmpty?.key ?? 'header_nav';
  }, [requestedCat, grouped]);

  const setActiveCat = (key: CategoryKey): void => {
    const next = new URLSearchParams(searchParams);
    next.set('cat', key);
    setSearchParams(next, { replace: false });
  };

  const activeTabDef = CATEGORY_TABS.find((t) => t.key === activeCat) ?? CATEGORY_TABS[0]!;
  const activeClusters = grouped[activeCat];

  // Shift+ArrowDown / Shift+ArrowUp step to the next/prev cluster within
  // the active category tab. Plain arrows already step rows
  // (SessionResultsList) — the Shift modifier avoids the clash. No
  // wrap-around: stops at the ends. Each step prefers `onClusterStep`
  // (push history) over `onClusterFocus` (replace) so the back button
  // walks the keyboard journey.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.shiftKey) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (target.isContentEditable) return;
      }
      if (activeClusters.length === 0) return;
      const currentIndex = focusedClusterId
        ? activeClusters.findIndex((c) => c.id === focusedClusterId)
        : -1;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      let nextIndex: number;
      if (currentIndex < 0) {
        nextIndex = delta > 0 ? 0 : activeClusters.length - 1;
      } else {
        nextIndex = Math.min(activeClusters.length - 1, Math.max(0, currentIndex + delta));
        if (nextIndex === currentIndex) return;
      }
      e.preventDefault();
      const nextId = activeClusters[nextIndex]!.id;
      (onClusterStep ?? onClusterFocus)?.(nextId);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeClusters, focusedClusterId, onClusterStep, onClusterFocus]);

  return (
    <>
      <div className="clusters-tab__summary-bar">
        {totals && (
          <p className="clusters-page__summary">
            {totals.clusters} cluster{totals.clusters === 1 ? '' : 's'} ·{' '}
            {totals.members} diff{totals.members === 1 ? '' : 's'} ·{' '}
            {totals.pairs} pair-touch{totals.pairs === 1 ? '' : 'es'}
          </p>
        )}
        <button
          type="button"
          onClick={() => void load({ recompute: true })}
          disabled={loading}
          className="clusters-page__refresh"
          title="Rebuild the cluster index from the underlying differences"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {data && filteredClusters.length === 0 && (
        <p className="clusters-page__empty">
          No clusters match the current filters. Try widening the status,
          region, or change-type selection above, or click Refresh to
          recompute the index.
        </p>
      )}

      {data && filteredClusters.length > 0 && (
        <>
          <div className="mode-tabs cluster-category-tabs" role="tablist" aria-label="Cluster category">
            {CATEGORY_TABS.map((t) => {
              const count = grouped[t.key].length;
              const isActive = activeCat === t.key;
              const disabled = count === 0;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  disabled={disabled}
                  className={`mode-tab${isActive ? ' mode-tab--active' : ''}`}
                  onClick={() => !disabled && setActiveCat(t.key)}
                  title={disabled ? `No clusters in ${t.label}` : t.label}
                >
                  {t.label} <span className="cluster-category-tabs__count">({count})</span>
                </button>
              );
            })}
          </div>
          <div className="clusters-page__groups">
            <CategoryGroup
              key={activeTabDef.key}
              title={activeTabDef.sectionTitle}
              clusters={grouped[activeTabDef.key]}
              sessionId={sessionId}
              note={activeTabDef.note}
              onBulkAccepted={() => void load()}
              onClusterFocus={onClusterFocus}
              focusedClusterId={focusedClusterId ?? null}
              focusedClusterDetail={focusedClusterDetail ?? null}
              focusedMemberId={focusedMemberId ?? null}
              onMemberFocus={onMemberFocus}
              acceptances={acceptances}
            />
          </div>
        </>
      )}
    </>
  );
}

interface BulkAcceptTarget {
  region_role: string;
  change_type: string;
  signature_version: string;
  clusters: ClusterSummaryDto[];
}

function CategoryGroup({
  title,
  clusters,
  sessionId,
  note,
  onBulkAccepted,
  onClusterFocus,
  focusedClusterId,
  focusedClusterDetail,
  focusedMemberId,
  onMemberFocus,
  acceptances,
}: {
  title: string;
  clusters: ClusterSummaryDto[];
  sessionId: string;
  note?: string;
  onBulkAccepted?: () => void;
  onClusterFocus?: (clusterId: string) => void;
  focusedClusterId?: string | null;
  focusedClusterDetail?: ClusterDetailDto | null;
  focusedMemberId?: string | null;
  onMemberFocus?: (id: string | null) => void;
  acceptances?: AcceptanceRow[];
}): JSX.Element {
  const totalPairs = clusters.reduce((acc, c) => acc + c.pair_count, 0);
  const maxPairs = clusters.reduce((acc, c) => Math.max(acc, c.pair_count), 1);
  const [confirming, setConfirming] = useState<BulkAcceptTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Group clusters within the category by (region_role, change_type). Only
  // subgroups with at least one v1-tagged cluster get a bulk-accept button;
  // v0 fallback clusters lack the tags so the API call would have no target.
  const subgroups = useMemo(() => {
    const buckets = new Map<string, BulkAcceptTarget>();
    for (const c of clusters) {
      if (!c.region_role || !c.change_type) continue;
      if (c.signature_version !== 'v1') continue;
      const k = `${c.signature_version}::${c.region_role}::${c.change_type}`;
      let b = buckets.get(k);
      if (!b) {
        b = {
          region_role: c.region_role,
          change_type: c.change_type,
          signature_version: c.signature_version,
          clusters: [],
        };
        buckets.set(k, b);
      }
      b.clusters.push(c);
    }
    return [...buckets.values()].sort((a, b) =>
      b.clusters.length - a.clusters.length || a.change_type.localeCompare(b.change_type),
    );
  }, [clusters]);

  const handleBulkAccept = async (target: BulkAcceptTarget): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.acceptCategory(sessionId, {
        region_role: target.region_role,
        change_type: target.change_type,
        signature_version: target.signature_version,
      });
      setConfirming(null);
      onBulkAccepted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="cluster-group">
      <h3 className="cluster-group__title">
        {title} <span className="cluster-group__meta">({clusters.length} cluster{clusters.length === 1 ? '' : 's'}, {totalPairs} pair-touch{totalPairs === 1 ? '' : 'es'})</span>
      </h3>
      {note && <p className="cluster-group__note">{note}</p>}
      {error && <div className="error">{error}</div>}
      {subgroups.length > 0 && (
        <div className="cluster-group__bulk">
          <span className="cluster-group__bulk-label">Bulk accept:</span>
          {subgroups.map((sg) => {
            const openCount = sg.clusters.filter((c) => c.review_state === 'open' || c.review_state === 'rejected').length;
            const openPairs = sg.clusters
              .filter((c) => c.review_state === 'open' || c.review_state === 'rejected')
              .reduce((acc, c) => acc + c.pair_count, 0);
            const disabled = openCount === 0 || busy;
            return (
              <button
                key={`${sg.region_role}::${sg.change_type}`}
                type="button"
                className="cluster-group__bulk-btn"
                disabled={disabled}
                onClick={() => setConfirming(sg)}
                title={openCount === 0 ? 'All clusters in this subgroup are already accepted' : `Accept all ${openCount} open ${sg.change_type} clusters (${openPairs} pairs)`}
              >
                <code>{sg.change_type}</code> · {openCount}/{sg.clusters.length}
              </button>
            );
          })}
        </div>
      )}
      <ul className="cluster-list">
        {clusters.map((c) => {
          const isFocused = focusedClusterId === c.id;
          const rowClass = `cluster-row${isFocused ? ' cluster-row--focused' : ''}`;
          const body = (
            <>
              <div className="cluster-row__content">
                <div className="cluster-row__primary">
                  <span className="cluster-row__label">{c.element_label ?? '(unlabelled)'}</span>
                  <span className="cluster-row__change-type">{c.change_type ?? '—'}</span>
                  <span className={`cluster-row__sigv cluster-row__sigv--${c.signature_version}`}>
                    {c.signature_version}
                  </span>
                  <span className={`cluster-row__state cluster-row__state--${c.review_state}`}>
                    {c.review_state}
                  </span>
                  <span className="cluster-row__pairs">{c.pair_count} pair{c.pair_count === 1 ? '' : 's'}</span>
                </div>
                {c.sample?.description && (
                  <p className="cluster-row__sample">{c.sample.description}</p>
                )}
              </div>
              <div className="cluster-row__bar" aria-hidden="true">
                <div
                  className="cluster-row__bar-fill"
                  style={{ height: `${(c.pair_count / maxPairs) * 100}%` }}
                />
              </div>
            </>
          );
          const showMembers =
            isFocused && focusedClusterDetail?.cluster.id === c.id;
          return (
            <li key={c.id}>
              {onClusterFocus ? (
                <button
                  type="button"
                  className={rowClass}
                  onClick={() => onClusterFocus(c.id)}
                >
                  {body}
                </button>
              ) : (
                <Link to={`/sessions/${sessionId}/clusters/${c.id}`} className={rowClass}>
                  {body}
                </Link>
              )}
              {showMembers && focusedClusterDetail && (
                <InlineMemberList
                  sessionId={sessionId}
                  detail={focusedClusterDetail}
                  focusedMemberId={focusedMemberId ?? null}
                  onMemberFocus={onMemberFocus}
                  acceptances={acceptances ?? []}
                />
              )}
            </li>
          );
        })}
      </ul>
      {confirming && (
        <CategoryAcceptDialog
          target={confirming}
          busy={busy}
          onConfirm={() => void handleBulkAccept(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </section>
  );
}

/**
 * Inline Members list that appears under the focused cluster row in the
 * left list. Clicking a member updates `focusedMemberId` in the page,
 * which drives the right-side image triple + filmstrip in
 * `ClusterDetailPanel`. Falls back to the cluster's representative when
 * `focusedMemberId` is null.
 */
function InlineMemberList({
  sessionId,
  detail,
  focusedMemberId,
  onMemberFocus,
  acceptances,
}: {
  sessionId: string;
  detail: ClusterDetailDto;
  focusedMemberId: string | null;
  onMemberFocus?: (id: string | null) => void;
  acceptances: AcceptanceRow[];
}): JSX.Element {
  const repId = detail.representative?.difference_id ?? null;
  const displayedId = focusedMemberId ?? repId;
  const acceptedKeys = useMemo(() => {
    const s = new Set<string>();
    for (const a of acceptances) s.add(`${a.url_pair_id}::${a.viewport_name}`);
    return s;
  }, [acceptances]);
  // Sort the representative to the top so it's always the first row.
  // The original order otherwise mirrors the cluster's signature
  // ordering, which is the right secondary key.
  const members: ClusterMemberDto[] = useMemo(() => {
    if (!repId) return detail.members;
    const rep = detail.members.find((m) => m.difference_id === repId);
    if (!rep) return detail.members;
    return [rep, ...detail.members.filter((m) => m.difference_id !== repId)];
  }, [detail.members, repId]);

  // Unique viewports present in this cluster, sorted by member count
  // descending (then name asc as a tiebreaker). One tab per viewport,
  // each scoping the list to that viewport's members.
  const viewports = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of members) counts.set(m.viewport_name, (counts.get(m.viewport_name) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
  }, [members]);

  // Active viewport tab. Default to whichever the representative sits
  // on (so the first thing the user sees is the rep), or the most
  // populated viewport when there's no rep. Reset when the cluster
  // (and thus its viewport set) changes underneath.
  const [activeViewport, setActiveViewport] = useState<string | null>(null);
  useEffect(() => {
    if (viewports.length === 0) {
      setActiveViewport(null);
      return;
    }
    if (activeViewport && viewports.some((v) => v.name === activeViewport)) return;
    const rep = detail.representative;
    const repVp = rep && viewports.some((v) => v.name === rep.viewport_name)
      ? rep.viewport_name
      : viewports[0]!.name;
    setActiveViewport(repVp);
  }, [viewports, activeViewport, detail.representative]);

  const filteredMembers = useMemo(() => {
    if (!activeViewport) return members;
    return members.filter((m) => m.viewport_name === activeViewport);
  }, [members, activeViewport]);

  const exportSideUrls = (side: 'a' | 'b') => {
    // Export the full member set (across all viewports), not just the
    // active tab — the file is the canonical list of pairs in this
    // cluster, independent of the in-UI viewport filter.
    const urls = members.map((m) => (side === 'a' ? m.url_a : m.url_b));
    const blob = new Blob([urls.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = `cluster-${detail.cluster.id}-${side.toUpperCase()}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(objectUrl);
  };

  // "…" overflow menu for the Export actions. Same pattern as
  // HeaderOverflowMenu in SessionDetailPage — small inline component
  // using the .actions-menu* styles.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [menuOpen]);

  return (
    <section className="cluster-row__members">
      <div className="cluster-row__members-bar">
        <div className="cluster-row__members-tabs" role="tablist" aria-label="Members by viewport">
          {viewports.map((v) => {
            const isActive = activeViewport === v.name;
            return (
              <button
                key={v.name}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`cluster-row__members-tab${isActive ? ' cluster-row__members-tab--active' : ''}`}
                onClick={() => setActiveViewport(v.name)}
                title={`${v.count} member${v.count === 1 ? '' : 's'} at viewport ${v.name}`}
              >
                {v.name}{' '}
                <span className="cluster-row__members-tab-count">({v.count})</span>
              </button>
            );
          })}
        </div>
        <div className="actions-menu cluster-row__members-menu" ref={menuRef}>
          <button
            type="button"
            className="actions-menu__toggle"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            title="More member actions"
          >
            ⋯
          </button>
          {menuOpen && (
            <ul className="actions-menu__list" role="menu">
              <li>
                <button
                  type="button"
                  role="menuitem"
                  className="actions-menu__item"
                  onClick={() => { setMenuOpen(false); exportSideUrls('a'); }}
                >
                  Export A URLs
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="menuitem"
                  className="actions-menu__item"
                  onClick={() => { setMenuOpen(false); exportSideUrls('b'); }}
                >
                  Export B URLs
                </button>
              </li>
            </ul>
          )}
        </div>
      </div>
      <ul className="member-list">
        {filteredMembers.map((m) => {
          const focused = displayedId === m.difference_id;
          const isRep = m.difference_id === repId;
          const isAccepted = acceptedKeys.has(`${m.url_pair_id}::${m.viewport_name}`);
          const rowClass = `member-row${focused ? ' member-row--focused' : ''}${isRep ? ' member-row--representative' : ''}${isAccepted ? ' member-row--accepted' : ''}`;
          return (
            <li
              key={m.difference_id}
              data-member-id={m.difference_id}
              className={rowClass}
              onClick={() => onMemberFocus?.(m.difference_id)}
              role="button"
              tabIndex={-1}
              aria-pressed={focused}
              title={(isRep
                ? `Representative member${isAccepted ? ' (accepted)' : ''}`
                : isAccepted
                  ? 'Accepted member · click to preview this pair'
                  : 'Click to preview this pair (or use j/k to step)') + ` · ${m.url_a}`}
            >
              {isRep && <span className="member-row__rep-badge" aria-label="representative">★</span>}
              {isAccepted && <span className="member-row__accepted" aria-label="accepted">✓</span>}
              <span className="member-row__url">{m.url_a}</span>
              <span
                className="member-row__changed"
                title={m.changed_pct != null ? 'Pixel-changed percentage from the imagick pass' : 'No pixel diff recorded for this member'}
              >
                {m.changed_pct != null ? `${m.changed_pct.toFixed(2)}%` : '—'}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CategoryAcceptDialog({
  target,
  busy,
  onConfirm,
  onCancel,
}: {
  target: BulkAcceptTarget;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const open = target.clusters.filter((c) => c.review_state === 'open' || c.review_state === 'rejected');
  const totalPairs = open.reduce((acc, c) => acc + c.pair_count, 0);
  const samples = open.slice(0, 3);
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">Accept all <code>{target.change_type}</code> clusters?</h3>
        <p className="dialog__intro">
          This creates a category rule for{' '}
          <code>{target.region_role}</code> + <code>{target.change_type}</code>.
          It will fan out across {open.length} cluster{open.length === 1 ? '' : 's'}{' '}
          touching {totalPairs} pair{totalPairs === 1 ? '' : 's'}. Future
          evaluations that produce matching clusters will be auto-accepted.
        </p>
        <div className="dialog__samples">
          <p className="dialog__samples-label">Sample {samples.length} of {open.length}:</p>
          <ul className="dialog__samples-list">
            {samples.map((c) => (
              <li key={c.id}>
                <code>{c.element_label ?? '(unlabelled)'}</code>{' '}
                <span className="muted">({c.pair_count} pair{c.pair_count === 1 ? '' : 's'})</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="btn" onClick={onConfirm} disabled={busy || open.length === 0}>
            {busy ? 'Accepting…' : `Accept ${open.length} cluster${open.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
