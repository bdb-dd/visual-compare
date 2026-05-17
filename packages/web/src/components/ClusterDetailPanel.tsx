import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { ImageWithBoxes } from './ImageWithBoxes.js';
import type {
  ClusterDetailDto,
  ClusterMemberDto,
  DifferenceClusterRow,
} from '@visual-compare/api/types';

/**
 * Cluster detail body — Accept / Reject wired into acceptance_rules
 * fan-out. Extracted from `pages/ClusterDetailPage.tsx` in Phase α so
 * the same content can render in `SessionDetailPage`'s detail pane in
 * Phase γ without leaving the unified surface.
 *
 * State flow:
 *   open      → Accept enabled, Reject enabled
 *   anomaly   → Accept enabled, Reject enabled
 *   accepted  → Accept disabled, Reject enabled (revokes the rule)
 *   rejected  → Accept enabled (re-accept), Reject disabled
 *   split     → Accept disabled, Reject disabled (terminal)
 *
 * The page shell owns the back-link; this panel handles its own
 * loading/error/data states without one.
 */

function imageUrl(sha: string | null | undefined): string | null {
  if (!sha || !/^[0-9a-f]{64}$/.test(sha)) return null;
  return `/images/sha256/${sha.slice(0, 2)}/${sha}.png`;
}

type ActionBanner =
  | { kind: 'accepted'; pairsCreated: number; pairsPreserved: number }
  | { kind: 'rejected'; revoked: number };

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
}

export function ClusterDetailPanel({
  sessionId,
  clusterId,
  onChanged,
  onClusterLoaded,
  openAcceptDialogTrigger,
  openRejectDialogTrigger,
  refreshTrigger,
  focusedMemberId,
  onMemberFocus,
  onDataLoaded,
}: ClusterDetailPanelProps): JSX.Element {
  const [data, setData] = useState<ClusterDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'accept' | 'reject' | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [banner, setBanner] = useState<ActionBanner | null>(null);
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
    setBanner(null);
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
      setBanner({ kind: 'accepted', pairsCreated: res.acceptances_created, pairsPreserved: res.acceptances_preserved });
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
      setBanner({ kind: 'rejected', revoked: res.acceptances_revoked });
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

  return (
    <>
      <header className="cluster-detail__header">
        <div>
          <h2 className="cluster-detail__title">
            {cluster.element_label ?? '(unlabelled)'}
            <span className="cluster-detail__sep">·</span>
            <span className="cluster-detail__change-type">{cluster.change_type ?? '—'}</span>
          </h2>
          <p className="cluster-detail__facets">
            <span className="facet">region: {cluster.region_role ?? '—'}</span>
            <span className="facet">viewport: {cluster.viewport_name ?? '—'}</span>
            <span className="facet">signature: {cluster.signature_version}</span>
            <span className="facet">members: {cluster.member_count}</span>
            <span className="facet">pairs: {cluster.pair_count}</span>
            <span className={`facet facet--state facet--state-${cluster.review_state}`}>
              {cluster.review_state}
            </span>
          </p>
        </div>
        <div className="cluster-detail__actions">
          <button
            type="button"
            className="btn"
            onClick={() => setDialog('accept')}
            disabled={cluster.review_state === 'accepted' || actionBusy}
            title={cluster.review_state === 'accepted' ? 'Already accepted — reject first to re-accept' : 'Accept this cluster: snapshot every member pair as accepted'}
          >
            Accept cluster
          </button>
          <button
            type="button"
            className="btn secondary"
            onClick={() => setDialog('reject')}
            disabled={
              cluster.review_state === 'rejected' ||
              cluster.review_state === 'split' ||
              actionBusy
            }
            title={
              cluster.review_state === 'rejected'
                ? 'Already rejected'
                : cluster.review_state === 'split'
                  ? 'Split clusters cannot be rejected'
                  : cluster.review_state === 'accepted'
                    ? 'Reject this cluster: delete its rule-owned acceptances and flip state to rejected'
                    : 'Reject this cluster'
            }
          >
            Reject
          </button>
          <button type="button" disabled title="Coming in a later phase">Split cluster</button>
        </div>
      </header>

      {banner && (
        <div className={`cluster-detail__banner cluster-detail__banner--${banner.kind}`}>
          {banner.kind === 'accepted'
            ? `✓ Cluster accepted — ${banner.pairsCreated} acceptance${banner.pairsCreated === 1 ? '' : 's'} created${banner.pairsPreserved > 0 ? ` (${banner.pairsPreserved} pre-existing preserved)` : ''}.`
            : `✓ Cluster rejected — ${banner.revoked} rule-owned acceptance${banner.revoked === 1 ? '' : 's'} revoked.`}
        </div>
      )}

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

      {displayed ? (
        <section className="cluster-detail__sample">
          {members.length > 1 && (
            <Filmstrip
              members={members}
              activeId={displayed.difference_id}
              representativeId={representative?.difference_id ?? null}
              onSelect={onMemberFocus}
              stripRef={filmstripRef}
            />
          )}

          <div className="cluster-detail__sample-meta">
            <div>
              <strong>{isRepDisplayed ? 'Representative member:' : `Member ${displayedIndex + 1} of ${members.length}:`}</strong>{' '}
              <Link to={`/sessions/${sessionId}/comparisons/${displayed.comparison_id}`}>
                {displayed.url_a}
              </Link>
              {!isRepDisplayed && (
                <button
                  type="button"
                  className="cluster-detail__back-to-rep"
                  onClick={() => onMemberFocus(null)}
                  title="Back to the representative pair (Esc)"
                >
                  back to representative
                </button>
              )}
              <span className="cluster-detail__step-hint" title="Step through pairs">j/k or ↑/↓</span>
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
            <p className="cluster-detail__description">{displayedDescription}</p>
          </div>

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

          <div className={`cluster-detail__images cluster-detail__images--${viewMode}`}>
            {viewMode === 'triple' && <ImageTriple member={displayed} bbox={displayedBbox} />}
            {viewMode === 'ab' && <ImageAB member={displayed} bbox={displayedBbox} />}
            {viewMode === 'slider' && <ImageSlider member={displayed} bbox={displayedBbox} />}
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
  onSelect,
  stripRef,
}: {
  members: ClusterMemberDto[];
  activeId: string;
  representativeId: string | null;
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
        return (
          <button
            key={m.difference_id}
            type="button"
            data-thumb-id={m.difference_id}
            className={`filmstrip-thumb${active ? ' filmstrip-thumb--active' : ''}${isRep ? ' filmstrip-thumb--representative' : ''}`}
            onClick={() => onSelect(m.difference_id)}
            title={isRep ? `Representative · ${m.url_a}` : `${i + 1}. ${m.url_a}`}
            aria-pressed={active}
          >
            {src ? (
              <img src={src} alt="" loading="lazy" />
            ) : (
              <span className="filmstrip-thumb__missing">—</span>
            )}
            <span className="filmstrip-thumb__index">{isRep ? '★' : i + 1}</span>
          </button>
        );
      })}
    </div>
  );
}

function ImageTriple({
  member,
  bbox,
}: {
  member: ClusterMemberDto;
  bbox: { x: number; y: number; width: number; height: number } | null;
}): JSX.Element {
  const aUrl = imageUrl(member.capture_a_sha);
  const bUrl = imageUrl(member.capture_b_sha);
  const diffUrl = imageUrl(member.im_diff_sha);
  const boxes = bbox ? [bbox] : [];
  return (
    <>
      <figure>
        <figcaption>A</figcaption>
        {aUrl ? <ImageWithBoxes src={aUrl} alt="capture A" boxes={boxes} /> : <span className="missing-img">no image</span>}
      </figure>
      <figure>
        <figcaption>B</figcaption>
        {bUrl ? <ImageWithBoxes src={bUrl} alt="capture B" boxes={boxes} /> : <span className="missing-img">no image</span>}
      </figure>
      <figure>
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
}: {
  member: ClusterMemberDto;
  bbox: { x: number; y: number; width: number; height: number } | null;
}): JSX.Element {
  const aUrl = imageUrl(member.capture_a_sha);
  const bUrl = imageUrl(member.capture_b_sha);
  const boxes = bbox ? [bbox] : [];
  return (
    <>
      <figure>
        <figcaption>A</figcaption>
        {aUrl ? <ImageWithBoxes src={aUrl} alt="capture A" boxes={boxes} /> : <span className="missing-img">no image</span>}
      </figure>
      <figure>
        <figcaption>B</figcaption>
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
}: {
  member: ClusterMemberDto;
  bbox: { x: number; y: number; width: number; height: number } | null;
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
      <div className="image-slider__label image-slider__label--a">A</div>
      <div className="image-slider__label image-slider__label--b">B</div>
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

function sampleMembers(members: ClusterMemberDto[], n: number): ClusterMemberDto[] {
  if (members.length <= n) return members;
  // Stable sample of the first n. Random would be possible too but stable
  // matches what the user already saw scrolling the member list.
  return members.slice(0, n);
}
