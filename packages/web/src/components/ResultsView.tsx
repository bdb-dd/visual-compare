import { useMemo, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import type { EquivalenceLevelId, SessionResultRow, SessionResultsDto } from '@visual-compare/api/types';

interface Props {
  results: SessionResultsDto | null;
}

type ResultBucket = 'pass' | 'fail' | 'pending' | 'allowed';

function bucketOf(row: SessionResultRow): ResultBucket {
  if (row.is_allowed && row.is_equivalent === 0) return 'allowed';
  if (row.status === 'pending' || row.is_equivalent === null) return 'pending';
  return row.is_equivalent === 1 ? 'pass' : 'fail';
}

interface LevelSummary {
  level: EquivalenceLevelId;
  pass: number;
  fail: number;
  pending: number;
  allowed: number;
}

function summarise(rows: SessionResultRow[]): LevelSummary[] {
  const byLevel = new Map<EquivalenceLevelId, LevelSummary>();
  for (const r of rows) {
    let s = byLevel.get(r.level);
    if (!s) {
      s = { level: r.level, pass: 0, fail: 0, pending: 0, allowed: 0 };
      byLevel.set(r.level, s);
    }
    s[bucketOf(r)] += 1;
  }
  return Array.from(byLevel.values()).sort((a, b) => a.level.localeCompare(b.level));
}

export function ResultsView({ results }: Props): JSX.Element {
  const [showAllowed, setShowAllowed] = useState(false);
  const summaries = useMemo(() => (results ? summarise(results.results) : []), [results]);

  const mismatches = useMemo(() => {
    if (!results) return [] as SessionResultRow[];
    return results.results.filter((r) => {
      const b = bucketOf(r);
      return b === 'fail' || (showAllowed && b === 'allowed');
    });
  }, [results, showAllowed]);

  if (!results) return <div className="card"><p className="muted">Loading results…</p></div>;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Results</h3>

      <div className="level-summaries">
        {summaries.length === 0 ? (
          <p className="muted">No results yet — press Evaluate above.</p>
        ) : (
          summaries.map((s) => (
            <div key={s.level} className="level-summary">
              <strong>{s.level}</strong>
              <span className="chip pass">{s.pass} pass</span>
              <span className="chip fail">{s.fail} fail</span>
              {s.allowed > 0 && <span className="chip allowed">{s.allowed} allowed</span>}
              {s.pending > 0 && <span className="chip pending">{s.pending} pending</span>}
            </div>
          ))
        )}
      </div>

      {summaries.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 }}>
            <h4 style={{ margin: 0, flex: 1 }}>
              Mismatches ({mismatches.filter((r) => bucketOf(r) === 'fail').length})
            </h4>
            <label className="muted" style={{ fontSize: 13 }}>
              <input
                type="checkbox"
                checked={showAllowed}
                onChange={(e) => setShowAllowed(e.target.checked)}
              />{' '}
              show allow-listed
            </label>
          </div>

          {mismatches.length === 0 ? (
            <p className="muted">No mismatches.</p>
          ) : (
            <table className="results-table">
              <thead>
                <tr>
                  <th>Pair</th>
                  <th>Viewport</th>
                  <th>Level</th>
                  <th>Changed %</th>
                  <th>SSIM</th>
                  <th>Verdict</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {mismatches.map((r) => (
                  <tr key={`${r.url_pair_id}::${r.viewport_name}::${r.level}`}>
                    <td title={`${r.url_a}\n${r.url_b}`}>
                      {r.label ?? r.url_a.slice(0, 40)}
                    </td>
                    <td>{r.viewport_name}</td>
                    <td>{r.level}</td>
                    <td>{r.pixel?.changed_pct?.toFixed(2) ?? '—'}</td>
                    <td>{r.pixel?.ssim?.toFixed(3) ?? '—'}</td>
                    <td>
                      {bucketOf(r) === 'allowed' ? (
                        <span className="chip allowed">allowed</span>
                      ) : (
                        <span className="chip fail">fail</span>
                      )}
                    </td>
                    <td>
                      {r.comparison_id ? (
                        <Link to={`/comparisons/${r.comparison_id}`}>open</Link>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
