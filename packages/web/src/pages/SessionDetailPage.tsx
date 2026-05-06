import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type LmStatusDto } from '../api/client.js';
import { usePolledJob } from '../api/usePolledJob.js';
import { ComparisonDetail } from '../components/ComparisonDetail.js';
import { ComparisonList, type ComparisonFilter } from '../components/ComparisonList.js';
import { StatusPill } from '../components/StatusPill.js';
import { WorkflowBar } from '../components/WorkflowBar.js';
import type {
  CaptureDto,
  CaptureRunRow,
  ComparisonDto,
  ComparisonRunRow,
  EquivalenceLevelId,
  SessionRow,
  UrlPairRow,
  ViewportDef,
} from '@visual-compare/api/types';
import type { EquivalenceLevelDef } from '@visual-compare/api/constants/equivalence';

interface RunSummary {
  capture_run_id: string;
  job_id: string;
  capture_count: number;
}
interface ComparisonSummary {
  comparison_run_id: string;
  job_id: string;
  comparison_count: number;
}

export function SessionDetailPage(): JSX.Element {
  const { id = '' } = useParams();
  const [session, setSession] = useState<SessionRow | null>(null);
  const [pairs, setPairs] = useState<UrlPairRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [viewports, setViewports] = useState<ViewportDef[]>([]);
  const [selectedViewports, setSelectedViewports] = useState<string[]>([]);
  const [levels, setLevels] = useState<EquivalenceLevelDef[]>([]);
  const [selectedLevel, setSelectedLevel] = useState<EquivalenceLevelId>('tolerant');
  const [lmStatus, setLmStatus] = useState<LmStatusDto | null>(null);

  const [captureRun, setCaptureRun] = useState<RunSummary | null>(null);
  const [captures, setCaptures] = useState<CaptureDto[]>([]);
  const [comparisonRun, setComparisonRun] = useState<ComparisonSummary | null>(null);
  const [comparisons, setComparisons] = useState<ComparisonDto[]>([]);
  const [captureRunHistory, setCaptureRunHistory] = useState<CaptureRunRow[]>([]);
  const [comparisonRunHistory, setComparisonRunHistory] = useState<ComparisonRunRow[]>([]);

  const [filter, setFilter] = useState<ComparisonFilter>('all');
  const [selectedComparisonId, setSelectedComparisonId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const captureJob = usePolledJob(captureRun?.job_id ?? null);
  const comparisonJob = usePolledJob(comparisonRun?.job_id ?? null);

  const pairsById = useMemo(() => {
    const m = new Map<string, UrlPairRow>();
    for (const p of pairs) m.set(p.id, p);
    return m;
  }, [pairs]);

  useEffect(() => {
    void (async () => {
      try {
        const [{ session, url_pairs }, vp, lv, lm, capRuns, compRuns] = await Promise.all([
          api.getSession(id),
          api.getViewports(),
          api.getLevels(),
          api.getLmStatus().catch(() => null),
          api.listCaptureRuns(id),
          api.listComparisonRuns(id),
        ]);
        setSession(session);
        setPairs(url_pairs);
        setViewports(vp.viewports);
        setSelectedViewports([vp.default]);
        setLevels(lv.levels);
        setSelectedLevel(lv.default);
        setLmStatus(lm);
        setCaptureRunHistory(capRuns.capture_runs);
        setComparisonRunHistory(compRuns.comparison_runs);
        if (compRuns.comparison_runs.length > 0) {
          await autoLoadComparison(compRuns.comparison_runs[0]!);
        } else if (capRuns.capture_runs.length > 0) {
          await autoLoadCapture(capRuns.capture_runs[0]!);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    async function autoLoadCapture(run: CaptureRunRow): Promise<void> {
      const { capture_run, captures: caps } = await api.getCaptureRun(run.id);
      setCaptureRun({ capture_run_id: run.id, job_id: capture_run.job_id, capture_count: caps.length });
      setCaptures(caps);
    }
    async function autoLoadComparison(run: ComparisonRunRow): Promise<void> {
      const [{ capture_run, captures: caps }, { comparison_run, comparisons: comps }] = await Promise.all([
        api.getCaptureRun(run.capture_run_id),
        api.getComparisonRun(run.id),
      ]);
      setCaptureRun({ capture_run_id: run.capture_run_id, job_id: capture_run.job_id, capture_count: caps.length });
      setCaptures(caps);
      setComparisonRun({ comparison_run_id: run.id, job_id: comparison_run.job_id, comparison_count: comps.length });
      setComparisons(comps);
    }
  }, [id]);

  useEffect(() => {
    if (!captureRun) return;
    if (captureJob?.status === 'complete' || captureJob?.status === 'error') {
      void (async () => {
        const { captures } = await api.getCaptureRun(captureRun.capture_run_id);
        setCaptures(captures);
      })();
    } else if (captureJob && captureJob.status === 'running') {
      const t = setInterval(async () => {
        const { captures } = await api.getCaptureRun(captureRun.capture_run_id);
        setCaptures(captures);
      }, 1500);
      return () => clearInterval(t);
    }
  }, [captureRun, captureJob?.status]);

  useEffect(() => {
    if (!comparisonRun) return;
    if (comparisonJob?.status === 'complete' || comparisonJob?.status === 'error') {
      void (async () => {
        const { comparisons } = await api.getComparisonRun(comparisonRun.comparison_run_id);
        setComparisons(comparisons);
      })();
    } else if (comparisonJob && comparisonJob.status === 'running') {
      const t = setInterval(async () => {
        const { comparisons } = await api.getComparisonRun(comparisonRun.comparison_run_id);
        setComparisons(comparisons);
      }, 1500);
      return () => clearInterval(t);
    }
  }, [comparisonRun, comparisonJob?.status]);

  const refreshHistory = async () => {
    const [capRuns, compRuns] = await Promise.all([
      api.listCaptureRuns(id),
      api.listComparisonRuns(id),
    ]);
    setCaptureRunHistory(capRuns.capture_runs);
    setComparisonRunHistory(compRuns.comparison_runs);
  };

  const startCapture = async () => {
    if (!session) return;
    setError(null);
    try {
      const chosen = viewports.filter((v) => selectedViewports.includes(v.name));
      const result = await api.startCaptureRun(session.id, {
        viewports: chosen.length > 0 ? chosen : undefined,
      });
      setCaptureRun({
        capture_run_id: result.capture_run_id!,
        job_id: result.job_id,
        capture_count: (result as unknown as { capture_count: number }).capture_count,
      });
      setCaptures([]);
      setComparisonRun(null);
      setComparisons([]);
      setSelectedComparisonId(null);
      void refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startComparison = async () => {
    if (!session || !captureRun) return;
    setError(null);
    try {
      const result = await api.startComparisonRun(session.id, captureRun.capture_run_id, selectedLevel);
      setComparisonRun({
        comparison_run_id: result.comparison_run_id!,
        job_id: result.job_id,
        comparison_count: (result as unknown as { comparison_count: number }).comparison_count,
      });
      setComparisons([]);
      setSelectedComparisonId(null);
      void refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadCaptureFromHistory = async (run: CaptureRunRow) => {
    try {
      const { capture_run, captures: caps } = await api.getCaptureRun(run.id);
      setCaptureRun({ capture_run_id: run.id, job_id: capture_run.job_id, capture_count: caps.length });
      setCaptures(caps);
      setComparisonRun(null);
      setComparisons([]);
      setSelectedComparisonId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadComparisonFromHistory = async (run: ComparisonRunRow) => {
    try {
      const [{ capture_run, captures: caps }, { comparison_run, comparisons: comps }] = await Promise.all([
        api.getCaptureRun(run.capture_run_id),
        api.getComparisonRun(run.id),
      ]);
      setCaptureRun({ capture_run_id: run.capture_run_id, job_id: capture_run.job_id, capture_count: caps.length });
      setCaptures(caps);
      setComparisonRun({ comparison_run_id: run.id, job_id: comparison_run.job_id, comparison_count: comps.length });
      setComparisons(comps);
      setSelectedComparisonId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleVp = (name: string) => {
    setSelectedViewports((prev) =>
      prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name],
    );
  };

  if (error && !session) return <main><div className="error">{error}</div></main>;
  if (!session) return <main><p className="muted">Loading…</p></main>;

  const mainClass = comparisons.length > 0 ? 'wide' : undefined;

  const hasAnyRuns = captureRun !== null || captureRunHistory.length > 0;

  const captureControls = renderCaptureControls({
    viewports,
    selectedViewports,
    toggleVp,
    captureJob,
    captureRun,
    captures,
    startCapture,
  });

  const comparisonControls = renderComparisonControls({
    levels,
    selectedLevel,
    setSelectedLevel,
    lmStatus,
    comparisonJob,
    comparisonRun,
    startComparison,
    captureRun,
  });

  return (
    <main className={mainClass}>
      <p><Link to="/">← Back to sessions</Link></p>
      <h2 style={{ marginBottom: 4 }}>{session.name}</h2>
      <p className="muted" style={{ marginTop: 0 }}>{session.csv_filename} · {pairs.length} URL pair(s)</p>
      {error && <div className="error">{error}</div>}

      {!hasAnyRuns ? (
        <>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>1. Capture screenshots</h3>
            {captureControls}
          </div>
          {(captureJob?.status === 'complete' || captures.length > 0) && (
            <div className="card">
              <h3 style={{ marginTop: 0 }}>2. Compare</h3>
              {comparisonControls}
            </div>
          )}
        </>
      ) : (
        <>
          <WorkflowBar
            capture={{
              label: 'Captured',
              primary: captureSummaryText(captureRun, captures, captureJob),
              meta: captureRun ? `run ${captureRun.capture_run_id.slice(0, 8)}` : undefined,
              actionLabel: 'Recapture',
              controls: captureControls,
            }}
            comparison={
              comparisonRun || comparisons.length > 0 || captureJob?.status === 'complete'
                ? {
                    label: 'Compared',
                    primary: comparisonSummaryText(comparisonRun, comparisons, comparisonJob, selectedLevel),
                    meta: comparisonRun ? `run ${comparisonRun.comparison_run_id.slice(0, 8)}` : undefined,
                    actionLabel: comparisonRun ? 'Recompare' : 'Compare',
                    controls: comparisonControls,
                  }
                : null
            }
          />

          {comparisons.length > 0 ? (
            <div className="review-layout">
              <ComparisonList
                comparisons={comparisons}
                pairsById={pairsById}
                selectedId={selectedComparisonId}
                onSelect={setSelectedComparisonId}
                filter={filter}
                onFilterChange={setFilter}
              />
              <div className="review-detail-pane">
                {selectedComparisonId ? (
                  <ComparisonDetail id={selectedComparisonId} />
                ) : (
                  <div className="empty">Select a comparison from the list.</div>
                )}
              </div>
            </div>
          ) : (
            <div className="card">
              <p className="muted" style={{ margin: 0 }}>
                {comparisonJob?.status === 'running'
                  ? 'Comparing…'
                  : captureJob?.status === 'running'
                    ? 'Capturing screenshots…'
                    : 'No comparison results yet. Use “Compare” above to start a run.'}
              </p>
            </div>
          )}
        </>
      )}

      {(captureRunHistory.length > 0 || comparisonRunHistory.length > 0) && (
        <div className="card">
          <button
            type="button"
            className="btn secondary"
            style={{ padding: '4px 10px', fontSize: 13, float: 'right' }}
            onClick={() => setHistoryOpen((v) => !v)}
          >
            {historyOpen ? 'Hide' : 'Show'} history
          </button>
          <h3 style={{ marginTop: 0 }}>Run history</h3>
          {historyOpen && (
            <>
              {captureRunHistory.length > 0 && (
                <>
                  <p className="muted" style={{ marginTop: 0 }}>Capture runs</p>
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Viewports</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {captureRunHistory.map((run) => {
                        const vpNames = parseViewports(run.options_json);
                        const isActive = captureRun?.capture_run_id === run.id;
                        return (
                          <tr key={run.id}>
                            <td>{fmtDate(run.created_at)}</td>
                            <td>{vpNames}</td>
                            <td>
                              {isActive ? (
                                <span className="muted">active</span>
                              ) : (
                                <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 13 }} onClick={() => void loadCaptureFromHistory(run)}>
                                  Load
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              )}

              {comparisonRunHistory.length > 0 && (
                <>
                  <p className="muted" style={{ marginTop: captureRunHistory.length > 0 ? 16 : 0 }}>Comparison runs</p>
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Level</th>
                        <th>Capture run</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparisonRunHistory.map((run) => {
                        const isActive = comparisonRun?.comparison_run_id === run.id;
                        return (
                          <tr key={run.id}>
                            <td>{fmtDate(run.created_at)}</td>
                            <td>{run.equivalence_level}</td>
                            <td className="muted">{run.capture_run_id.slice(0, 8)}</td>
                            <td>
                              {isActive ? (
                                <span className="muted">active</span>
                              ) : (
                                <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 13 }} onClick={() => void loadComparisonFromHistory(run)}>
                                  Load
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>URL pairs</h3>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>URL A</th>
              <th>URL B</th>
              <th>Label</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p) => (
              <tr key={p.id}>
                <td>{p.row_index + 1}</td>
                <td>{p.url_a}</td>
                <td>{p.url_b}</td>
                <td>{p.label ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function renderCaptureControls(args: {
  viewports: ViewportDef[];
  selectedViewports: string[];
  toggleVp: (name: string) => void;
  captureJob: ReturnType<typeof usePolledJob>;
  captureRun: RunSummary | null;
  captures: CaptureDto[];
  startCapture: () => void;
}): ReactNode {
  const { viewports, selectedViewports, toggleVp, captureJob, captureRun, captures, startCapture } = args;
  return (
    <>
      <p style={{ marginTop: 0 }}>Viewports:</p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        {viewports.map((v) => (
          <label key={v.name} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={selectedViewports.includes(v.name)}
              onChange={() => toggleVp(v.name)}
            />
            {v.name} ({v.width}×{v.height})
          </label>
        ))}
      </div>
      <button className="btn" onClick={startCapture} disabled={selectedViewports.length === 0 || captureJob?.status === 'running'}>
        {captureJob?.status === 'running' ? 'Capturing…' : 'Start capture run'}
      </button>
      {captureRun && captureJob && (
        <p style={{ marginTop: 12 }}>
          <StatusPill status={captureJob.status} />{' '}
          <span className="muted">
            {captureJob.progress_current}/{captureJob.progress_total}
            {captureJob.error_message ? ` — ${captureJob.error_message}` : ''}
          </span>
        </p>
      )}
      {captures.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary className="muted" style={{ cursor: 'pointer' }}>Captures ({captures.length})</summary>
          <table>
            <thead>
              <tr>
                <th>Pair</th>
                <th>Viewport</th>
                <th>Side</th>
                <th>Status</th>
                <th>Image</th>
              </tr>
            </thead>
            <tbody>
              {captures.map((c) => (
                <tr key={c.id}>
                  <td>{c.url_pair_id.slice(0, 8)}</td>
                  <td>{c.viewport_name}</td>
                  <td>{c.side}</td>
                  <td><StatusPill status={c.status} /></td>
                  <td>
                    {c.screenshot_url ? (
                      <a href={c.screenshot_url} target="_blank" rel="noreferrer">view</a>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </>
  );
}

function renderComparisonControls(args: {
  levels: EquivalenceLevelDef[];
  selectedLevel: EquivalenceLevelId;
  setSelectedLevel: (l: EquivalenceLevelId) => void;
  lmStatus: LmStatusDto | null;
  comparisonJob: ReturnType<typeof usePolledJob>;
  comparisonRun: ComparisonSummary | null;
  startComparison: () => void;
  captureRun: RunSummary | null;
}): ReactNode {
  const { levels, selectedLevel, setSelectedLevel, lmStatus, comparisonJob, comparisonRun, startComparison, captureRun } = args;
  return (
    <>
      <label>
        Equivalence level:{' '}
        <select value={selectedLevel} onChange={(e) => setSelectedLevel(e.target.value as EquivalenceLevelId)}>
          {levels.map((l) => {
            const needsLm = l.semantic || l.ambiguity_band_percentage > 0;
            const lmDown = lmStatus !== null && !lmStatus.ok;
            const disabled = needsLm && lmDown;
            const suffix = l.semantic
              ? ' (LM Studio)'
              : needsLm
                ? ` (LM tiebreak ±${l.ambiguity_band_percentage}%)`
                : '';
            return (
              <option key={l.id} value={l.id} disabled={disabled} title={disabled ? 'LM Studio is unavailable' : undefined}>
                {l.name}{suffix}{disabled ? ' — LM down' : ''}
              </option>
            );
          })}
        </select>
      </label>
      <div style={{ marginTop: 12 }}>
        <button
          className="btn"
          onClick={startComparison}
          disabled={comparisonJob?.status === 'running' || !captureRun}
        >
          {comparisonJob?.status === 'running' ? 'Comparing…' : 'Start comparison run'}
        </button>
      </div>
      {comparisonRun && comparisonJob && (
        <p style={{ marginTop: 12 }}>
          <StatusPill status={comparisonJob.status} />{' '}
          <span className="muted">
            {comparisonJob.progress_current}/{comparisonJob.progress_total}
            {comparisonJob.error_message ? ` — ${comparisonJob.error_message}` : ''}
          </span>
        </p>
      )}
    </>
  );
}

function captureSummaryText(
  captureRun: RunSummary | null,
  captures: CaptureDto[],
  captureJob: ReturnType<typeof usePolledJob>,
): string {
  if (!captureRun) return 'No capture run loaded';
  const vps = Array.from(new Set(captures.map((c) => c.viewport_name))).filter(Boolean);
  const vpStr = vps.length > 0 ? vps.join(', ') : `${captureRun.capture_count} captures`;
  if (captureJob?.status === 'running') {
    return `Capturing ${captureJob.progress_current}/${captureJob.progress_total}${vps.length > 0 ? ` · ${vpStr}` : ''}`;
  }
  if (captureJob?.status === 'error') return `Errored · ${vpStr}`;
  return vpStr;
}

function comparisonSummaryText(
  comparisonRun: ComparisonSummary | null,
  comparisons: ComparisonDto[],
  comparisonJob: ReturnType<typeof usePolledJob>,
  selectedLevel: EquivalenceLevelId,
): string {
  if (!comparisonRun) return `Not compared yet · ${selectedLevel}`;
  const level = comparisons[0]?.equivalence_level ?? selectedLevel;
  if (comparisonJob?.status === 'running') {
    return `Comparing ${comparisonJob.progress_current}/${comparisonJob.progress_total} · ${level}`;
  }
  if (comparisonJob?.status === 'error') return `Errored · ${level}`;
  const failed = comparisons.filter((c) => c.is_equivalent === 0).length;
  const passed = comparisons.filter((c) => c.is_equivalent === 1).length;
  return `${level} · ${failed} failed · ${passed} passed (${comparisons.length} total)`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString();
}
function parseViewports(optionsJson: string): string {
  try {
    const opts = JSON.parse(optionsJson) as { viewports?: { name: string }[] };
    return opts.viewports?.map((v) => v.name).join(', ') ?? '—';
  } catch {
    return '—';
  }
}
