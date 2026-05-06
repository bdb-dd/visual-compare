import { useCallback, useState, type JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ComparisonDetail } from '../components/ComparisonDetail.js';
import type { ComparisonDetailDto } from '@visual-compare/api/types';

export function ComparisonDetailPage(): JSX.Element {
  const { id = '' } = useParams();
  const [sessionId, setSessionId] = useState<string | null>(null);

  const handleLoaded = useCallback((detail: ComparisonDetailDto) => {
    setSessionId(detail.url_pair.session_id);
  }, []);

  return (
    <main className="wide">
      <p>
        {sessionId ? (
          <Link to={`/sessions/${sessionId}`}>← Back to session</Link>
        ) : (
          <span className="muted">←</span>
        )}
      </p>
      <ComparisonDetail id={id} onLoaded={handleLoaded} />
    </main>
  );
}
