import { useEffect, useState, type JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { ImageWithBoxes } from '../components/ImageWithBoxes.js';
import { StatusPill } from '../components/StatusPill.js';
import type { ComparisonDetailDto, BoundingBoxPercent } from '@visual-compare/api/types';

export function ComparisonDetailPage(): JSX.Element {
  const { id = '' } = useParams();
  const [detail, setDetail] = useState<ComparisonDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showBoxes, setShowBoxes] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const d = await api.getComparisonDetail(id);
        setDetail(d);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [id]);

  if (error) return <main><div className="error">{error}</div></main>;
  if (!detail) return <main><p className="muted">Loading…</p></main>;

  const { comparison: c, capture_a, capture_b, differences, url_pair } = detail;
  const boxes: BoundingBoxPercent[] = showBoxes
    ? differences.flatMap((d) => (d.bounding_box ? [d.bounding_box] : []))
    : [];

  return (
    <main>
      <p>
        <Link to={`/sessions/${url_pair.session_id}`}>← Back to session</Link>
      </p>
      <h2>Comparison · {c.viewport_name}</h2>
      <p className="muted">
        {url_pair.url_a} <br /> vs <br /> {url_pair.url_b}
      </p>

      <div className="card">
        <div className="metrics">
          <div><span className="label">Status:</span> <StatusPill status={c.status} /></div>
          <div><span className="label">Equivalence level:</span> <span className="value">{c.equivalence_level}</span></div>
          <div><span className="label">Changed pixel %:</span> <span className="value">{fmtPct(c.changed_pixel_percentage)}</span></div>
          <div><span className="label">SSIM:</span> <span className="value">{fmtNum(c.ssim, 4)}</span></div>
          <div><span className="label">Bounding-box area %:</span> <span className="value">{fmtPct(c.bounding_box_area_percentage)}</span></div>
          <div><span className="label">Connected components:</span> <span className="value">{c.connected_component_count ?? '—'}</span></div>
          <div><span className="label">Equivalent:</span> <span className="value">{c.is_equivalent === null ? '—' : c.is_equivalent ? '✓ yes' : '✗ no'}</span></div>
          <div><span className="label">LM invocation:</span> <span className="value">{c.lm_invocation_reason ?? '—'}</span></div>
        </div>
        {c.error_message && <div className="error">{c.error_message}</div>}
        <label>
          <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} />{' '}
          Show difference bounding boxes
        </label>
      </div>

      <div className="compare-grid">
        <div className="panel">
          <header>A · {capture_a.viewport_name}</header>
          {capture_a.screenshot_url ? (
            <ImageWithBoxes src={capture_a.screenshot_url} alt="A" boxes={boxes} />
          ) : <div style={{ padding: 16 }} className="muted">no image</div>}
        </div>
        <div className="panel">
          <header>B · {capture_b.viewport_name}</header>
          {capture_b.screenshot_url ? (
            <ImageWithBoxes src={capture_b.screenshot_url} alt="B" boxes={boxes} />
          ) : <div style={{ padding: 16 }} className="muted">no image</div>}
        </div>
        <div className="panel">
          <header>Diff</header>
          {c.im_diff_url ? (
            <ImageWithBoxes src={c.im_diff_url} alt="diff" boxes={boxes} />
          ) : <div style={{ padding: 16 }} className="muted">no diff image</div>}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Differences ({differences.length})</h3>
        {differences.length === 0 ? (
          <p className="muted">No structured differences recorded.</p>
        ) : (
          <ul className="diff-list">
            {differences.map((d) => (
              <li key={d.id}>
                <strong>[{d.source}]</strong> {d.description}
                {d.bounding_box ? (
                  <span className="muted">
                    {' '}— ({d.bounding_box.x.toFixed(1)}%, {d.bounding_box.y.toFixed(1)}%)
                    {' '}{d.bounding_box.width.toFixed(1)}×{d.bounding_box.height.toFixed(1)}%
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
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
