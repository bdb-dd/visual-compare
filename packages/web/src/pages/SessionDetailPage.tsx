import { Fragment, useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { ComparisonDetail } from '../components/ComparisonDetail.js';
import { LmStatusPill } from '../components/LmStatusPill.js';
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

type SidebarTab = 'review' | 'config';
type DetailTab = 'comparison' | 'history' | 'pairs';

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
  const [expandedEvaluationId, setExpandedEvaluationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('review');
  const [detailTab, setDetailTab] = useState<DetailTab>('comparison');
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

  const cacheHits = results?.plan.cache_hits;

  return (
    <main className="wide">
      <header className="project-header">
        <div className="project-header-top">
          <p className="breadcrumb">
            <Link to="/" className="brand">visual-compare</Link>
            <span className="sep">/</span>
            <Link to="/">Sessions</Link>
            <span className="sep">/</span>
            <span className="title">{session.name}</span>
            {session.archived_at && <span className="muted"> (archived)</span>}
          </p>
          <div className="project-header-actions">
            <button className="btn secondary" onClick={() => void handleInvalidateAll()} disabled={busy}>
              Recapture all
            </button>
            <button className="btn secondary" onClick={() => void handleArchive()} disabled={busy}>
              {session.archived_at ? 'Unarchive' : 'Archive'}
            </button>
            <LmStatusPill />
          </div>
        </div>
        <div className="project-header-bottom">
          <p className="muted project-meta">
            {pairs.length} URL pair{pairs.length === 1 ? '' : 's'}
            {cacheHits
              ? ` · cache c:${cacheHits.captures} p:${cacheHits.pixel} l:${cacheHits.lm}`
              : ''}
            {lastEval ? ` · last evaluated ${formatRelative(lastEval.started_at)}` : ' · not yet evaluated'}
          </p>
          <PlanAndEvaluate
            sessionId={session.id}
            results={results}
            onEvaluationComplete={handleEvaluationComplete}
          />
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="project-body">
        <aside className="project-sidebar">
          <div className="tab-bar" role="tablist" aria-label="Sidebar view">
            <button
              type="button"
              role="tab"
              aria-selected={sidebarTab === 'review'}
              className={`tab ${sidebarTab === 'review' ? 'active' : ''}`}
              onClick={() => setSidebarTab('review')}
            >
              Review {results ? <span className="muted">({results.results.length})</span> : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sidebarTab === 'config'}
              className={`tab ${sidebarTab === 'config' ? 'active' : ''}`}
              onClick={() => setSidebarTab('config')}
            >
              Config
            </button>
          </div>

          {sidebarTab === 'review' ? (
            <ReviewSidebar
              results={results}
              filter={resultsFilter}
              onFilterChange={setResultsFilter}
              selectedKey={selectedRowKey}
              onSelect={(key, row) => {
                setSelectedRowKey(key);
                setSelectedRow(row);
                if (key !== null) setDetailTab('comparison');
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
                setSidebarTab('review');
              }}
            />
          )}
        </aside>

        <section className="project-detail">
          <div className="tab-bar" role="tablist" aria-label="Detail view">
            <button
              type="button"
              role="tab"
              aria-selected={detailTab === 'comparison'}
              className={`tab ${detailTab === 'comparison' ? 'active' : ''}`}
              onClick={() => setDetailTab('comparison')}
            >
              Comparison
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={detailTab === 'history'}
              className={`tab ${detailTab === 'history' ? 'active' : ''}`}
              onClick={() => setDetailTab('history')}
            >
              History {evaluations.length > 0 ? <span className="muted">({evaluations.length})</span> : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={detailTab === 'pairs'}
              className={`tab ${detailTab === 'pairs' ? 'active' : ''}`}
              onClick={() => setDetailTab('pairs')}
            >
              URL pairs <span className="muted">({pairs.length})</span>
            </button>
          </div>

          {detailTab === 'comparison' &&
            (selectedRow?.comparison_id ? (
              <ComparisonDetail id={selectedRow.comparison_id} />
            ) : selectedRow ? (
              <PendingRowDetail row={selectedRow} />
            ) : (
              <div className="card">
                <p className="muted" style={{ margin: 0 }}>
                  Select a result on the left.
                </p>
              </div>
            ))}

          {detailTab === 'history' && (
            <HistoryTab
              evaluations={evaluations}
              captureRuns={captureRuns}
              comparisonRuns={comparisonRuns}
              expandedEvaluationId={expandedEvaluationId}
              onToggleEvaluation={(id) =>
                setExpandedEvaluationId((cur) => (cur === id ? null : id))
              }
            />
          )}

          {detailTab === 'pairs' && (
            <UrlPairsEditor
              sessionId={session.id}
              pairs={pairs}
              onChange={() => {
                void refreshPairs();
                void refreshResults();
              }}
            />
          )}
        </section>
      </div>

    </main>
  );
}

interface HistoryTabProps {
  evaluations: EvaluationStatusDto[];
  captureRuns: CaptureRunRow[];
  comparisonRuns: ComparisonRunRow[];
  expandedEvaluationId: string | null;
  onToggleEvaluation: (id: string) => void;
}

function HistoryTab({
  evaluations,
  captureRuns,
  comparisonRuns,
  expandedEvaluationId,
  onToggleEvaluation,
}: HistoryTabProps): JSX.Element {
  if (evaluations.length === 0 && captureRuns.length === 0 && comparisonRuns.length === 0) {
    return (
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          No history yet — press Evaluate above.
        </p>
      </div>
    );
  }
  return (
    <>
      {evaluations.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Evaluations</h3>
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
                          onClick={() => onToggleEvaluation(e.id)}
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
        </div>
      )}

      {captureRuns.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Capture runs</h3>
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
        </div>
      )}

      {comparisonRuns.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Comparison runs</h3>
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
        </div>
      )}
    </>
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

interface ReviewSidebarProps {
  results: SessionResultsDto | null;
  filter: ResultsFilter;
  onFilterChange: (next: ResultsFilter) => void;
  selectedKey: string | null;
  onSelect: (key: string | null, row: SessionResultRow | null) => void;
}

function ReviewSidebar({
  results,
  filter,
  onFilterChange,
  selectedKey,
  onSelect,
}: ReviewSidebarProps): JSX.Element {
  const summaries = useMemo(() => summariseByLevel(results?.results ?? []), [results]);

  if (!results) {
    return <p className="muted" style={{ padding: 12 }}>Loading results…</p>;
  }
  if (results.results.length === 0) {
    return (
      <p className="muted" style={{ padding: 12, margin: 0 }}>
        No results yet — press Evaluate above.
      </p>
    );
  }

  return (
    <>
      <div className="level-summaries">
        {summaries.map((s) => (
          <div key={s.level} className="level-summary">
            <strong>{s.level}</strong>
            <span className="chip pass">{s.pass}</span>
            <span className="chip fail">{s.fail}</span>
            {s.allowed > 0 && <span className="chip allowed">{s.allowed}</span>}
            {s.pending > 0 && <span className="chip pending">{s.pending}</span>}
          </div>
        ))}
      </div>
      <SessionResultsList
        results={results.results}
        selectedKey={selectedKey}
        onSelect={onSelect}
        filter={filter}
        onFilterChange={onFilterChange}
      />
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

function PendingRowDetail({ row }: { row: SessionResultRow }): JSX.Element {
  const sides: Array<{ side: 'A' | 'B'; url: string; info: SessionResultRow['capture_a_status'] }> = [
    { side: 'A', url: row.url_a, info: row.capture_a_status },
    { side: 'B', url: row.url_b, info: row.capture_b_status },
  ];
  const anyError = sides.some((s) => s.info.status === 'error');

  return (
    <div className="card">
      {anyError ? (
        <>
          <h3 style={{ marginTop: 0, color: '#f87171' }}>Capture failed</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            One or both captures errored. The next evaluation won&rsquo;t retry automatically — fix
            the underlying issue (page reachability, hide-selectors, settle delay), then{' '}
            <em>Recapture all</em> at the top to clear the cache and re-attempt.
          </p>
        </>
      ) : (
        <>
          <h3 style={{ marginTop: 0 }}>Pending</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            No comparison verdict for this row yet. Press <em>Evaluate</em> above to run the
            captures and comparisons it depends on.
          </p>
        </>
      )}
      <div className="capture-status-list">
        {sides.map((s) => (
          <div key={s.side} className={`capture-status capture-status-${s.info.status}`}>
            <div className="capture-status-head">
              <span className={`chip ${s.info.status === 'error' ? 'fail' : s.info.status === 'complete' ? 'pass' : 'pending'}`}>
                Side {s.side} · {s.info.status === 'in_progress' ? 'in progress' : s.info.status}
              </span>
              <span className="muted" style={{ wordBreak: 'break-all', fontSize: 12 }}>{s.url}</span>
            </div>
            {s.info.error_message && (
              <pre className="capture-error">{s.info.error_message}</pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
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
