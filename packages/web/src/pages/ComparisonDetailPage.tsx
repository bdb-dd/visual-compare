import { useCallback, useState, type JSX } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ComparisonDetail } from '../components/ComparisonDetail.js';
import type { ComparisonDetailDto } from '@visual-compare/api/types';

/**
 * Comparison detail at /sessions/:id/comparisons/:comparison_id. The
 * session id is read from the URL so the back-link is available
 * immediately, without waiting for the comparison detail fetch to
 * resolve. The legacy /comparisons/:id route redirects here via
 * `LegacyComparisonRedirect` in App.tsx.
 */
export function ComparisonDetailPage(): JSX.Element {
  const { id = '', comparison_id } = useParams();
  // Two shapes:
  //   - session-scoped: useParams() yields { id: <session>, comparison_id }
  //   - legacy fallback (no longer reachable in normal flows but kept
  //     working for any in-flight render before the redirect resolves):
  //     useParams() yields { id: <comparison> } and we discover the
  //     session id from the loaded detail.
  const cid = comparison_id ?? id;
  const sessionFromUrl = comparison_id ? id : null;
  const [sessionFromDetail, setSessionFromDetail] = useState<string | null>(null);
  const sessionId = sessionFromUrl ?? sessionFromDetail;

  const handleLoaded = useCallback((detail: ComparisonDetailDto) => {
    if (!sessionFromUrl) setSessionFromDetail(detail.url_pair.session_id);
  }, [sessionFromUrl]);

  const navigate = useNavigate();
  const handleComparisonIdChange = useCallback((newId: string) => {
    if (sessionId) {
      navigate(`/sessions/${sessionId}/comparisons/${newId}`, { replace: true });
    } else {
      // No session id yet — the legacy /comparisons/:id path is still
      // resolving the detail. Fall back to the legacy URL; the legacy
      // route's redirect will pick up the session id on landing.
      navigate(`/comparisons/${newId}`, { replace: true });
    }
  }, [navigate, sessionId]);

  return (
    <main className="wide">
      <p>
        {sessionId ? (
          <Link to={`/sessions/${sessionId}`}>← Back to session</Link>
        ) : (
          <span className="muted">←</span>
        )}
      </p>
      <ComparisonDetail
        id={cid}
        sessionId={sessionId ?? undefined}
        onLoaded={handleLoaded}
        onComparisonIdChange={handleComparisonIdChange}
      />
    </main>
  );
}
