import { useCallback, useEffect, useState, type JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { PlanAndEvaluate } from '../components/PlanAndEvaluate.js';
import { ResultsView } from '../components/ResultsView.js';
import { SessionConfigPanel } from '../components/SessionConfigPanel.js';
import type {
  CaptureRunRow,
  ComparisonRunRow,
  EquivalenceLevelId,
  EvaluationStatusDto,
  SessionConfig,
  SessionResultsDto,
  SessionRow,
  UrlPairRow,
  ViewportDef,
} from '@visual-compare/api/types';
import type { EquivalenceLevelDef } from '@visual-compare/api/constants/equivalence';

export function SessionDetailPage(): JSX.Element {
  const { id = '' } = useParams();
  const [session, setSession] = useState<SessionRow | null>(null);
  const [config, setConfig] = useState<SessionConfig | null>(null);
  const [pairs, setPairs] = useState<UrlPairRow[]>([]);
  const [viewports, setViewports] = useState<ViewportDef[]>([]);
  const [defaultViewportName, setDefaultViewportName] = useState<string>('desktop');
  const [levels, setLevels] = useState<EquivalenceLevelDef[]>([]);
  const [defaultLevel, setDefaultLevel] = useState<EquivalenceLevelId>('tolerant');
  const [results, setResults] = useState<SessionResultsDto | null>(null);
  const [evaluations, setEvaluations] = useState<EvaluationStatusDto[]>([]);
  const [captureRuns, setCaptureRuns] = useState<CaptureRunRow[]>([]);
  const [comparisonRuns, setComparisonRuns] = useState<ComparisonRunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pairsOpen, setPairsOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refreshResults = useCallback(async () => {
    try {
      const r = await api.getResults(id);
      setResults(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  const refreshEvaluations = useCallback(async () => {
    try {
      const e = await api.listEvaluations(id);
      setEvaluations(e.evaluations);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  const refreshHistory = useCallback(async () => {
    try {
      const [cap, comp] = await Promise.all([
        api.listCaptureRuns(id),
        api.listComparisonRuns(id),
      ]);
      setCaptureRuns(cap.capture_runs);
      setComparisonRuns(comp.comparison_runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    void (async () => {
      try {
        const [sess, vp, lv] = await Promise.all([
          api.getSession(id),
          api.getViewports(),
          api.getLevels(),
        ]);
        setSession(sess.session);
        setConfig(sess.config);
        setPairs(sess.url_pairs);
        setViewports(vp.viewports);
        setDefaultViewportName(vp.default);
        setLevels(lv.levels);
        setDefaultLevel(lv.default);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [id]);

  // Once the static bits load, fetch the dynamic plan/results.
  useEffect(() => {
    if (!session) return;
    void refreshResults();
    void refreshEvaluations();
    void refreshHistory();
  }, [session, refreshResults, refreshEvaluations, refreshHistory]);

  const handleEvaluationComplete = () => {
    void refreshResults();
    void refreshEvaluations();
    void refreshHistory();
  };

  const handleConfigSaved = (next: SessionConfig) => {
    setConfig(next);
    void refreshResults();
  };

  const handleArchive = async () => {
    if (!session) return;
    setBusy(true);
    try {
      const next = await api.patchSession(session.id, { archived: !session.archived_at });
      setSession(next.session);
      setConfig(next.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleInvalidateAll = async () => {
    if (!session) return;
    if (!confirm('Drop every cached capture for this session?')) return;
    setBusy(true);
    try {
      await api.invalidateCaptures(session.id, {});
      await refreshResults();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (error && !session) return <main><div className="error">{error}</div></main>;
  if (!session || !config) return <main><p className="muted">Loading…</p></main>;

  const lastEval = evaluations[0];

  return (
    <main className="wide">
      <p><Link to="/">← Back to sessions</Link></p>

      <div className="project-header">
        <div>
          <h2 style={{ margin: 0 }}>{session.name}</h2>
          <p className="muted" style={{ marginTop: 4 }}>
            {pairs.length} URL pair{pairs.length === 1 ? '' : 's'}
            {lastEval ? ` · last evaluated ${formatRelative(lastEval.started_at)}` : ' · not yet evaluated'}
            {session.archived_at ? ' · archived' : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn secondary" onClick={() => void handleInvalidateAll()} disabled={busy}>
            Recapture all
          </button>
          <button className="btn secondary" onClick={() => void handleArchive()} disabled={busy}>
            {session.archived_at ? 'Unarchive' : 'Archive'}
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="project-layout">
        <SessionConfigPanel
          sessionId={session.id}
          config={config}
          viewports={viewports}
          levels={levels}
          defaults={{ viewportName: defaultViewportName, level: defaultLevel }}
          onSaved={handleConfigSaved}
        />
        <div className="project-results">
          <PlanAndEvaluate
            sessionId={session.id}
            results={results}
            onEvaluationComplete={handleEvaluationComplete}
          />
          <ResultsView results={results} />
        </div>
      </div>

      <div className="card">
        <button
          type="button"
          className="btn secondary"
          style={{ padding: '4px 10px', fontSize: 13, float: 'right' }}
          onClick={() => setHistoryOpen((v) => !v)}
        >
          {historyOpen ? 'Hide' : 'Show'} history
        </button>
        <h3 style={{ marginTop: 0 }}>History</h3>
        {historyOpen && (
          <>
            {evaluations.length > 0 && (
              <>
                <p className="muted" style={{ marginTop: 0 }}>Evaluations</p>
                <table>
                  <thead>
                    <tr>
                      <th>Started</th>
                      <th>Status</th>
                      <th>Pairs</th>
                      <th>Cache hits</th>
                      <th>Capture run</th>
                      <th>Comparison runs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {evaluations.map((e) => (
                      <tr key={e.id}>
                        <td>{formatDate(e.started_at)}</td>
                        <td>{e.status}</td>
                        <td>{e.enabled_pair_count}</td>
                        <td className="muted">
                          c:{e.cache_hits.captures} p:{e.cache_hits.pixel} l:{e.cache_hits.lm}
                        </td>
                        <td className="muted">{e.capture_run_id?.slice(0, 8) ?? '—'}</td>
                        <td className="muted">{e.comparison_run_ids.length}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {captureRuns.length > 0 && (
              <>
                <p className="muted" style={{ marginTop: 16 }}>Capture runs</p>
                <table>
                  <thead>
                    <tr>
                      <th>Started</th>
                      <th>Viewports</th>
                      <th>Run id</th>
                    </tr>
                  </thead>
                  <tbody>
                    {captureRuns.map((r) => (
                      <tr key={r.id}>
                        <td>{formatDate(r.created_at)}</td>
                        <td>{parseViewports(r.options_json)}</td>
                        <td className="muted">{r.id.slice(0, 8)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {comparisonRuns.length > 0 && (
              <>
                <p className="muted" style={{ marginTop: 16 }}>Comparison runs</p>
                <table>
                  <thead>
                    <tr>
                      <th>Started</th>
                      <th>Level</th>
                      <th>Run id</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparisonRuns.map((r) => (
                      <tr key={r.id}>
                        <td>{formatDate(r.created_at)}</td>
                        <td>{r.equivalence_level}</td>
                        <td className="muted">{r.id.slice(0, 8)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </div>

      <div className="card">
        <button
          type="button"
          className="btn secondary"
          style={{ padding: '4px 10px', fontSize: 13, float: 'right' }}
          onClick={() => setPairsOpen((v) => !v)}
        >
          {pairsOpen ? 'Hide' : 'Show'} URL pairs
        </button>
        <h3 style={{ marginTop: 0 }}>URL pairs</h3>
        {pairsOpen && (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>URL A</th>
                <th>URL B</th>
                <th>Label</th>
                <th>Lang</th>
                <th>Category</th>
              </tr>
            </thead>
            <tbody>
              {pairs.map((p) => (
                <tr key={p.id}>
                  <td>{p.row_index + 1}</td>
                  <td>{p.url_a}</td>
                  <td>{p.url_b}</td>
                  <td>{p.label ?? ''}</td>
                  <td className="muted">{p.language ?? ''}</td>
                  <td className="muted">{p.category ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function parseViewports(optionsJson: string): string {
  try {
    const opts = JSON.parse(optionsJson) as { viewports?: { name: string }[] };
    return opts.viewports?.map((v) => v.name).join(', ') ?? '—';
  } catch {
    return '—';
  }
}
