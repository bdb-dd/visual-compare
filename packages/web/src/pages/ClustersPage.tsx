import type { JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ClustersTab } from '../components/ClustersTab.js';
import { DEFAULT_FILTER_STATE } from '../api/filterState.js';

/**
 * Cluster review category index — outer shell. The body content lives in
 * `components/ClustersTab.tsx` so it can be reused inside
 * `SessionDetailPage`'s mode-tab strip in Phase β.
 *
 * After Phase β lands, this route redirects into the unified surface and
 * this file can be retired or kept as a permalink wrapper.
 */
export function ClustersPage(): JSX.Element {
  const { id = '' } = useParams();
  return (
    <main className="clusters-page">
      <header className="clusters-page__header">
        <div>
          <Link to={`/sessions/${id}`} className="clusters-page__back">← Back to session</Link>
          <h2>Cluster review</h2>
        </div>
        <div className="clusters-page__header-actions">
          <Link to={`/sessions/${id}/anomalies`} className="btn secondary">
            Anomaly queue →
          </Link>
        </div>
      </header>
      <ClustersTab sessionId={id} filter={DEFAULT_FILTER_STATE} />
    </main>
  );
}
