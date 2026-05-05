import type { JSX } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { SessionsPage } from './pages/SessionsPage.js';
import { SessionDetailPage } from './pages/SessionDetailPage.js';
import { ComparisonDetailPage } from './pages/ComparisonDetailPage.js';
import { LmStatusPill } from './components/LmStatusPill.js';

export function App(): JSX.Element {
  return (
    <>
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
      <Routes>
        <Route path="/" element={<SessionsPage />} />
        <Route path="/sessions/:id" element={<SessionDetailPage />} />
        <Route path="/comparisons/:id" element={<ComparisonDetailPage />} />
      </Routes>
    </>
  );
}
