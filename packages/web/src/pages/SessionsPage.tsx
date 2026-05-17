import { useEffect, useState, type JSX, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import type { SessionDto } from '@visual-compare/api/types';

export function SessionsPage(): JSX.Element {
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const navigate = useNavigate();

  const reload = async () => {
    try {
      const data = await api.listSessions();
      // Defensive: in production we've seen the response body occasionally
      // arrive without the `sessions` key (cause TBD — see Network tab).
      // The TS type is `{ sessions: SessionDto[] }` so this fallback is a
      // belt-and-braces guard against a contract violation rather than a
      // tolerated case.
      setSessions(Array.isArray(data?.sessions) ? data.sessions : []);
      if (!Array.isArray(data?.sessions)) {
        // eslint-disable-next-line no-console
        console.warn('[SessionsPage] /api/sessions returned unexpected shape:', data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => { void reload(); }, []);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.uploadCsv(file, name || undefined);
      navigate(`/sessions/${result.session.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If the API returned row_errors, show them.
      const body = (err as { body?: { row_errors?: { row_index: number; errors: string[] }[] } }).body;
      const detail = body?.row_errors
        ? '\n' + body.row_errors.map((r) => `  row ${r.row_index}: ${r.errors.join(', ')}`).join('\n')
        : '';
      setError(`${msg}${detail}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <h2>Sessions</h2>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Upload a CSV</h3>
        <p className="muted">
          Required columns: <code>url_a</code>, <code>url_b</code>. Optional: <code>label</code>.
        </p>
        <form onSubmit={upload} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Session name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ minWidth: 240 }}
          />
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
          />
          <button className="btn" type="submit" disabled={busy || !file}>
            {busy ? 'Uploading…' : 'Create session'}
          </button>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Existing sessions</h3>
        {sessions.length === 0 ? (
          <p className="muted">No sessions yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>CSV</th>
                <th>URL pairs</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.csv_filename}</td>
                  <td>{s.url_pair_count}</td>
                  <td>{new Date(s.created_at).toLocaleString()}</td>
                  <td><Link to={`/sessions/${s.id}`}>open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
