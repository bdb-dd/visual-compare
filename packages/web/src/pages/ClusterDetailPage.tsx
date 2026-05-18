import { useState, type JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ClusterDetailPanel } from '../components/ClusterDetailPanel.js';

/**
 * Cluster detail — outer shell. Body in `components/ClusterDetailPanel.tsx`
 * so the same content can render in `SessionDetailPage`'s detail pane in
 * Phase γ without leaving the unified surface.
 *
 * The standalone page owns its own `focusedMemberId` state (vs. lifting
 * it to the page-level filter shell as `SessionDetailPage` does for the
 * inline Members list). Members can still be stepped via j/k or the
 * filmstrip; the table-style list lives only on the unified surface.
 */
export function ClusterDetailPage(): JSX.Element {
  const { id = '', cluster_id = '' } = useParams();
  const [focusedMemberId, setFocusedMemberId] = useState<string | null>(null);
  return (
    <main className="cluster-detail">
      <Link to={`/sessions/${id}/clusters`} className="clusters-page__back">← Back to clusters</Link>
      <ClusterDetailPanel
        sessionId={id}
        clusterId={cluster_id}
        focusedMemberId={focusedMemberId}
        onMemberFocus={setFocusedMemberId}
      />
    </main>
  );
}
