import { useEffect, useState, type JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { ImageWithBoxes } from '../components/ImageWithBoxes.js';
import type {
  ClusterDetailDto,
  ClusterMemberDto,
  ClusterRepresentativeDto,
} from '@visual-compare/api/types';

/**
 * Phase B cluster detail — read-only. Shows the representative diff's image
 * triple with the bbox highlighted, plus the cluster's facets and a list of
 * member URLs that the reviewer can click into for full comparison detail.
 *
 * The accept/reject/split affordances from the proposal (§5.2) are placed
 * in the toolbar but disabled with a tooltip — wired up in Phase D.
 */

function imageUrl(sha: string | null | undefined): string | null {
  if (!sha || !/^[0-9a-f]{64}$/.test(sha)) return null;
  return `/images/sha256/${sha.slice(0, 2)}/${sha}.png`;
}

export function ClusterDetailPage(): JSX.Element {
  const { id = '', cluster_id = '' } = useParams();
  const [data, setData] = useState<ClusterDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusedMember, setFocusedMember] = useState<ClusterMemberDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api.getCluster(id, cluster_id, { limit: 500 })
      .then((dto) => { if (!cancelled) setData(dto); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [id, cluster_id]);

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
          <button type="button" disabled title="Available in Phase D">Accept cluster</button>
          <button type="button" disabled title="Available in Phase D">Reject</button>
          <button type="button" disabled title="Available in Phase D">Split cluster</button>
        </div>
      </header>

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
