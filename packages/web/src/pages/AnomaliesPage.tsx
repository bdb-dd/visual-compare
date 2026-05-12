import type { JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AnomaliesTab } from '../components/AnomaliesTab.js';

/**
 * Anomaly queue — outer shell. Body in `components/AnomaliesTab.tsx`
 * so it can be reused inside `SessionDetailPage`'s mode-tab strip in
 * Phase β.
 */
export function AnomaliesPage(): JSX.Element {
  const { id = '' } = useParams();
  return (
    <main className="anomalies-page">
      <Link to={`/sessions/${id}/clusters`} className="clusters-page__back">← Back to clusters</Link>
      <header className="clusters-page__header">
        <div>
          <h2>Anomaly queue</h2>
        </div>
      </header>
      <AnomaliesTab sessionId={id} />
    </main>
  );
}
