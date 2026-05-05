import { useEffect, useState, type JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { usePolledJob } from '../api/usePolledJob.js';
import { StatusPill } from '../components/StatusPill.js';
import type {
  CaptureDto,
  ComparisonDto,
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

  const [captureRun, setCaptureRun] = useState<RunSummary | null>(null);
  const [captures, setCaptures] = useState<CaptureDto[]>([]);
  const [comparisonRun, setComparisonRun] = useState<ComparisonSummary | null>(null);
  const [comparisons, setComparisons] = useState<ComparisonDto[]>([]);

  const captureJob = usePolledJob(captureRun?.job_id ?? null);
  const comparisonJob = usePolledJob(comparisonRun?.job_id ?? null);

  useEffect(() => {
    void (async () => {
      try {
        const [{ session, url_pairs }, vp, lv] = await Promise.all([
          api.getSession(id),
          api.getViewports(),
          api.getLevels(),
        ]);
        setSession(session);
        setPairs(url_pairs);
        setViewports(vp.viewports);
        setSelectedViewports([vp.default]);
        setLevels(lv.levels);
        setSelectedLevel(lv.default);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
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

  return (
    <main>
      <p><Link to="/">← Back to sessions</Link></p>
      <h2>{session.name}</h2>
      <p className="muted">{session.csv_filename} · {pairs.length} URL pair(s)</p>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>1. Capture screenshots</h3>
        <p>Viewports:</p>
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
        )}
      </div>

      {captureJob?.status === 'complete' && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>2. Compare</h3>
          <label>
            Equivalence level:{' '}
            <select value={selectedLevel} onChange={(e) => setSelectedLevel(e.target.value as EquivalenceLevelId)}>
              {levels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}{l.semantic ? ' (LM Studio)' : ''}
                </option>
              ))}
            </select>
          </label>
          <div style={{ marginTop: 12 }}>
            <button className="btn" onClick={startComparison} disabled={comparisonJob?.status === 'running'}>
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
          {comparisons.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Pair</th>
                  <th>Viewport</th>
                  <th>Status</th>
                  <th>Changed %</th>
                  <th>SSIM</th>
                  <th>Equivalent</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {comparisons.map((c) => (
                  <tr key={c.id}>
                    <td>{c.url_pair_id.slice(0, 8)}</td>
                    <td>{c.viewport_name}</td>
                    <td><StatusPill status={c.status} /></td>
                    <td>{fmtPct(c.changed_pixel_percentage)}</td>
                    <td>{fmtNum(c.ssim, 4)}</td>
                    <td>{c.is_equivalent === null ? '—' : c.is_equivalent ? '✓' : '✗'}</td>
                    <td><Link to={`/comparisons/${c.id}`}>open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
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

function fmtPct(v: number | null): string {
  if (v === null) return '—';
  return `${v.toFixed(3)}%`;
}
function fmtNum(v: number | null, digits = 3): string {
  if (v === null) return '—';
  return v.toFixed(digits);
}
