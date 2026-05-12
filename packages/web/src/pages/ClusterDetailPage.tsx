import { useEffect, useMemo, useState, type JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { ImageWithBoxes } from '../components/ImageWithBoxes.js';
import { RecapturePairButton } from '../components/RecapturePairButton.js';
import type {
  ClusterDetailDto,
  ClusterMemberDto,
  ClusterRepresentativeDto,
  DifferenceClusterRow,
} from '@visual-compare/api/types';

/**
 * Phase D cluster detail — Accept / Reject wired into acceptance_rules
 * fan-out. Accept opens a confirm dialog showing N sample members + a
 * label/notes input so the reviewer sees what they're committing to. Reject
 * is a simpler confirm with optional notes. Split is still deferred to a
 * later phase.
 *
 * State flow:
 *   open      → Accept enabled, Reject disabled
 *   accepted  → Accept disabled, Reject enabled
 *   rejected  → Accept enabled (re-accept), Reject disabled
 */

function imageUrl(sha: string | null | undefined): string | null {
  if (!sha || !/^[0-9a-f]{64}$/.test(sha)) return null;
  return `/images/sha256/${sha.slice(0, 2)}/${sha}.png`;
}

type ActionBanner =
  | { kind: 'accepted'; pairsCreated: number; pairsPreserved: number }
  | { kind: 'rejected'; revoked: number };

export function ClusterDetailPage(): JSX.Element {
  const { id = '', cluster_id = '' } = useParams();
  const [data, setData] = useState<ClusterDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusedMember, setFocusedMember] = useState<ClusterMemberDto | null>(null);
  const [dialog, setDialog] = useState<'accept' | 'reject' | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [banner, setBanner] = useState<ActionBanner | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setBanner(null);
    api.getCluster(id, cluster_id, { limit: 500 })
      .then((dto) => { if (!cancelled) setData(dto); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [id, cluster_id]);

  const handleAccept = async (input: { label: string; notes: string }): Promise<void> => {
    if (!data) return;
    setActionBusy(true);
    setError(null);
    try {
      const res = await api.acceptCluster(id, cluster_id, {
        label: input.label || undefined,
        notes: input.notes || undefined,
      });
      setData({ ...data, cluster: res.cluster });
      setBanner({ kind: 'accepted', pairsCreated: res.acceptances_created, pairsPreserved: res.acceptances_preserved });
      setDialog(null);
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
      const res = await api.rejectCluster(id, cluster_id, {
        notes: notes || undefined,
      });
      setData({ ...data, cluster: res.cluster });
      setBanner({ kind: 'rejected', revoked: res.acceptances_revoked });
      setDialog(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  if (error) return (
    <main className="cluster-detail">
      <Link to={`/sessions/${id}/clusters`} className="clusters-page__back">← Back to clusters</Link>
      <div className="error">{error}</div>
    </main>
  );
  if (!data) return (
    <main className="cluster-detail">
      <Link to={`/sessions/${id}/clusters`} className="clusters-page__back">← Back to clusters</Link>
      <p>Loading…</p>
    </main>
  );

  const { cluster, representative, members } = data;

  // When a member is focused, swap out the representative's display values
  // — but we still need the image shas, which only the representative has
  // (members carry only ids + bbox). So focusing a member updates the
  // *bbox + description* on top of the same image triple. To swap images,
  // the reviewer clicks through to the comparison detail page.
  const displayedBbox = focusedMember?.bounding_box ?? representative?.bounding_box ?? null;
  const displayedDescription = focusedMember?.description ?? representative?.description ?? '';

  return (
    <main className="cluster-detail">
      <Link to={`/sessions/${id}/clusters`} className="clusters-page__back">← Back to clusters</Link>

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
            disabled={cluster.review_state !== 'accepted' || actionBusy}
            title={cluster.review_state !== 'accepted' ? 'Only accepted clusters can be rejected' : 'Reject this cluster: delete its rule-owned acceptances'}
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

      {representative ? (
        <section className="cluster-detail__sample">
          <div className="cluster-detail__sample-meta">
            <div>
              <strong>Sample:</strong>{' '}
              <Link to={`/comparisons/${representative.comparison_id}`}>
                {representative.url_a}
              </Link>
              {focusedMember && focusedMember.difference_id !== representative.difference_id && (
                <span className="cluster-detail__focused-note">
                  {' '}(showing bbox from focused member; click the URL to view its comparison)
                </span>
              )}
            </div>
            {representative.lm_summary && (
              <p className="cluster-detail__lm-summary">
                <em>{representative.lm_summary}</em>
              </p>
            )}
            <p className="cluster-detail__metrics">
              {representative.lm_confidence != null && (
                <span>confidence: {representative.lm_confidence.toFixed(2)}</span>
              )}
              {representative.severity && <span>severity: {representative.severity}</span>}
              {representative.ssim != null && <span>ssim: {representative.ssim.toFixed(3)}</span>}
              {representative.changed_pct != null && (
                <span>changed: {representative.changed_pct.toFixed(2)}%</span>
              )}
            </p>
            <p className="cluster-detail__description">{displayedDescription}</p>
          </div>

          <div className="cluster-detail__images">
            <ImageTriple
              representative={representative}
              bbox={displayedBbox}
            />
          </div>
        </section>
      ) : (
        <p>No representative diff available for this cluster.</p>
      )}

      <section className="cluster-detail__members">
        <h3>
          Members{' '}
          <span className="cluster-detail__members-count">
            ({members.length}{members.length < cluster.member_count ? ` of ${cluster.member_count}` : ''})
          </span>
        </h3>
        <ul className="member-list">
          {members.map((m) => (
            <li
              key={m.difference_id}
              className={`member-row${focusedMember?.difference_id === m.difference_id ? ' member-row--focused' : ''}`}
            >
              <button
                type="button"
                className="member-row__focus"
                onClick={() => setFocusedMember(m)}
                title="Show this member's bbox over the sample image"
              >
                ◧
              </button>
              <span className="member-row__url">{m.url_a}</span>
              <span className="member-row__vp">{m.viewport_name}</span>
              <RecapturePairButton
                sessionId={id}
                pairId={m.url_pair_id}
                compact
                className="member-row__recapture"
              />
              <Link
                to={`/comparisons/${m.comparison_id}`}
                className="member-row__detail"
                title="Open full comparison detail"
              >
                Open →
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function ImageTriple({
  representative,
  bbox,
}: {
  representative: ClusterRepresentativeDto;
  bbox: { x: number; y: number; width: number; height: number } | null;
}): JSX.Element {
  const aUrl = imageUrl(representative.capture_a_sha);
  const bUrl = imageUrl(representative.capture_b_sha);
  const diffUrl = imageUrl(representative.im_diff_sha);
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
