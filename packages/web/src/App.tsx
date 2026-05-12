import type { JSX } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { SessionsPage } from './pages/SessionsPage.js';
import { SessionDetailPage } from './pages/SessionDetailPage.js';
import { ComparisonDetailPage } from './pages/ComparisonDetailPage.js';
import { LmStatusPill } from './components/LmStatusPill.js';

export function App(): JSX.Element {
  return (
    <>
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
        <Route path="/comparisons/:id" element={<ComparisonDetailPage />} />
      </Routes>
    </>
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
