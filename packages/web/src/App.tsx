import { useEffect, useState, type JSX } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { SessionsPage } from './pages/SessionsPage.js';
import { SessionDetailPage } from './pages/SessionDetailPage.js';
import { ComparisonDetailPage } from './pages/ComparisonDetailPage.js';
import { LmStatusPill } from './components/LmStatusPill.js';
import { api } from './api/client.js';
import { SystemStatusProvider } from './hooks/useSystemStatus.js';

export function App(): JSX.Element {
  return (
    <SystemStatusProvider>
      <GlobalHeader />
      <Routes>
        <Route path="/" element={<SessionsPage />} />
        <Route path="/sessions/:id" element={<SessionDetailPage />} />
        {/*
          Phase β: legacy cluster/anomaly URLs redirect into the unified
          session surface with the mode query param set. Existing bookmarks
          and external deep links keep working.
        */}
        <Route path="/sessions/:id/clusters" element={<RedirectToMode mode="clusters" />} />
        <Route path="/sessions/:id/anomalies" element={<RedirectToMode mode="anomalies" />} />
        {/*
          Phase γ: cluster detail folds into the unified surface's detail
          pane. The legacy permalink redirects with mode + focus set so
          the pane opens directly on the named cluster.
        */}
        <Route path="/sessions/:id/clusters/:cluster_id" element={<RedirectToClusterFocus />} />
        {/*
          Phase 4: comparison detail now lives under the session so the
          URL itself carries the session context. The legacy
          /comparisons/:id route redirects via a lookup so old share-links
          continue to land in the right place.
        */}
        <Route path="/sessions/:id/comparisons/:comparison_id" element={<ComparisonDetailPage />} />
        <Route path="/comparisons/:id" element={<LegacyComparisonRedirect />} />
      </Routes>
    </SystemStatusProvider>
  );
}

/**
 * Legacy /comparisons/:id share-link handler. Looks up the comparison's
 * session id and redirects to the session-scoped path. Renders a loading
 * line while the fetch is in flight; falls back to the standalone page
 * (no redirect) if the lookup errors so the user isn't left stranded.
 */
function LegacyComparisonRedirect(): JSX.Element {
  const { id = '' } = useParams();
  const { search } = useLocation();
  const [target, setTarget] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getComparisonDetail(id)
      .then((d) => {
        if (cancelled) return;
        setTarget(`/sessions/${d.url_pair.session_id}/comparisons/${id}${search}`);
      })
      .catch(() => {
        if (!cancelled) setErrored(true);
      });
    return () => { cancelled = true; };
  }, [id, search]);

  if (target) return <Navigate to={target} replace />;
  if (errored) {
    // Fall back to the standalone page so the user can still see the
    // comparison and pick up the error context from ComparisonDetail's
    // own error rendering.
    return <ComparisonDetailPage />;
  }
  return (
    <main className="wide">
      <p className="muted">Loading comparison…</p>
    </main>
  );
}

/**
 * Redirect helper for the Phase β legacy-route alias scheme. Preserves
 * any other query params the user may have on the URL.
 */
function RedirectToMode({ mode }: { mode: 'clusters' | 'anomalies' }): JSX.Element {
  const { id = '' } = useParams();
  const { search } = useLocation();
  const sp = new URLSearchParams(search);
  sp.set('mode', mode);
  return <Navigate to={`/sessions/${id}?${sp.toString()}`} replace />;
}

/**
 * Phase γ: cluster detail permalinks redirect into the unified surface
 * with the focus query param set so the pane opens directly on the
 * named cluster. Preserves any other params (e.g. ?status=accepted).
 */
function RedirectToClusterFocus(): JSX.Element {
  const { id = '', cluster_id = '' } = useParams();
  const { search } = useLocation();
  const sp = new URLSearchParams(search);
  sp.set('mode', 'clusters');
  sp.set('focus', cluster_id);
  return <Navigate to={`/sessions/${id}?${sp.toString()}`} replace />;
}

/**
 * The session detail page hosts its own combined top strip (brand +
 * breadcrumb + actions + LM pill), so suppress the global header there
 * to avoid stacking two header rows.
 */
function GlobalHeader(): JSX.Element | null {
  const { pathname } = useLocation();
  if (/^\/sessions\/[^/]+$/.test(pathname)) return null;
  return (
    <header className="app-header">
      <h1>visual-compare</h1>
      <nav>
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
          Sessions
        </NavLink>
      </nav>
      <div style={{ marginLeft: 'auto' }}>
        <LmStatusPill />
      </div>
    </header>
  );
}
