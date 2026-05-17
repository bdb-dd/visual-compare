import { useEffect, useMemo, useState, type JSX } from 'react';
import { api, type SessionErrorEntry } from '../api/client.js';

/**
 * Detail-pane tab showing every persisted capture / comparison error
 * for the session, grouped by error message so repeat failures (same
 * timeout, same selector, same upstream 503) collapse into one bucket.
 * Per the refactor plan §4.4 this replaces the need to drill into rows
 * to find what went wrong during the last run.
 */
export function ErrorLogTab({ sessionId }: { sessionId: string }): JSX.Element {
  const [errors, setErrors] = useState<SessionErrorEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getSessionErrors(sessionId);
      setErrors(res.errors);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [sessionId]);

  // Group by exact error_message. Within each group, sort entries by
  // timestamp (newest first) so the user sees the most recent
  // occurrence at the top.
  const groups = useMemo(() => {
    if (!errors) return [];
    const byMessage = new Map<string, SessionErrorEntry[]>();
    for (const e of errors) {
      const list = byMessage.get(e.error_message) ?? [];
      list.push(e);
      byMessage.set(e.error_message, list);
    }
    return [...byMessage.entries()]
      .map(([message, entries]) => ({
        message,
        entries: [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
        captures: entries.filter((e) => e.kind === 'capture').length,
        comparisons: entries.filter((e) => e.kind === 'comparison').length,
      }))
      .sort((a, b) => b.entries.length - a.entries.length);
  }, [errors]);

  // First render runs before the load effect kicks in, so `errors` is
  // still null with `loading` still false. Treat any null state as the
  // loading placeholder rather than falling through to the body, which
  // would crash on `errors!.length`.
  if (errors === null) {
    return <p className="error-log__empty">{error ? `Failed to load errors: ${error}` : 'Loading errors…'}</p>;
  }
  if (error) {
    return <div className="error">Failed to load errors: {error}</div>;
  }
  if (errors.length === 0) {
    return (
      <p className="error-log__empty">
        No capture or comparison errors recorded for this session.
      </p>
    );
  }

  return (
    <div className="error-log">
      <div className="error-log__toolbar">
        <p className="muted error-log__summary">
          {errors.length} error{errors.length === 1 ? '' : 's'} across {groups.length}{' '}
          distinct message{groups.length === 1 ? '' : 's'}.
        </p>
        <button
          type="button"
          className="btn btn-compact secondary"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <ul className="error-log__groups">
        {groups.map((g, i) => (
          <li key={i} className="error-log__group">
            <details open={i === 0}>
              <summary>
                <span className="error-log__group-count">
                  {g.entries.length}×
                </span>
                <span className="error-log__group-kind">
                  {g.captures > 0 && g.comparisons === 0
                    ? 'capture'
                    : g.comparisons > 0 && g.captures === 0
                      ? 'comparison'
                      : 'mixed'}
                </span>
                <span className="error-log__group-message">{g.message}</span>
              </summary>
              <table className="error-log__table">
                <thead>
                  <tr>
                    <th>when</th>
                    <th>kind</th>
                    <th>viewport</th>
                    <th>url</th>
                  </tr>
                </thead>
                <tbody>
                  {g.entries.map((e) => (
                    <tr key={`${e.kind}:${e.id}`}>
                      <td className="error-log__when">{formatTime(e.timestamp)}</td>
                      <td>
                        <span className={`error-log__pill error-log__pill--${e.kind}`}>
                          {e.kind}
                          {e.side ? ` ${e.side.toUpperCase()}` : ''}
                        </span>
                        <span className="muted"> {e.viewport_name}</span>
                      </td>
                      <td className="muted">{e.viewport_name}</td>
                      <td className="error-log__url">
                        {e.kind === 'capture' && e.url ? e.url : (
                          <>
                            <span title={`A: ${e.url_a}`}>{shorten(e.url_a)}</span>
                            {' vs '}
                            <span title={`B: ${e.url_b}`}>{shorten(e.url_b)}</span>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function shorten(url: string): string {
  if (url.length <= 60) return url;
  return `${url.slice(0, 40)}…${url.slice(-15)}`;
}
