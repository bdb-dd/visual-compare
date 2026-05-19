import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import {
  statusToClusterReviewState,
  type FilterState,
  type Outcome,
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

type CategoryKey = 'header_nav' | 'main' | 'banners' | 'footer_aside' | 'anomalies' | 'untagged' | 'outcomes';

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
 * tail the regular roles. `outcomes` is a separate bucket for synthetic
 * missing-page / capture-failed entries (signature_version='outcome'),
 * surfaced so the Outcome filter has somewhere to land in clusters mode.
 */
const CATEGORY_TABS: { key: CategoryKey; label: string; sectionTitle: string; note?: string }[] = [
  { key: 'header_nav',   label: 'Header & Nav',     sectionTitle: 'Header & Navigation' },
  { key: 'main',         label: 'Main',             sectionTitle: 'Main content' },
  { key: 'banners',      label: 'Banners',          sectionTitle: 'Banners & Overlays' },
  { key: 'footer_aside', label: 'Footer & Aside',   sectionTitle: 'Footer & Aside' },
  { key: 'anomalies',    label: 'Anomalies',        sectionTitle: 'Anomalies (singleton clusters)' },
  { key: 'outcomes',     label: 'Missing & Failed', sectionTitle: 'Missing & Capture-failed pairs',
    note: 'Synthetic buckets for pairs whose comparison was skipped because one side rendered as a 404/soft-404 (Missing on A/B/both) or the capture itself errored. Accept/reject these from the Rows view — they’re read-only here.' },
  { key: 'untagged',     label: 'Untagged',         sectionTitle: 'Untagged (v0 fallback)',
    note: 'These come from the v0 geometric signature — imagick rows and v2-era LM responses that pre-date the v3 prompt. Will reduce after re-evaluation under v3.' },
];

function categoryFor(cluster: ClusterSummaryDto): CategoryKey {
  if (cluster.signature_version === 'outcome') return 'outcomes';
  if (cluster.pair_count === 1) return 'anomalies';
  if (!cluster.region_role) return 'untagged';
  for (const c of CATEGORIES) {
    if (c.roles.includes(cluster.region_role)) return c.key;
  }
  return 'untagged';
}

/**
 * Maps the FilterState `Outcome` chip values to the API's pair_outcome
 * values. Used to filter clusters by their representative outcome bucket.
 */
const OUTCOME_TO_PAIR_OUTCOME: Record<Outcome, ClusterSummaryDto['pair_outcome']> = {
  'present': 'both_present',
  'a-missing': 'a_missing',
  'b-missing': 'b_missing',
  'both-missing': 'both_missing',
  'capture-failed': 'capture_failed',
};

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

  // Apply region + change-type + viewport + outcome in-memory. (Status
  // is server-filtered via reviewStateParam above.) Cluster lists are
  // small enough that this doesn't need memoised slicing structures; a
  // plain filter walk is fine. Viewport filter matches the cluster's
  // representative viewport_name — clusters rarely span viewports in
  // practice because signatures encode layout that differs per viewport.
  //
  // Outcome filter compares against cluster.pair_outcome — `'both_present'`
  // for materialised clusters; the bucket value for synthetic outcome
  // clusters. region/change filters DO NOT apply to synthetic clusters
  // (they have no region_role / change_type) — applying them would
  // silently drop the Missing & Failed tab whenever the user narrows
  // regions, which is confusing. We let them through unconditionally.
  const filteredClusters = useMemo(() => {
    if (!data) return [] as ClusterSummaryDto[];
    let out = data.clusters;
    if (filter.regions.length > 0) {
      out = out.filter((c) =>
        c.signature_version === 'outcome'
        || (c.region_role !== null && filter.regions.includes(c.region_role)),
      );
    }
    if (filter.changes.length > 0) {
      out = out.filter((c) =>
        c.signature_version === 'outcome'
        || (c.change_type !== null && filter.changes.includes(c.change_type)),
      );
    }
    if (filter.viewports.length > 0) {
      out = out.filter((c) => c.viewport_name !== null && filter.viewports.includes(c.viewport_name));
    }
    if (filter.outcomes.length > 0) {
      const allowed = new Set(filter.outcomes.map((o) => OUTCOME_TO_PAIR_OUTCOME[o]));
      out = out.filter((c) => allowed.has(c.pair_outcome));
    }
    return out;
  }, [data, filter.regions, filter.changes, filter.viewports, filter.outcomes]);

  const grouped = useMemo(() => {
    const buckets: Record<CategoryKey, ClusterSummaryDto[]> = {
      header_nav: [], main: [], banners: [], footer_aside: [], anomalies: [], outcomes: [], untagged: [],
    };
    for (const c of filteredClusters) buckets[categoryFor(c)].push(c);
    return buckets;
  }, [filteredClusters]);

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

  // Bulk-accept: lifted out of CategoryGroup so the affordance can live
  // in the summary bar's ⋯ menu instead of taking a full row inside
  // each category. Subgroups are derived from the active category's
  // clusters and keyed by (region_role, change_type). v0 fallback and
  // synthetic-outcome clusters lack the v1 taxonomy so they can't be
  // bulk-accepted; we filter them out here.
  const activeSubgroups = useMemo<BulkAcceptTarget[]>(() => {
    const buckets = new Map<string, BulkAcceptTarget>();
    for (const c of activeClusters) {
      if (!c.region_role || !c.change_type) continue;
      if (c.signature_version !== 'v1') continue;
      const k = `${c.region_role}::${c.change_type}`;
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
    return [...buckets.values()].sort(
      (a, b) => b.clusters.length - a.clusters.length || a.change_type.localeCompare(b.change_type),
    );
  }, [activeClusters]);
  const [bulkConfirming, setBulkConfirming] = useState<BulkAcceptTarget | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const handleBulkAccept = async (target: BulkAcceptTarget): Promise<void> => {
    setBulkBusy(true);
    setError(null);
    try {
      await api.acceptCategory(sessionId, {
        region_role: target.region_role,
        change_type: target.change_type,
        signature_version: target.signature_version,
      });
      setBulkConfirming(null);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
    }
  };

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
        <div className="clusters-tab__summary-actions">
          <button
            type="button"
            onClick={() => void load({ recompute: true })}
            disabled={loading}
            className="clusters-page__refresh"
            title="Rebuild the cluster index from the underlying differences"
          >
            <span className={loading ? 'clusters-page__refresh-spin' : ''} aria-hidden="true">⟳</span>
            <span>{loading ? 'Refreshing…' : 'Refresh'}</span>
          </button>
          <BulkAcceptOverflowMenu
            subgroups={activeSubgroups}
            disabled={bulkBusy}
            onPick={setBulkConfirming}
          />
        </div>
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
      {bulkConfirming && (
        <CategoryAcceptDialog
          target={bulkConfirming}
          busy={bulkBusy}
          onConfirm={() => void handleBulkAccept(bulkConfirming)}
          onCancel={() => setBulkConfirming(null)}
        />
      )}
    </>
  );
}

/**
 * "Bulk accept ▾" overflow that sits beside Refresh in the summary bar.
 * Disabled when the active category has no v1-tagged subgroups (so
 * Untagged / Outcomes show a dimmed button explaining why).
 */
function BulkAcceptOverflowMenu({
  subgroups,
  disabled,
  onPick,
}: {
  subgroups: BulkAcceptTarget[];
  disabled: boolean;
  onPick: (target: BulkAcceptTarget) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);
  const noTargets = subgroups.length === 0;
  return (
    <div className="actions-menu" ref={ref}>
      <button
        type="button"
        className="actions-menu__toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || noTargets}
        title={
          noTargets
            ? 'No v1-tagged subgroups in this category — bulk accept needs a (region, change_type) pair'
            : 'Bulk accept clusters in this category by (region, change_type)'
        }
      >
        ⋯
      </button>
      {open && !noTargets && (
        <ul className="actions-menu__list" role="menu">
          {subgroups.map((sg) => {
            const openCount = sg.clusters.filter(
              (c) => c.review_state === 'open' || c.review_state === 'rejected',
            ).length;
            const openPairs = sg.clusters
              .filter((c) => c.review_state === 'open' || c.review_state === 'rejected')
              .reduce((acc, c) => acc + c.pair_count, 0);
            return (
              <li key={`${sg.region_role}::${sg.change_type}`}>
                <button
                  type="button"
                  role="menuitem"
                  className="actions-menu__item"
                  disabled={openCount === 0}
                  onClick={() => {
                    setOpen(false);
                    onPick(sg);
                  }}
                  title={
                    openCount === 0
                      ? 'All clusters in this subgroup are already accepted'
                      : `Accept all ${openCount} open ${sg.change_type} clusters (${openPairs} pairs)`
                  }
                >
                  Accept all <code>{sg.change_type}</code>{' '}
                  <span className="muted">
                    · {openCount}/{sg.clusters.length}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
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
  onClusterFocus?: (clusterId: string) => void;
  focusedClusterId?: string | null;
  focusedClusterDetail?: ClusterDetailDto | null;
  focusedMemberId?: string | null;
  onMemberFocus?: (id: string | null) => void;
  acceptances?: AcceptanceRow[];
}): JSX.Element {
  const maxPairs = clusters.reduce((acc, c) => Math.max(acc, c.pair_count), 1);

  // Section h3 lives in the active tab pill (count) + summary bar (totals)
  // now — both already point at this category. `title` survives only as
  // the document-level a11y label for the section, which screen readers
  // can still announce via aria-label. Bulk-accept used to live here
  // too; it's now in the summary bar's ⋯ menu (see ClustersTab).
  return (
    <section className="cluster-group" aria-label={title}>
      {note && <p className="cluster-group__note">{note}</p>}
      <ul className="cluster-list">
        {clusters.map((c) => {
          const isFocused = focusedClusterId === c.id;
          const rowClass = `cluster-row${isFocused ? ' cluster-row--focused' : ''}`;
          const showMembers =
            isFocused && focusedClusterDetail?.cluster.id === c.id;
          const activate = onClusterFocus ? () => onClusterFocus(c.id) : undefined;
          return (
            <li key={c.id}>
              <div
                className={rowClass}
                role={activate ? 'button' : undefined}
                tabIndex={activate ? 0 : undefined}
                onClick={activate}
                onKeyDown={
                  activate
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          activate();
                        }
                      }
                    : undefined
                }
              >
                <div className="cluster-row__content">
                  <div className="cluster-row__primary">
                    <span className="cluster-row__label">{c.element_label ?? '(unlabelled)'}</span>
                    <span className="cluster-row__change-type">{c.change_type ?? '—'}</span>
                    {/* Synthetic outcome clusters surface viewport in the
                        badge slot — viewport (mobile vs desktop) is what
                        differentiates otherwise-identical "Capture failed"
                        rows. v0/v1 sigv chips were dropped in favour of
                        the count button on the right (which carries the
                        pair count + export affordance). */}
                    {c.signature_version === 'outcome' && (
                      <span className="cluster-row__viewport">
                        {c.viewport_name ?? '—'}
                      </span>
                    )}
                    <span className={`cluster-row__state cluster-row__state--${c.review_state}`}>
                      {c.review_state}
                    </span>
                    <ClusterCountButton sessionId={sessionId} cluster={c} />
                  </div>
                </div>
                <div className="cluster-row__bar" aria-hidden="true">
                  <div
                    className="cluster-row__bar-fill"
                    style={{ height: `${(c.pair_count / maxPairs) * 100}%` }}
                  />
                </div>
              </div>
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
    </section>
  );
}

/**
 * Right-side count badge on a cluster row. Click to drop a tiny menu
 * with Export A / Export B URL exports — the same actions that used to
 * live behind the inline-Members list's ⋯ button. Fetches the member
 * list on demand (the row only has the summary DTO), so unfocused rows
 * don't pay for member data they may never use.
 *
 * Clicks stopPropagation so the surrounding row-button doesn't focus
 * the cluster as a side-effect of opening the menu.
 */
function ClusterCountButton({
  sessionId,
  cluster,
}: {
  sessionId: string;
  cluster: ClusterSummaryDto;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);
  const exportUrls = async (side: 'a' | 'b'): Promise<void> => {
    setBusy(true);
    try {
      const detail = await api.getCluster(sessionId, cluster.id, { limit: 10000 });
      const urls = detail.members.map((m) => (side === 'a' ? m.url_a : m.url_b));
      const blob = new Blob([urls.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `cluster-${cluster.id}-${side.toUpperCase()}.txt`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(objectUrl);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };
  return (
    <div
      className="actions-menu cluster-row__count-menu"
      ref={ref}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="cluster-row__count-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title={`${cluster.pair_count} pair${cluster.pair_count === 1 ? '' : 's'} — click for export options`}
      >
        {cluster.pair_count}
      </button>
      {open && (
        <ul className="actions-menu__list" role="menu">
          <li>
            <button
              type="button"
              role="menuitem"
              className="actions-menu__item"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                void exportUrls('a');
              }}
            >
              Export A URLs
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
              className="actions-menu__item"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                void exportUrls('b');
              }}
            >
              Export B URLs
            </button>
          </li>
        </ul>
      )}
    </div>
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
  // Partition into accepted vs rejected keys. The label-marker check
  // mirrors ClusterDetailPanel's REJECTED_LABEL_MARKER so the inline
  // member list and the focused-member meta agree on what counts as
  // accepted vs rejected. (Rejected rows still occupy an acceptance
  // row, but the user surfaced them as a reasoned-no — see the dialog.)
  const { acceptedKeys, rejectedKeys } = useMemo(() => {
    const acc = new Set<string>();
    const rej = new Set<string>();
    for (const a of acceptances) {
      const key = `${a.url_pair_id}::${a.viewport_name}`;
      if (a.label === '[Rejected]') rej.add(key);
      else acc.add(key);
    }
    return { acceptedKeys: acc, rejectedKeys: rej };
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

  // Suppress the bar entirely when there's only one viewport — the
  // export ⋯ that used to anchor its right edge has moved up to the
  // cluster row's count button, so a single-tab tablist would carry no
  // information at all.
  const showViewportTabs = viewports.length > 1;
  return (
    <section className="cluster-row__members">
      {showViewportTabs && (
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
        </div>
      )}
      <ul className="member-list">
        {filteredMembers.map((m) => {
          const focused = displayedId === m.difference_id;
          const isRep = m.difference_id === repId;
          const memberKey = `${m.url_pair_id}::${m.viewport_name}`;
          const isAccepted = acceptedKeys.has(memberKey);
          const isRejected = rejectedKeys.has(memberKey);
          const stateLabel = isAccepted ? 'accepted' : isRejected ? 'rejected' : null;
          const rowClass = `member-row${focused ? ' member-row--focused' : ''}${isRep ? ' member-row--representative' : ''}${isAccepted ? ' member-row--accepted' : ''}${isRejected ? ' member-row--rejected' : ''}`;
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
                ? `Representative member${stateLabel ? ` (${stateLabel})` : ''}`
                : stateLabel
                  ? `${stateLabel[0]!.toUpperCase()}${stateLabel.slice(1)} member · click to preview this pair`
                  : 'Click to preview this pair (or use j/k to step)') + ` · ${m.url_a}`}
            >
              {isRep && <span className="member-row__rep-badge" aria-label="representative">★</span>}
              {isAccepted && <span className="member-row__accepted" aria-label="accepted">✓</span>}
              {isRejected && <span className="member-row__rejected" aria-label="rejected">✗</span>}
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
