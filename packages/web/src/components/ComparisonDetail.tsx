import { useEffect, useState, type JSX } from 'react';
import { api } from '../api/client.js';
import { ImageWithBoxes } from './ImageWithBoxes.js';
import { StatusPill } from './StatusPill.js';
import type { BoundingBoxPercent, ComparisonDetailDto } from '@visual-compare/api/types';

type ViewMode = 'diff' | 'a' | 'b' | 'split';

interface Props {
  id: string;
  onLoaded?: (detail: ComparisonDetailDto) => void;
}

const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: 'diff', label: 'Diff' },
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
  { id: 'split', label: 'A | B' },
];

export function ComparisonDetail({ id, onLoaded }: Props): JSX.Element {
  const [detail, setDetail] = useState<ComparisonDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showBoxes, setShowBoxes] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('diff');

  useEffect(() => {
    setDetail(null);
    setError(null);
    let cancelled = false;
    void (async () => {
      try {
        const d = await api.getComparisonDetail(id);
        if (cancelled) return;
        setDetail(d);
        onLoaded?.(d);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, onLoaded]);

  if (error) return <div className="error">{error}</div>;
  if (!detail) return <p className="muted">Loading…</p>;

  const { comparison: c, capture_a, capture_b, differences, url_pair } = detail;
  const boxes: BoundingBoxPercent[] = showBoxes
    ? differences.flatMap((d) => (d.bounding_box ? [d.bounding_box] : []))
    : [];
  const pairLabel = url_pair.label?.trim() || `Pair #${url_pair.row_index + 1}`;

  return (
    <>
      <div className="detail-header">
        <div className="detail-title">
          <strong>{pairLabel}</strong>
          <span className="viewport-badge">{c.viewport_name}</span>
          <span className={`verdict-chip verdict-${verdictOf(c.is_equivalent)}`}>{verdictGlyph(c.is_equivalent)}</span>
        </div>
        <div className="detail-urls muted">
          <div title={url_pair.url_a}>{url_pair.url_a}</div>
          <div title={url_pair.url_b}>{url_pair.url_b}</div>
        </div>
      </div>

      <div className="detail-metrics">
        <span className="metric"><span className="label">Changed</span> <span className="value">{fmtPct(c.changed_pixel_percentage)}</span></span>
        <span className="metric"><span className="label">SSIM</span> <span className="value">{fmtNum(c.ssim, 4)}</span></span>
        <span className="metric"><span className="label">Box area</span> <span className="value">{fmtPct(c.bounding_box_area_percentage)}</span></span>
        <span className="metric"><span className="label">Components</span> <span className="value">{c.connected_component_count ?? '—'}</span></span>
        <span className="metric"><span className="label">Level</span> <span className="value">{c.equivalence_level}</span></span>
        <span className="metric"><StatusPill status={c.status} /></span>
        <label className="metric toggle">
          <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} />{' '}
          Boxes
        </label>
      </div>

      {c.error_message && <div className="error">{c.error_message}</div>}

      {c.lm_invocation_reason && (
        <details className="lm-details">
          <summary>
            <strong>LM:</strong>{' '}
            {c.lm_determined_equivalent === null ? '—' : c.lm_determined_equivalent ? '✓' : '✗'}
            {' · '}{c.lm_model ?? '—'}
            {' · confidence '}{fmtNum(c.lm_confidence, 2)}
          </summary>
          <div className="lm-body">
            <div><span className="label">Invoked because:</span> {c.lm_invocation_reason}{c.lm_prompt_version ? ` · prompt ${c.lm_prompt_version}` : ''}</div>
            {c.lm_summary && <div><span className="label">Summary:</span> {c.lm_summary}</div>}
          </div>
        </details>
      )}

      <div className="detail-tabs" role="tablist">
        {VIEW_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={viewMode === m.id}
            className={`tab ${viewMode === m.id ? 'active' : ''}`}
            onClick={() => setViewMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className={`detail-frame mode-${viewMode}`}>
        {viewMode === 'diff' && (
          <Pane label="Diff" src={c.im_diff_url} alt="diff" boxes={boxes} />
        )}
        {viewMode === 'a' && (
          <Pane label={`A · ${capture_a.viewport_name}`} src={capture_a.screenshot_url} alt="A" boxes={boxes} />
        )}
        {viewMode === 'b' && (
          <Pane label={`B · ${capture_b.viewport_name}`} src={capture_b.screenshot_url} alt="B" boxes={boxes} />
        )}
        {viewMode === 'split' && (
          <>
            <Pane label="A" src={capture_a.screenshot_url} alt="A" boxes={boxes} />
            <Pane label="B" src={capture_b.screenshot_url} alt="B" boxes={boxes} />
          </>
        )}
      </div>

      {differences.length > 0 && (
        <details className="differences" open>
          <summary>Differences ({differences.length})</summary>
          <ul className="diff-list">
            {differences.map((d) => (
              <li key={d.id}>
                <strong>[{d.source}]</strong>
                {d.severity ? <span className="muted"> {d.severity}</span> : null}{' '}
                {d.description}
                {d.bounding_box ? (
                  <span className="muted">
                    {' '}— ({d.bounding_box.x.toFixed(1)}%, {d.bounding_box.y.toFixed(1)}%)
                    {' '}{d.bounding_box.width.toFixed(1)}×{d.bounding_box.height.toFixed(1)}%
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Pane({
  label,
  src,
  alt,
  boxes,
}: {
  label: string;
  src: string | null;
  alt: string;
  boxes: BoundingBoxPercent[];
}): JSX.Element {
  return (
    <div className="panel">
      <header>{label}</header>
      {src ? (
        <ImageWithBoxes src={src} alt={alt} boxes={boxes} />
      ) : (
        <div style={{ padding: 16 }} className="muted">no image</div>
      )}
    </div>
  );
}

function verdictOf(v: number | null): 'failed' | 'passed' | 'unknown' {
  if (v === 0) return 'failed';
  if (v === 1) return 'passed';
  return 'unknown';
}
function verdictGlyph(v: number | null): string {
  if (v === 0) return '✗';
  if (v === 1) return '✓';
  return '…';
}
function fmtPct(v: number | null): string {
  if (v === null) return '—';
  return `${v.toFixed(3)}%`;
}
function fmtNum(v: number | null, digits = 3): string {
  if (v === null) return '—';
  return v.toFixed(digits);
}
