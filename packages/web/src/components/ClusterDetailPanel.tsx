import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { ImageWithBoxes } from './ImageWithBoxes.js';
import { StaleBadge } from './StaleBadge.js';
import { useReviewCaptureEta, useReviewDashboard } from '../hooks/useReviewDashboard.js';
import { FitModeToggle, useFitMode } from './FitModeToggle.js';
import { useSyncedScroll, type SyncedScroll } from './useSyncedScroll.js';
import { RecapturePairButton } from './RecapturePairButton.js';
import type {
  AcceptanceRow,
  BoundingBoxPercent,
  ClusterDetailDto,
  ClusterMemberDto,
  DifferenceClusterRow,
} from '@visual-compare/api/types';

/**
 * Cluster detail body. Title + Accept/Reject/Split pills live in the
 * detail-pane chrome (rendered by SessionDetailPage via DetailPane's
 * titleSlot / actionsSlot). This component renders only the sample
 * block (filmstrip + toolbar + meta + images) plus the modal dialogs
 * those actions open via parent-incremented trigger counters.
 *
 * State flow (mirrored by chrome buttons):
 *   open      → Accept enabled, Reject enabled
 *   anomaly   → Accept enabled, Reject enabled
 *   accepted  → Accept disabled, Reject enabled (revokes the rule)
 *   rejected  → Accept enabled (re-accept), Reject disabled
 *   split     → Accept disabled, Reject disabled (terminal)
 */

function imageUrl(sha: string | null | undefined): string | null {
  if (!sha || !/^[0-9a-f]{64}$/.test(sha)) return null;
  return `/images/sha256/${sha.slice(0, 2)}/${sha}.png`;
}

/**
 * Sentinel value written to acceptances.label when the user "rejects" a
 * member. Lets the UI render a red ✗ pill where it would normally show
 * the green ✓ accepted pill. The underlying row is still a regular
 * acceptance — see handleRejectMember for the caveat.
 */
const REJECTED_LABEL_MARKER = '[Rejected]';
function isRejectedAcceptance(a: { label: string | null } | null | undefined): boolean {
  return !!a && a.label === REJECTED_LABEL_MARKER;
}

export interface ClusterDetailPanelProps {
  sessionId: string;
  clusterId: string;
  /** Called when accept/reject mutates state. Parent can refresh upstream lists. */
  onChanged?: () => void;
  /**
   * Fires whenever the panel loads or updates the cluster, with the
   * current review_state. SessionDetailPage uses this to feed the
   * ActionsMenu its disable-conditions for the Accept/Reject items —
   * without this the menu can't tell whether the focused cluster is
   * accepted (and Reject ends up wrongly disabled).
   */
  onClusterLoaded?: (cluster: import('@visual-compare/api/types').DifferenceClusterRow) => void;
  /**
   * Counter the parent bumps to ask the panel to open its accept dialog.
   * Same pattern ComparisonDetail uses for the "a" keyboard shortcut —
   * lets the ActionsMenu in Phase γ trigger the dialog without lifting
   * the dialog state out of the panel.
   */
  openAcceptDialogTrigger?: number;
  /** Counterpart for the reject dialog. */
  openRejectDialogTrigger?: number;
  /** Counterpart for the split dialog (chrome button hoisted to parent). */
  openSplitDialogTrigger?: number;
  /**
   * Counter the parent bumps to ask the panel to re-fetch the cluster.
   * Used post-Recapture once the cluster index has been recomputed so
   * the visible member list / counts / sample reflect the new state.
   */
  refreshTrigger?: number;
  /**
   * Member focus is controlled by the parent so the inline Members list
   * rendered alongside the cluster row in `ClustersTab` shares the same
   * focus state as the image triple / filmstrip here. `null` falls back
   * to the representative.
   */
  focusedMemberId: string | null;
  onMemberFocus: (id: string | null) => void;
  /**
   * Fires whenever the panel loads or refreshes the cluster detail DTO.
   * Parent uses this to feed `members` into `ClustersTab` (inline list).
   */
  onDataLoaded?: (data: ClusterDetailDto) => void;
  /**
   * Session-wide acceptances. The panel cross-references each member's
   * (url_pair_id, viewport_name) to surface partial-acceptance state in
   * the header and tag accepted members in the filmstrip + meta block.
   * Acceptances created from inside this panel ("Accept this member")
   * also reuse this prop, so the parent must refresh it via
   * `onMemberAcceptanceChanged` for the visuals to update.
   */
  acceptances?: AcceptanceRow[];
  /** Fires after a per-member accept/clear so the parent can re-fetch. */
  onMemberAcceptanceChanged?: () => void;
}

export function ClusterDetailPanel({
  sessionId,
  clusterId,
  onChanged,
  onClusterLoaded,
  openAcceptDialogTrigger,
  openRejectDialogTrigger,
  openSplitDialogTrigger,
  refreshTrigger,
  focusedMemberId,
  onMemberFocus,
  onDataLoaded,
  acceptances = [],
  onMemberAcceptanceChanged,
}: ClusterDetailPanelProps): JSX.Element {
  const [data, setData] = useState<ClusterDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'accept' | 'reject' | 'split' | 'accept-member' | 'reject-member' | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [fitMode, setFitMode] = useFitMode();
  // count=3 covers triple mode; ab mode uses only the first 2 refs. The
  // figure for the unused 3rd slot in ab mode simply unmounts and clears
  // its ref, so the sync handler skips it.
  const figureSync = useSyncedScroll(3);
  // View mode is URL-backed so refresh / share / back-forward keep the
  // selection. Replace-history on change (it's an in-place toggle, not a
  // navigation — flooding history with view-mode flips would be wrong).
  const [searchParams, setSearchParams] = useSearchParams();
  const viewModeParam = searchParams.get('view');
  const viewMode: 'triple' | 'ab' | 'slider' =
    viewModeParam === 'ab' || viewModeParam === 'slider' ? viewModeParam : 'triple';
  const setViewMode = useCallback((next: 'triple' | 'ab' | 'slider') => {
    const sp = new URLSearchParams(searchParams);
    if (next === 'triple') sp.delete('view'); // canonical default → clean URL
    else sp.set('view', next);
    setSearchParams(sp, { replace: true });
  }, [searchParams, setSearchParams]);
  const filmstripRef = useRef<HTMLDivElement>(null);

  // Callbacks are read via refs so the data-fetch effect doesn't re-run
  // every time a parent passes an unstable inline arrow (e.g.
  // `onClusterLoaded={(c) => setReviewState(c.review_state)}`). Without
  // this, each parent render would re-trigger the fetch and flash the
  // "Loading…" state.
  const onClusterLoadedRef = useRef(onClusterLoaded);
  const onDataLoadedRef = useRef(onDataLoaded);
  useEffect(() => { onClusterLoadedRef.current = onClusterLoaded; }, [onClusterLoaded]);
  useEffect(() => { onDataLoadedRef.current = onDataLoaded; }, [onDataLoaded]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api.getCluster(sessionId, clusterId, { limit: 500 })
      .then((dto) => {
        if (cancelled) return;
        setData(dto);
        onClusterLoadedRef.current?.(dto.cluster);
        onDataLoadedRef.current?.(dto);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [sessionId, clusterId, refreshTrigger]);

  // Phase γ: parent (typically ActionsMenu) can ask the panel to open
  // its accept/reject dialogs by incrementing a trigger counter. Each
  // counter change opens the dialog once. Same pattern ComparisonDetail
  // uses for its `a` keyboard shortcut.
  const lastAcceptTriggerRef = useRef(openAcceptDialogTrigger);
  useEffect(() => {
    if (openAcceptDialogTrigger === undefined) return;
    if (lastAcceptTriggerRef.current === openAcceptDialogTrigger) return;
    lastAcceptTriggerRef.current = openAcceptDialogTrigger;
    if (data && data.cluster.review_state !== 'accepted') setDialog('accept');
  }, [openAcceptDialogTrigger, data]);
  const lastRejectTriggerRef = useRef(openRejectDialogTrigger);
  useEffect(() => {
    if (openRejectDialogTrigger === undefined) return;
    if (lastRejectTriggerRef.current === openRejectDialogTrigger) return;
    lastRejectTriggerRef.current = openRejectDialogTrigger;
    if (data && data.cluster.review_state !== 'rejected' && data.cluster.review_state !== 'split') {
      setDialog('reject');
    }
  }, [openRejectDialogTrigger, data]);
  const lastSplitTriggerRef = useRef(openSplitDialogTrigger);
  useEffect(() => {
    if (openSplitDialogTrigger === undefined) return;
    if (lastSplitTriggerRef.current === openSplitDialogTrigger) return;
    lastSplitTriggerRef.current = openSplitDialogTrigger;
    if (data && data.cluster.review_state !== 'split' && data.members.length >= 2) {
      setDialog('split');
    }
  }, [openSplitDialogTrigger, data]);

  const handleAccept = async (input: { label: string; notes: string }): Promise<void> => {
    if (!data) return;
    setActionBusy(true);
    setError(null);
    try {
      const res = await api.acceptCluster(sessionId, clusterId, {
        label: input.label || undefined,
        notes: input.notes || undefined,
      });
      const next = { ...data, cluster: res.cluster };
      setData(next);
      onClusterLoadedRef.current?.(res.cluster);
      onDataLoadedRef.current?.(next);
      setDialog(null);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleReject = async (notes: string): Promise<void> => {
    if (!data) return;
    setActionBusy(true);
    setError(null);
    try {
      const res = await api.rejectCluster(sessionId, clusterId, {
        notes: notes || undefined,
      });
      const next = { ...data, cluster: res.cluster };
      setData(next);
      onClusterLoadedRef.current?.(res.cluster);
      onDataLoadedRef.current?.(next);
      setDialog(null);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const cluster = data?.cluster;
  const representative = data?.representative ?? null;
  // Representative-first ordering. The signature service returns members
  // in a stable order (mostly by url_pair_id); putting the representative
  // up front means filmstrip and stepper start there by default.
  const members: ClusterMemberDto[] = useMemo(() => {
    const raw = data?.members ?? [];
    const repId = representative?.difference_id;
    if (!repId) return raw;
    const rep = raw.find((m) => m.difference_id === repId);
    if (!rep) return raw;
    return [rep, ...raw.filter((m) => m.difference_id !== repId)];
  }, [data, representative]);

  // Pair stepper. `displayed` drives the whole image triple + metrics block;
  // j/k arrows step focus through `members`. With no explicit focus we show
  // the representative — which is itself usually a member.
  const repIndex = useMemo(() => {
    if (!representative) return -1;
    return members.findIndex((m) => m.difference_id === representative.difference_id);
  }, [members, representative]);

  const displayedIndex = useMemo(() => {
    if (focusedMemberId !== null) {
      const i = members.findIndex((m) => m.difference_id === focusedMemberId);
      if (i >= 0) return i;
    }
    return repIndex;
  }, [members, focusedMemberId, repIndex]);

  const displayed: ClusterMemberDto | null = displayedIndex >= 0
    ? (members[displayedIndex] ?? null)
    : representative;

  // Register this cluster's stale-and-in-flight members with the
  // dashboard provider so the server computes ETAs only for what's
  // visible here. Without this, the dashboard's capture_eta.members
  // would serialize entries for thousands of in-flight pairs the user
  // can't see — 100+ KB per tick on a big recapture. The effect runs
  // on every members change and clears on unmount.
  const dashboard = useReviewDashboard();
  useEffect(() => {
    if (!dashboard) return;
    const staleKeys = members
      .filter((m) => m.capture_a_status.is_stale || m.capture_b_status.is_stale)
      .map((m) => `${m.url_pair_id}::${m.viewport_name}`);
    dashboard.setEtaScope(staleKeys);
    return () => dashboard.setEtaScope([]);
  }, [members, dashboard]);

  // ETA map comes from the shared ReviewDashboardProvider — one poll
  // per session, distributed via context.
  const etaByKey = useReviewCaptureEta();
  const displayedEta = displayed
    ? etaByKey.get(`${displayed.url_pair_id}::${displayed.viewport_name}`)
    : undefined;

  // Per-member acceptance is just a row acceptance under the hood
  // (sessions.ts:553 POST /:id/acceptances). We index acceptances by
  // url_pair_id + viewport_name to surface state in the filmstrip,
  // meta block, and cluster header.
  const acceptanceByPairKey = useMemo(() => {
    const map = new Map<string, AcceptanceRow>();
    for (const a of acceptances) {
      map.set(`${a.url_pair_id}::${a.viewport_name}`, a);
    }
    return map;
  }, [acceptances]);

  // Two sets: accepted (✓) vs rejected (✗). Rejected members are tagged
  // acceptances under the hood (see REJECTED_LABEL_MARKER); we partition
  // here so the filmstrip + facets can distinguish them visually.
  const memberAcceptedSet = useMemo(() => {
    const s = new Set<string>();
    for (const m of members) {
      const a = acceptanceByPairKey.get(`${m.url_pair_id}::${m.viewport_name}`);
      if (a && !isRejectedAcceptance(a)) s.add(m.difference_id);
    }
    return s;
  }, [members, acceptanceByPairKey]);
  const memberRejectedSet = useMemo(() => {
    const s = new Set<string>();
    for (const m of members) {
      const a = acceptanceByPairKey.get(`${m.url_pair_id}::${m.viewport_name}`);
      if (a && isRejectedAcceptance(a)) s.add(m.difference_id);
    }
    return s;
  }, [members, acceptanceByPairKey]);

  const displayedAcceptance: AcceptanceRow | null = displayed
    ? acceptanceByPairKey.get(`${displayed.url_pair_id}::${displayed.viewport_name}`) ?? null
    : null;

  // Accept just the focused member. Different intent from "Accept
  // cluster": this writes a single row acceptance, doesn't create a
  // rule, and doesn't flip the cluster's review_state. Fetches the
  // comparison detail to pick up matched_at_level + bounding boxes
  // (ClusterMemberDto doesn't carry those).
  const handleAcceptMember = async (input: { label: string; notes: string; acceptAny: boolean }): Promise<void> => {
    if (!displayed) return;
    setActionBusy(true);
    setError(null);
    try {
      const detail = await api.getComparisonDetail(displayed.comparison_id);
      const matchedAtLevel = detail.comparison.matched_at_level;
      if (!matchedAtLevel) {
        throw new Error('Comparison has no matched level — cannot accept yet');
      }
      if (!displayed.capture_a_sha || !displayed.capture_b_sha) {
        throw new Error('Member is missing one of its capture shas — re-evaluate first');
      }
      const regions: BoundingBoxPercent[] = detail.differences
        .filter((d) => d.source === 'imagick' && d.bounding_box)
        .map((d) => d.bounding_box!);
      await api.createAcceptance(sessionId, {
        url_pair_id: displayed.url_pair_id,
        viewport_name: displayed.viewport_name,
        accepted_level: matchedAtLevel,
        accepted_pixel_pct: detail.comparison.changed_pixel_percentage,
        accepted_ssim: detail.comparison.ssim,
        accepted_diff_regions: regions,
        accepted_capture_a_sha: displayed.capture_a_sha,
        accepted_capture_b_sha: displayed.capture_b_sha,
        accept_any: input.acceptAny,
        label: input.label || null,
        notes: input.notes || null,
      });
      setDialog(null);
      onMemberAcceptanceChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  // Reject the focused member. The API has no row-level rejection
  // primitive — acceptance rows are the only per-pair persistence.
  // We write one with the `REJECTED_LABEL_MARKER` prefix so the UI can
  // surface the user's intent ("I looked at this and said no") with a
  // red pill. Caveat the dialog flags: technically the pair still
  // satisfies the acceptance check on next evaluation, since we're
  // riding the same primitive.
  const handleRejectMember = async (input: { notes: string }): Promise<void> => {
    if (!displayed) return;
    setActionBusy(true);
    setError(null);
    try {
      const detail = await api.getComparisonDetail(displayed.comparison_id);
      const matchedAtLevel = detail.comparison.matched_at_level;
      if (!matchedAtLevel) {
        throw new Error('Comparison has no matched level — cannot reject yet');
      }
      if (!displayed.capture_a_sha || !displayed.capture_b_sha) {
        throw new Error('Member is missing one of its capture shas — re-evaluate first');
      }
      const regions: BoundingBoxPercent[] = detail.differences
        .filter((d) => d.source === 'imagick' && d.bounding_box)
        .map((d) => d.bounding_box!);
      await api.createAcceptance(sessionId, {
        url_pair_id: displayed.url_pair_id,
        viewport_name: displayed.viewport_name,
        accepted_level: matchedAtLevel,
        accepted_pixel_pct: detail.comparison.changed_pixel_percentage,
        accepted_ssim: detail.comparison.ssim,
        accepted_diff_regions: regions,
        accepted_capture_a_sha: displayed.capture_a_sha,
        accepted_capture_b_sha: displayed.capture_b_sha,
        accept_any: false,
        label: REJECTED_LABEL_MARKER,
        notes: input.notes || null,
      });
      setDialog(null);
      onMemberAcceptanceChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleClearMemberAcceptance = async (): Promise<void> => {
    if (!displayedAcceptance) return;
    setActionBusy(true);
    setError(null);
    try {
      await api.deleteAcceptance(sessionId, displayedAcceptance.id);
      onMemberAcceptanceChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleSplit = async (memberDifferenceIds: string[]): Promise<void> => {
    setActionBusy(true);
    setError(null);
    try {
      await api.splitCluster(sessionId, clusterId, {
        member_difference_ids: memberDifferenceIds,
      });
      // Re-fetch the cluster's own detail so the filmstrip + member
      // list shed the extracted members. The new cluster shows up in
      // the parent's list via onChanged.
      const dto = await api.getCluster(sessionId, clusterId, { limit: 500 });
      setData(dto);
      onClusterLoadedRef.current?.(dto.cluster);
      onDataLoadedRef.current?.(dto);
      setDialog(null);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const stepBy = useCallback((delta: number) => {
    if (members.length === 0) return;
    const start = displayedIndex >= 0 ? displayedIndex : (delta > 0 ? -1 : members.length);
    const next = Math.min(members.length - 1, Math.max(0, start + delta));
    onMemberFocus(members[next]!.difference_id);
  }, [members, displayedIndex, onMemberFocus]);

  // j / k / arrows step through members; Escape clears focus (back to rep).
  // Skip while a dialog is open or the user is typing.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (dialog) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (target.isContentEditable) return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        stepBy(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        stepBy(-1);
      } else if (e.key === 'Escape' && focusedMemberId !== null) {
        e.preventDefault();
        onMemberFocus(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [stepBy, dialog, focusedMemberId, onMemberFocus]);

  // Auto-scroll the filmstrip horizontally so the active thumb stays in view.
  useEffect(() => {
    if (!displayed) return;
    const el = filmstripRef.current?.querySelector<HTMLElement>(
      `[data-thumb-id="${displayed.difference_id}"]`,
    );
    el?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [displayed]);

  if (error) return <div className="error">{error}</div>;
  if (!data || !cluster) return <p>Loading…</p>;

  const displayedBbox = displayed?.bounding_box ?? null;
  const displayedDescription = displayed?.description ?? '';
  const isRepDisplayed = displayed?.difference_id === representative?.difference_id;
  // Synthetic outcome-bucket clusters (Missing on A/B, Capture failed) are
  // read-only here — accept/reject lives at the row level. Visual diff
  // also doesn't exist for these (the comparison short-circuited), so the
  // image triple's diff panel just renders "no diff". A/B panels still
  // work since the captures themselves succeeded for the missing-page
  // case (one side just rendered as a 404).
  const isSyntheticOutcome = cluster.signature_version === 'outcome';

  return (
    <>
      {dialog === 'accept' && (
        <AcceptDialog
          cluster={cluster}
          members={members}
          busy={actionBusy}
          onConfirm={handleAccept}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === 'reject' && (
        <RejectDialog
          cluster={cluster}
          busy={actionBusy}
          onConfirm={handleReject}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === 'split' && (
        <SplitDialog
          cluster={cluster}
          members={members}
          representativeId={representative?.difference_id ?? null}
          busy={actionBusy}
          onConfirm={handleSplit}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === 'accept-member' && displayed && (
        <MemberAcceptDialog
          member={displayed}
          isRepresentative={displayed.difference_id === representative?.difference_id}
          busy={actionBusy}
          onConfirm={handleAcceptMember}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === 'reject-member' && displayed && (
        <MemberRejectDialog
          member={displayed}
          busy={actionBusy}
          onConfirm={handleRejectMember}
          onCancel={() => setDialog(null)}
        />
      )}

      {displayed ? (
        <section className="cluster-detail__sample">
          {members.length > 1 && (
            <Filmstrip
              members={members}
              activeId={displayed.difference_id}
              representativeId={representative?.difference_id ?? null}
              acceptedSet={memberAcceptedSet}
              rejectedSet={memberRejectedSet}
              onSelect={onMemberFocus}
              stripRef={filmstripRef}
            />
          )}

          <div className="cluster-detail__toolbar">
            <div className="cluster-detail__view-toggle" role="tablist" aria-label="Image view mode">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'triple'}
                className={`view-toggle__btn${viewMode === 'triple' ? ' view-toggle__btn--active' : ''}`}
                onClick={() => setViewMode('triple')}
                title="Side-by-side A / B / diff"
              >
                A | B | diff
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'ab'}
                className={`view-toggle__btn${viewMode === 'ab' ? ' view-toggle__btn--active' : ''}`}
                onClick={() => setViewMode('ab')}
                title="Side-by-side A and B without the diff overlay"
              >
                A | B
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'slider'}
                className={`view-toggle__btn${viewMode === 'slider' ? ' view-toggle__btn--active' : ''}`}
                onClick={() => setViewMode('slider')}
                title="Drag the handle to wipe between A and B"
              >
                A/B slider
              </button>
            </div>
            <FitModeToggle mode={fitMode} onChange={setFitMode} />
          </div>

          <div className="cluster-detail__sample-meta">
            {/* Single-line summary: member counter · URL · per-member actions.
                j/k step-hint and back-to-rep are tooltips/icons, not their own
                rows. LM summary / metrics / description still stack below
                (they belong to the focused diff, not the cluster). */}
            <div className="cluster-detail__sample-line">
              <span
                className="cluster-detail__member-counter"
                title="Step pairs with j/k or ↑/↓"
              >
                {isRepDisplayed
                  ? `★ rep · 1/${members.length}`
                  : `${displayedIndex + 1}/${members.length}`}
              </span>
              {!isRepDisplayed && (
                <button
                  type="button"
                  className="cluster-detail__back-to-rep"
                  onClick={() => onMemberFocus(null)}
                  title="Back to the representative pair (Esc)"
                  aria-label="Back to representative"
                >
                  ↶
                </button>
              )}
              <Link
                to={`/sessions/${sessionId}/comparisons/${displayed.comparison_id}`}
                className="cluster-detail__sample-url"
              >
                {displayed.url_a}
              </Link>
              <div className="cluster-detail__member-actions">
                {displayedAcceptance ? (
                  <span className="cluster-detail__member-state-group">
                    {isRejectedAcceptance(displayedAcceptance) ? (
                      <span className="cluster-detail__member-state cluster-detail__member-state--rejected">
                        ✗ rejected
                      </span>
                    ) : (
                      <span className="cluster-detail__member-state">✓ accepted</span>
                    )}
                    <button
                      type="button"
                      className="cluster-detail__member-clear"
                      onClick={() => void handleClearMemberAcceptance()}
                      disabled={actionBusy}
                      title={
                        isRejectedAcceptance(displayedAcceptance)
                          ? "Remove this member's rejection."
                          : "Remove this member's acceptance row. Doesn't touch other members or any cluster rule."
                      }
                      aria-label="Clear member state"
                    >
                      ⊗
                    </button>
                  </span>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn btn-compact secondary"
                      onClick={() => setDialog('accept-member')}
                      disabled={actionBusy || cluster.review_state === 'accepted' || isSyntheticOutcome}
                      title={
                        isSyntheticOutcome
                          ? 'Missing / capture-failed pairs have no comparison verdict to accept — fix the underlying capture, then accept from the Rows view.'
                          : cluster.review_state === 'accepted'
                            ? 'Cluster is already accepted — the rule covers this member'
                            : 'Accept only this member. Doesn’t create a cluster rule or change cluster state.'
                      }
                    >
                      Accept member…
                    </button>
                    <button
                      type="button"
                      className="btn btn-compact secondary"
                      onClick={() => setDialog('reject-member')}
                      disabled={actionBusy || isSyntheticOutcome}
                      title={
                        isSyntheticOutcome
                          ? 'Missing / capture-failed pairs are read-only — accept/reject these rows from the Rows view.'
                          : "Record this member as reviewed-and-rejected. Note: ride-shares the acceptance primitive — see dialog for the caveat."
                      }
                    >
                      Reject…
                    </button>
                  </>
                )}
                <RecapturePairButton
                  sessionId={sessionId}
                  pairId={displayed.url_pair_id}
                  compact
                />
              </div>
            </div>
            {displayed.lm_summary && (
              <p className="cluster-detail__lm-summary">
                <em>{displayed.lm_summary}</em>
              </p>
            )}
            <p className="cluster-detail__metrics">
              {displayed.lm_confidence != null && (
                <span>confidence: {displayed.lm_confidence.toFixed(2)}</span>
              )}
              {displayed.severity && <span>severity: {displayed.severity}</span>}
              {displayed.ssim != null && <span>ssim: {displayed.ssim.toFixed(3)}</span>}
              {displayed.changed_pct != null && (
                <span>changed: {displayed.changed_pct.toFixed(2)}%</span>
              )}
            </p>
            {displayedDescription && (
              <p className="cluster-detail__description">{displayedDescription}</p>
            )}
          </div>

          <div className={`cluster-detail__images cluster-detail__images--${viewMode} fit-${fitMode}`}>
            {viewMode === 'triple' && (
              <ImageTriple member={displayed} bbox={displayedBbox} sync={figureSync} etaMs={displayedEta?.eta_ms} />
            )}
            {viewMode === 'ab' && (
              <ImageAB member={displayed} bbox={displayedBbox} sync={figureSync} etaMs={displayedEta?.eta_ms} />
            )}
            {viewMode === 'slider' && (
              <ImageSlider member={displayed} bbox={displayedBbox} etaMs={displayedEta?.eta_ms} />
            )}
          </div>
        </section>
      ) : (
        <p>No representative diff available for this cluster.</p>
      )}
    </>
  );
}

/**
 * Filmstrip of diff thumbnails — one per cluster member. The eye is good at
 * catching the one that doesn't belong; this strip is the cheapest way to
 * surface that. Active thumb scrolls into view via the ref in the parent.
 */
function Filmstrip({
  members,
  activeId,
  representativeId,
  acceptedSet,
  rejectedSet,
  onSelect,
  stripRef,
}: {
  members: ClusterMemberDto[];
  activeId: string;
  representativeId: string | null;
  acceptedSet: Set<string>;
  rejectedSet: Set<string>;
  onSelect: (id: string) => void;
  stripRef: RefObject<HTMLDivElement>;
}): JSX.Element {
  return (
    <div className="cluster-detail__filmstrip" ref={stripRef}>
      {members.map((m, i) => {
        const diff = imageUrl(m.im_diff_sha);
        const fallback = imageUrl(m.capture_a_sha);
        const src = diff ?? fallback;
        const active = m.difference_id === activeId;
        const isRep = m.difference_id === representativeId;
        const isAccepted = acceptedSet.has(m.difference_id);
        const isRejected = rejectedSet.has(m.difference_id);
        const stateSuffix = isAccepted ? ' (accepted)' : isRejected ? ' (rejected)' : '';
        const stateClass = isAccepted
          ? ' filmstrip-thumb--accepted'
          : isRejected
            ? ' filmstrip-thumb--rejected'
            : '';
        return (
          <button
            key={m.difference_id}
            type="button"
            data-thumb-id={m.difference_id}
            className={`filmstrip-thumb${active ? ' filmstrip-thumb--active' : ''}${isRep ? ' filmstrip-thumb--representative' : ''}${stateClass}`}
            onClick={() => onSelect(m.difference_id)}
            title={
              isRep
                ? `Representative · ${m.url_a}${stateSuffix}`
                : `${i + 1}. ${m.url_a}${stateSuffix}`
            }
            aria-pressed={active}
          >
            {src ? (
              <img src={src} alt="" loading="lazy" />
            ) : (
              <span className="filmstrip-thumb__missing">—</span>
            )}
            <span className="filmstrip-thumb__index">{isRep ? '★' : i + 1}</span>
            {isAccepted && <span className="filmstrip-thumb__accepted" aria-label="accepted">✓</span>}
            {isRejected && <span className="filmstrip-thumb__rejected" aria-label="rejected">✗</span>}
          </button>
        );
      })}
    </div>
  );
}

function ImageTriple({
  member,
  bbox,
  sync,
  etaMs,
}: {
  member: ClusterMemberDto;
  bbox: { x: number; y: number; width: number; height: number } | null;
  sync: SyncedScroll;
  etaMs?: number;
}): JSX.Element {
  const aUrl = imageUrl(member.capture_a_sha);
  const bUrl = imageUrl(member.capture_b_sha);
  const diffUrl = imageUrl(member.im_diff_sha);
  const boxes = bbox ? [bbox] : [];
  return (
    <>
      <figure ref={sync.refs[0]} onScroll={sync.onScroll}>
        <figcaption>A<StaleBadge status={member.capture_a_status} etaMs={etaMs} /></figcaption>
        {aUrl ? <ImageWithBoxes src={aUrl} alt="capture A" boxes={boxes} /> : <span className="missing-img">no image</span>}
      </figure>
      <figure ref={sync.refs[1]} onScroll={sync.onScroll}>
        <figcaption>B<StaleBadge status={member.capture_b_status} etaMs={etaMs} /></figcaption>
        {bUrl ? <ImageWithBoxes src={bUrl} alt="capture B" boxes={boxes} /> : <span className="missing-img">no image</span>}
      </figure>
      <figure ref={sync.refs[2]} onScroll={sync.onScroll}>
        <figcaption>diff</figcaption>
        {diffUrl ? <ImageWithBoxes src={diffUrl} alt="pixel diff" boxes={boxes} /> : <span className="missing-img">no diff</span>}
      </figure>
    </>
  );
}

/**
 * A | B — side-by-side without the diff overlay. Useful when the diff
 * is noisy (anti-aliasing, small displacements) but the layout
 * difference between A and B is obvious to the eye.
 */
function ImageAB({
  member,
  bbox,
  sync,
  etaMs,
}: {
  member: ClusterMemberDto;
  bbox: { x: number; y: number; width: number; height: number } | null;
  sync: SyncedScroll;
  etaMs?: number;
}): JSX.Element {
  const aUrl = imageUrl(member.capture_a_sha);
  const bUrl = imageUrl(member.capture_b_sha);
  const boxes = bbox ? [bbox] : [];
  return (
    <>
      <figure ref={sync.refs[0]} onScroll={sync.onScroll}>
        <figcaption>A<StaleBadge status={member.capture_a_status} etaMs={etaMs} /></figcaption>
        {aUrl ? <ImageWithBoxes src={aUrl} alt="capture A" boxes={boxes} /> : <span className="missing-img">no image</span>}
      </figure>
      <figure ref={sync.refs[1]} onScroll={sync.onScroll}>
        <figcaption>B<StaleBadge status={member.capture_b_status} etaMs={etaMs} /></figcaption>
        {bUrl ? <ImageWithBoxes src={bUrl} alt="capture B" boxes={boxes} /> : <span className="missing-img">no image</span>}
      </figure>
    </>
  );
}

/**
 * Wipe-style A/B compare. A is the base image; B is layered above, clipped
 * to the right of a draggable handle. The user drags the handle (or clicks
 * anywhere in the image area) to set the wipe position. Bbox sits on top so
 * it stays visible whichever half is showing.
 */
function ImageSlider({
  member,
  bbox,
  etaMs,
}: {
  member: ClusterMemberDto;
  bbox: { x: number; y: number; width: number; height: number } | null;
  etaMs?: number;
}): JSX.Element {
  const aUrl = imageUrl(member.capture_a_sha);
  const bUrl = imageUrl(member.capture_b_sha);
  const [pct, setPct] = useState(50);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Reset to the middle whenever the pair changes — keeps the comparison
  // baseline predictable per pair.
  useEffect(() => { setPct(50); }, [member.difference_id]);

  if (!aUrl || !bUrl) {
    return (
      <div className="image-slider image-slider--missing">
        <span className="missing-img">{aUrl ? 'B missing' : 'A missing'}</span>
      </div>
    );
  }

  const updateFromEvent = (clientX: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, clientX - rect.left));
    setPct((x / rect.width) * 100);
  };

  return (
    <div
      ref={wrapRef}
      className="image-slider"
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        updateFromEvent(e.clientX);
      }}
      onPointerMove={(e) => {
        // Only update while the primary button is held.
        if (e.buttons === 0) return;
        updateFromEvent(e.clientX);
      }}
    >
      <img className="image-slider__base" src={aUrl} alt="capture A" />
      <div
        className="image-slider__overlay"
        style={{ clipPath: `inset(0 0 0 ${pct}%)` }}
      >
        <img src={bUrl} alt="capture B" />
      </div>
      {bbox && (
        <div
          className="bbox"
          style={{
            left: `${bbox.x}%`,
            top: `${bbox.y}%`,
            width: `${bbox.width}%`,
            height: `${bbox.height}%`,
          }}
        />
      )}
      <div className="image-slider__handle" style={{ left: `${pct}%` }}>
        <div className="image-slider__bar" />
        <div className="image-slider__grip">⇆</div>
      </div>
      <div className="image-slider__label image-slider__label--a">
        A<StaleBadge status={member.capture_a_status} etaMs={etaMs} />
      </div>
      <div className="image-slider__label image-slider__label--b">
        B<StaleBadge status={member.capture_b_status} etaMs={etaMs} />
      </div>
    </div>
  );
}

/**
 * Friction step for cluster accept. Shows a sample of member URLs so the
 * reviewer can scan for "wait, that one shouldn't be here" cases before
 * committing the fan-out across N pairs.
 */
function AcceptDialog({
  cluster,
  members,
  busy,
  onConfirm,
  onCancel,
}: {
  cluster: DifferenceClusterRow;
  members: ClusterMemberDto[];
  busy: boolean;
  onConfirm: (input: { label: string; notes: string }) => void;
  onCancel: () => void;
}): JSX.Element {
  const [label, setLabel] = useState<string>(cluster.element_label ?? '');
  const [notes, setNotes] = useState<string>('');
  const samples = useMemo(() => sampleMembers(members, 5), [members]);
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">Accept cluster across {cluster.pair_count} pair{cluster.pair_count === 1 ? '' : 's'}?</h3>
        <p className="dialog__intro">
          This will create or update an acceptance for every (pair, viewport)
          this cluster touches. Manually-created acceptances are preserved.
        </p>
        <div className="dialog__samples">
          <p className="dialog__samples-label">
            Sample {samples.length} of {cluster.pair_count}:
          </p>
          <ul className="dialog__samples-list">
            {samples.map((m) => (
              <li key={m.difference_id}>
                <code>{m.url_a}</code>
              </li>
            ))}
          </ul>
        </div>
        <label className="dialog__field">
          <span>Label (optional)</span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={cluster.element_label ?? 'short label for this acceptance'}
            disabled={busy}
            maxLength={120}
          />
        </label>
        <label className="dialog__field">
          <span>Notes (optional)</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="why this change is acceptable; what to look for next time"
            disabled={busy}
            rows={3}
            maxLength={2000}
          />
        </label>
        <div className="dialog__actions">
          <button type="button" className="btn secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="btn"
            onClick={() => onConfirm({ label, notes })}
            disabled={busy}
          >
            {busy ? 'Accepting…' : `Accept ${cluster.pair_count} pair${cluster.pair_count === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function RejectDialog({
  cluster,
  busy,
  onConfirm,
  onCancel,
}: {
  cluster: DifferenceClusterRow;
  busy: boolean;
  onConfirm: (notes: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [notes, setNotes] = useState<string>('');
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">Reject cluster?</h3>
        <p className="dialog__intro">
          This will delete every acceptance that <em>this rule</em> created
          (manually-set acceptances are preserved). The cluster moves to
          "rejected" state.
        </p>
        <label className="dialog__field">
          <span>Notes (optional)</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="why you're rolling this back"
            disabled={busy}
            rows={3}
            maxLength={2000}
          />
        </label>
        <div className="dialog__actions">
          <button type="button" className="btn secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="btn" onClick={() => onConfirm(notes)} disabled={busy}>
            {busy ? 'Rejecting…' : 'Reject cluster'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Per-member accept dialog. Mirrors the row-acceptance flow's label /
 * notes / accept-any fields so the experience is consistent whether
 * you're accepting from Rows mode or from a focused cluster member.
 * Different from `AcceptDialog` (which fans across the whole cluster
 * via the acceptance_rules path) — this writes a single acceptance
 * row keyed by (url_pair_id, viewport_name).
 */
function MemberAcceptDialog({
  member,
  isRepresentative,
  busy,
  onConfirm,
  onCancel,
}: {
  member: ClusterMemberDto;
  isRepresentative: boolean;
  busy: boolean;
  onConfirm: (input: { label: string; notes: string; acceptAny: boolean }) => void;
  onCancel: () => void;
}): JSX.Element {
  const [label, setLabel] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [acceptAny, setAcceptAny] = useState<boolean>(false);
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">
          Accept {isRepresentative ? 'representative member' : 'this member'}?
        </h3>
        <p className="dialog__intro">
          Records a per-pair acceptance for{' '}
          <code>{member.url_a}</code> at viewport <code>{member.viewport_name}</code>.
          This is independent of the cluster-wide rule — accepting here
          doesn't change the cluster's review state or affect other members.
        </p>
        <label className="dialog__field">
          <span>Label (optional)</span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="short label for this acceptance"
            disabled={busy}
            maxLength={120}
          />
        </label>
        <label className="dialog__field">
          <span>Notes (optional)</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="why this change is acceptable on this specific pair"
            disabled={busy}
            rows={3}
            maxLength={2000}
          />
        </label>
        <label className="dialog__field dialog__field--checkbox">
          <input
            type="checkbox"
            checked={acceptAny}
            onChange={(e) => setAcceptAny(e.target.checked)}
            disabled={busy}
          />
          <span>
            Accept any future diff on this pair
            <span className="muted"> (accept_any — skip future verdicts entirely)</span>
          </span>
        </label>
        <div className="dialog__actions">
          <button type="button" className="btn secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => onConfirm({ label, notes, acceptAny })}
            disabled={busy}
          >
            {busy ? 'Accepting…' : 'Accept this member'}
          </button>
        </div>
      </div>
    </div>
  );
}

function sampleMembers(members: ClusterMemberDto[], n: number): ClusterMemberDto[] {
  if (members.length <= n) return members;
  // Stable sample of the first n. Random would be possible too but stable
  // matches what the user already saw scrolling the member list.
  return members.slice(0, n);
}

/**
 * Per-member reject dialog. Captures a reason in notes and writes an
 * acceptance row tagged with REJECTED_LABEL_MARKER so the UI can show a
 * red pill on subsequent loads. Carries an explicit caveat in the intro
 * because the underlying primitive is the acceptance table: the row
 * technically still satisfies acceptance on next evaluation — until a
 * real row-level reject API exists, this is the closest we have to
 * "I considered this and said no" persistence.
 */
function MemberRejectDialog({
  member,
  busy,
  onConfirm,
  onCancel,
}: {
  member: ClusterMemberDto;
  busy: boolean;
  onConfirm: (input: { notes: string }) => void;
  onCancel: () => void;
}): JSX.Element {
  const [notes, setNotes] = useState<string>('');
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">Reject this member?</h3>
        <p className="dialog__intro">
          Records your rejection of <code>{member.url_a}</code> at viewport{' '}
          <code>{member.viewport_name}</code>. The cluster's review state
          is untouched.
        </p>
        <p className="dialog__intro dialog__intro--caveat">
          <strong>Caveat:</strong> the API has no row-level reject primitive
          yet, so this rides on the acceptance table. The pair will still
          satisfy the acceptance check on the next evaluation — the row
          captures your <em>intent</em>, not a blocking signal. Clear with
          the ⊗ icon any time.
        </p>
        <label className="dialog__field">
          <span>Reason (optional)</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="why this change is NOT acceptable on this pair"
            disabled={busy}
            rows={3}
            maxLength={2000}
          />
        </label>
        <div className="dialog__actions">
          <button type="button" className="btn secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => onConfirm({ notes })}
            disabled={busy}
          >
            {busy ? 'Rejecting…' : 'Reject this member'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Multi-select dialog for splitting members off into a new cluster. The
 * representative is locked into the "keep in source" half — the source
 * cluster keeps its identity. The user checks each member to extract;
 * the new cluster takes the selected set. Must leave at least one in
 * each half (the API rejects otherwise).
 */
function SplitDialog({
  cluster,
  members,
  representativeId,
  busy,
  onConfirm,
  onCancel,
}: {
  cluster: DifferenceClusterRow;
  members: ClusterMemberDto[];
  representativeId: string | null;
  busy: boolean;
  onConfirm: (memberDifferenceIds: string[]) => void;
  onCancel: () => void;
}): JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The representative is forced to stay in the source cluster, so it
  // never appears in the selectable set. (Splitting the representative
  // off would imply the new cluster takes over the original identity —
  // confusing semantics; punt.)
  const selectable = useMemo(
    () => members.filter((m) => m.difference_id !== representativeId),
    [members, representativeId],
  );
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const canConfirm =
    selected.size > 0 && selected.size < members.length && !busy;
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog dialog--wide" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog__title">Split cluster</h3>
        <p className="dialog__intro">
          Pick members to move into a new cluster. The remaining members
          stay in the current cluster (signature{' '}
          <code>{cluster.signature.slice(0, 12)}…</code>). The new cluster
          gets a synthetic signature derived from this one. Splits don't
          survive a full re-evaluation.
        </p>
        <p className="dialog__samples-label">
          {selected.size} of {selectable.length} selectable members chosen
          {representativeId && ' (representative is locked into the source)'}.
        </p>
        <ul className="split-dialog__list">
          {members.map((m) => {
            const isRep = m.difference_id === representativeId;
            const checked = selected.has(m.difference_id);
            return (
              <li
                key={m.difference_id}
                className={`split-dialog__row${isRep ? ' split-dialog__row--rep' : ''}`}
              >
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy || isRep}
                    onChange={() => toggle(m.difference_id)}
                  />
                  <span className="split-dialog__url">{m.url_a}</span>
                  <span className="split-dialog__vp">{m.viewport_name}</span>
                  {isRep && <span className="split-dialog__rep-tag">representative</span>}
                </label>
              </li>
            );
          })}
        </ul>
        <div className="dialog__actions">
          <button type="button" className="btn secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => onConfirm([...selected])}
            disabled={!canConfirm}
            title={
              selected.size === 0
                ? 'Pick at least one member to split off'
                : selected.size >= members.length
                  ? 'Cannot extract every member — leave at least one in the source'
                  : undefined
            }
          >
            {busy
              ? 'Splitting…'
              : `Split off ${selected.size} member${selected.size === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
