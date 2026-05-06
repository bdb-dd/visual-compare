import { Fragment, useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { ComparisonDetail } from '../components/ComparisonDetail.js';
import { PlanAndEvaluate } from '../components/PlanAndEvaluate.js';
import { SessionConfigPanel } from '../components/SessionConfigPanel.js';
import { SessionResultsList, type ResultsFilter } from '../components/SessionResultsList.js';
import { UrlPairsEditor } from '../components/UrlPairsEditor.js';
import type {
  CaptureRunRow,
  ComparisonRunRow,
  EquivalenceLevelId,
  EvaluationStatusDto,
  SessionConfig,
  SessionResultRow,
  SessionResultsDto,
  SessionRow,
  UrlPairRow,
  ViewportDef,
} from '@visual-compare/api/types';
import type { EquivalenceLevelDef } from '@visual-compare/api/constants/equivalence';

type Tab = 'review' | 'config';

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
  const [expandedEvaluationId, setExpandedEvaluationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('review');
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [resultsFilter, setResultsFilter] = useState<ResultsFilter>('failed');
  const [selectedRow, setSelectedRow] = useState<SessionResultRow | null>(null);

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

  const refreshPairs = useCallback(async () => {
    try {
      const sess = await api.getSession(id);
      setPairs(sess.url_pairs);
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

      <PlanAndEvaluate
        sessionId={session.id}
        results={results}
        onEvaluationComplete={handleEvaluationComplete}
      />

      <div className="tab-bar" role="tablist" aria-label="Session view">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'review'}
          className={`tab ${activeTab === 'review' ? 'active' : ''}`}
          onClick={() => setActiveTab('review')}
        >
          Review {results ? <span className="muted">({results.results.length})</span> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'config'}
          className={`tab ${activeTab === 'config' ? 'active' : ''}`}
          onClick={() => setActiveTab('config')}
        >
          Config
        </button>
      </div>

      {activeTab === 'review' ? (
        <ReviewTab
          results={results}
          filter={resultsFilter}
          onFilterChange={setResultsFilter}
          selectedKey={selectedRowKey}
          selectedRow={selectedRow}
          onSelect={(key, row) => {
            setSelectedRowKey(key);
            setSelectedRow(row);
          }}
        />
      ) : (
        <SessionConfigPanel
          sessionId={session.id}
          config={config}
          viewports={viewports}
          levels={levels}
          defaults={{ viewportName: defaultViewportName, level: defaultLevel }}
          onSaved={(next) => {
            handleConfigSaved(next);
            setActiveTab('review');
          }}
        />
      )}

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
                      <th></th>
                      <th>Started</th>
                      <th>Status</th>
                      <th>Pairs</th>
                      <th>Cache hits</th>
                      <th>Capture run</th>
                      <th>Comparison runs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {evaluations.map((e) => {
                      const open = expandedEvaluationId === e.id;
                      return (
                        <Fragment key={e.id}>
                          <tr>
                            <td>
                              <button
                                type="button"
                                className="btn secondary"
                                style={{ padding: '0 6px', fontSize: 12 }}
                                onClick={() =>
                                  setExpandedEvaluationId(open ? null : e.id)
                                }
                              >
                                {open ? '▾' : '▸'}
                              </button>
                            </td>
                            <td>{formatDate(e.started_at)}</td>
                            <td>{e.status}</td>
                            <td>{e.enabled_pair_count}</td>
                            <td className="muted">
                              c:{e.cache_hits.captures} p:{e.cache_hits.pixel} l:{e.cache_hits.lm}
                            </td>
                            <td className="muted">{e.capture_run_id?.slice(0, 8) ?? '—'}</td>
                            <td className="muted">{e.comparison_run_ids.length}</td>
                          </tr>
                          {open && (
                            <tr>
                              <td colSpan={7}>
                                <EvaluationDetail evaluation={e} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
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
          <UrlPairsEditor
            sessionId={session.id}
            pairs={pairs}
            onChange={() => {
              void refreshPairs();
              void refreshResults();
            }}
          />
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

interface ReviewTabProps {
  results: SessionResultsDto | null;
  filter: ResultsFilter;
  onFilterChange: (next: ResultsFilter) => void;
  selectedKey: string | null;
  selectedRow: SessionResultRow | null;
  onSelect: (key: string | null, row: SessionResultRow | null) => void;
}

function ReviewTab({
  results,
  filter,
  onFilterChange,
  selectedKey,
  selectedRow,
  onSelect,
}: ReviewTabProps): JSX.Element {
  const summaries = useMemo(() => summariseByLevel(results?.results ?? []), [results]);

  if (!results) {
    return <div className="card"><p className="muted">Loading results…</p></div>;
  }
  if (results.results.length === 0) {
    return (
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          No results yet — press Evaluate above.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="level-summaries">
        {summaries.map((s) => (
          <div key={s.level} className="level-summary">
            <strong>{s.level}</strong>
            <span className="chip pass">{s.pass} pass</span>
            <span className="chip fail">{s.fail} fail</span>
            {s.allowed > 0 && <span className="chip allowed">{s.allowed} allowed</span>}
            {s.pending > 0 && <span className="chip pending">{s.pending} pending</span>}
          </div>
        ))}
      </div>

      <div className="review-layout">
        <SessionResultsList
          results={results.results}
          selectedKey={selectedKey}
          onSelect={onSelect}
          filter={filter}
          onFilterChange={onFilterChange}
        />
        <div className="review-detail-pane">
          {selectedRow?.comparison_id ? (
            <ComparisonDetail id={selectedRow.comparison_id} />
          ) : selectedRow ? (
            <div className="empty">
              <p className="muted">
                No comparison run yet for this row — its captures or pixel verdict
                are still pending. Press Evaluate above.
              </p>
            </div>
          ) : (
            <div className="empty">Select a result on the left.</div>
          )}
        </div>
      </div>
    </>
  );
}

interface LevelSummary {
  level: EquivalenceLevelId;
  pass: number;
  fail: number;
  allowed: number;
  pending: number;
}

function summariseByLevel(rows: SessionResultRow[]): LevelSummary[] {
  const byLevel = new Map<EquivalenceLevelId, LevelSummary>();
  for (const r of rows) {
    let s = byLevel.get(r.level);
    if (!s) {
      s = { level: r.level, pass: 0, fail: 0, allowed: 0, pending: 0 };
      byLevel.set(r.level, s);
    }
    if (r.is_allowed && r.is_equivalent === 0) s.allowed += 1;
    else if (r.status === 'pending' || r.is_equivalent === null) s.pending += 1;
    else if (r.is_equivalent === 1) s.pass += 1;
    else s.fail += 1;
  }
  return Array.from(byLevel.values()).sort((a, b) => a.level.localeCompare(b.level));
}

function EvaluationDetail({ evaluation }: { evaluation: EvaluationStatusDto }): JSX.Element {
  const config = evaluation.config as
    | {
        viewports?: { name: string }[];
        equivalence_levels?: string[];
        filter_query?: Record<string, unknown>;
        capture_options?: { hideSelectors?: string[]; settleDelayMs?: number };
      }
    | null;
  return (
    <div className="evaluation-detail">
      <div className="kv">
        <span className="muted">Viewports:</span>
        <span>{config?.viewports?.map((v) => v.name).join(', ') ?? '—'}</span>
      </div>
      <div className="kv">
        <span className="muted">Levels:</span>
        <span>{config?.equivalence_levels?.join(', ') ?? '—'}</span>
      </div>
      {config?.capture_options?.hideSelectors && config.capture_options.hideSelectors.length > 0 && (
        <div className="kv">
          <span className="muted">Hide selectors:</span>
          <span>{config.capture_options.hideSelectors.join(', ')}</span>
        </div>
      )}
      {config?.filter_query && Object.keys(config.filter_query).length > 0 && (
        <div className="kv">
          <span className="muted">Filter:</span>
          <code>{JSON.stringify(config.filter_query)}</code>
        </div>
      )}
      <div className="kv">
        <span className="muted">Cache hits:</span>
        <span>
          captures {evaluation.cache_hits.captures} · pixel {evaluation.cache_hits.pixel} · lm {evaluation.cache_hits.lm}
        </span>
      </div>
      {evaluation.error_message && (
        <div className="kv">
          <span className="muted">Error:</span>
          <span className="error" style={{ display: 'inline' }}>{evaluation.error_message}</span>
        </div>
      )}
      {evaluation.completed_at && (
        <div className="kv">
          <span className="muted">Completed:</span>
          <span>{formatDate(evaluation.completed_at)}</span>
        </div>
      )}
    </div>
  );
}
