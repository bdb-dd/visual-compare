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

  const matchedEquivalent = matchedToBool(c.matched_at_level);
  const verdictKind = verdictOf(matchedEquivalent);
  const lmGlyph =
    c.lm_determined_equivalent === null ? '—' : c.lm_determined_equivalent ? '✓' : '✗';
  const lmTitle = c.lm_prompt_version
    ? `${c.lm_invocation_reason} · prompt ${c.lm_prompt_version}`
    : c.lm_invocation_reason ?? '';

  return (
    <>
      <div className="detail-head">
        <div className="dh-title-row">
          <span className={`verdict-chip verdict-${verdictKind}`}>{verdictGlyph(matchedEquivalent)}</span>
          <strong className="dh-title">{pairLabel}</strong>
          <span className="dh-sep">·</span>
          <span className="muted">{c.viewport_name}</span>
          <span className="dh-sep">·</span>
          <span className="muted">{c.matched_at_level ?? '—'}</span>
          <StatusPill status={c.status} />
          <label className="dh-toggle">
            <input
              type="checkbox"
              checked={showBoxes}
              onChange={(e) => setShowBoxes(e.target.checked)}
            />{' '}
            Boxes
          </label>
        </div>
        <div className="dh-urls">
          <div className="dh-url" title={url_pair.url_a}>
            <span className="dh-url-side">A</span>
            <span>{url_pair.url_a}</span>
          </div>
          <div className="dh-url" title={url_pair.url_b}>
            <span className="dh-url-side">B</span>
            <span>{url_pair.url_b}</span>
          </div>
        </div>
        <div className="dh-metrics">
          <span><span className="dh-key">Changed</span> {fmtPct(c.changed_pixel_percentage)}</span>
          <span><span className="dh-key">SSIM</span> {fmtNum(c.ssim, 4)}</span>
          <span><span className="dh-key">Box</span> {fmtPct(c.bounding_box_area_percentage)}</span>
          <span><span className="dh-key">Components</span> {c.connected_component_count ?? '—'}</span>
        </div>
        {c.lm_invocation_reason && (
          <div className="dh-lm" title={lmTitle}>
            <span className="dh-key">LM</span>
            <span className={`verdict-chip verdict-${verdictOf(c.lm_determined_equivalent)}`}>{lmGlyph}</span>
            <span className="muted">{c.lm_model ?? '—'}</span>
            <span className="muted">conf {fmtNum(c.lm_confidence, 2)}</span>
            {c.lm_diff_summary && <span className="dh-lm-summary">{c.lm_diff_summary}</span>}
          </div>
        )}
      </div>

      {c.error_message && <div className="error">{c.error_message}</div>}

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

function matchedToBool(level: ComparisonDetailDto['comparison']['matched_at_level']): number | null {
  if (level === null) return null;
  return level === 'none' ? 0 : 1;
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
