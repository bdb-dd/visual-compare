import type { JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ClusterDetailPanel } from '../components/ClusterDetailPanel.js';

/**
 * Cluster detail — outer shell. Body in `components/ClusterDetailPanel.tsx`
 * so the same content can render in `SessionDetailPage`'s detail pane in
 * Phase γ without leaving the unified surface.
 */
export function ClusterDetailPage(): JSX.Element {
  const { id = '', cluster_id = '' } = useParams();
  return (
    <main className="cluster-detail">
      <Link to={`/sessions/${id}/clusters`} className="clusters-page__back">← Back to clusters</Link>
      <ClusterDetailPanel sessionId={id} clusterId={cluster_id} />
    </main>
  );
}
