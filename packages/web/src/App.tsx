import type { JSX } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { SessionsPage } from './pages/SessionsPage.js';
import { SessionDetailPage } from './pages/SessionDetailPage.js';
import { ComparisonDetailPage } from './pages/ComparisonDetailPage.js';
import { ClusterDetailPage } from './pages/ClusterDetailPage.js';
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
          Cluster detail stays as its own route in β — γ folds it into the
          unified surface's detail pane. Until then, it's a permalink target.
        */}
        <Route path="/sessions/:id/clusters/:cluster_id" element={<ClusterDetailPage />} />
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
