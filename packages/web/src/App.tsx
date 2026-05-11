import type { JSX } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { SessionsPage } from './pages/SessionsPage.js';
import { SessionDetailPage } from './pages/SessionDetailPage.js';
import { ComparisonDetailPage } from './pages/ComparisonDetailPage.js';
import { ClustersPage } from './pages/ClustersPage.js';
import { ClusterDetailPage } from './pages/ClusterDetailPage.js';
import { AnomaliesPage } from './pages/AnomaliesPage.js';
import { LmStatusPill } from './components/LmStatusPill.js';

export function App(): JSX.Element {
  return (
    <>
      <GlobalHeader />
      <Routes>
        <Route path="/" element={<SessionsPage />} />
        <Route path="/sessions/:id" element={<SessionDetailPage />} />
        <Route path="/sessions/:id/clusters" element={<ClustersPage />} />
        <Route path="/sessions/:id/anomalies" element={<AnomaliesPage />} />
        <Route path="/sessions/:id/clusters/:cluster_id" element={<ClusterDetailPage />} />
        <Route path="/comparisons/:id" element={<ComparisonDetailPage />} />
      </Routes>
    </>
  );
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
