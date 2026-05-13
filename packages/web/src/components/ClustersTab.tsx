import { useEffect, useMemo, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { RecapturePairButton } from './RecapturePairButton.js';
import {
  statusToClusterReviewState,
  type FilterState,
} from '../api/filterState.js';
import type {
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
}

export function ClustersTab({
  sessionId,
  filter,
  onClusterFocus,
  focusedClusterId,
  focusedClusterDetail,
  focusedMemberId,
  onMemberFocus,
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

  useEffect(() => { void load(); }, [sessionId, reviewStateParam]);

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
        <div className="clusters-page__groups">
          {CATEGORIES.map((c) => (
            grouped[c.key].length > 0 && (
              <CategoryGroup
                key={c.key}
                title={c.label}
                clusters={grouped[c.key]}
                sessionId={sessionId}
                onBulkAccepted={() => void load()}
                onClusterFocus={onClusterFocus}
                focusedClusterId={focusedClusterId ?? null}
                focusedClusterDetail={focusedClusterDetail ?? null}
                focusedMemberId={focusedMemberId ?? null}
                onMemberFocus={onMemberFocus}
              />
            )
          ))}
          {grouped.anomalies.length > 0 && (
            <CategoryGroup
              title="Anomalies (singleton clusters)"
              clusters={grouped.anomalies}
              sessionId={sessionId}
              onBulkAccepted={() => void load()}
              onClusterFocus={onClusterFocus}
              focusedClusterId={focusedClusterId ?? null}
              focusedClusterDetail={focusedClusterDetail ?? null}
              focusedMemberId={focusedMemberId ?? null}
              onMemberFocus={onMemberFocus}
            />
          )}
          {grouped.untagged.length > 0 && (
            <CategoryGroup
              title="Untagged (v0 fallback)"
              clusters={grouped.untagged}
              sessionId={sessionId}
              note="These come from the v0 geometric signature — imagick rows and v2-era LM responses that pre-date the v3 prompt. Will reduce after re-evaluation under v3."
              onClusterFocus={onClusterFocus}
              focusedClusterId={focusedClusterId ?? null}
              focusedClusterDetail={focusedClusterDetail ?? null}
              focusedMemberId={focusedMemberId ?? null}
              onMemberFocus={onMemberFocus}
            />
          )}
        </div>
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
}: {
  sessionId: string;
  detail: ClusterDetailDto;
  focusedMemberId: string | null;
  onMemberFocus?: (id: string | null) => void;
}): JSX.Element {
  const members: ClusterMemberDto[] = detail.members;
  const repId = detail.representative?.difference_id ?? null;
  const displayedId = focusedMemberId ?? repId;
  return (
    <section className="cluster-row__members">
      <h4 className="cluster-row__members-title">
        Members{' '}
        <span className="cluster-row__members-count">
          ({members.length}
          {members.length < detail.cluster.member_count
            ? ` of ${detail.cluster.member_count}`
            : ''}
          )
        </span>
      </h4>
      <ul className="member-list">
        {members.map((m) => {
          const focused = displayedId === m.difference_id;
          return (
            <li
              key={m.difference_id}
              data-member-id={m.difference_id}
              className={`member-row${focused ? ' member-row--focused' : ''}`}
              onClick={() => onMemberFocus?.(m.difference_id)}
              role="button"
              tabIndex={-1}
              aria-pressed={focused}
              title="Click to preview this pair (or use j/k to step)"
            >
              <span className="member-row__url">{m.url_a}</span>
              <span className="member-row__vp">{m.viewport_name}</span>
              <span
                className="member-row__nested"
                onClick={(e) => e.stopPropagation()}
              >
                <RecapturePairButton
                  sessionId={sessionId}
                  pairId={m.url_pair_id}
                  compact
                  className="member-row__recapture"
                />
              </span>
              <Link
                to={`/comparisons/${m.comparison_id}`}
                className="member-row__detail"
                title="Open full comparison detail"
                onClick={(e) => e.stopPropagation()}
              >
                Open →
              </Link>
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
