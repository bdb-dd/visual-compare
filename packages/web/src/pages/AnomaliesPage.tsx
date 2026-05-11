import { useEffect, useMemo, useState, type JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import type {
  ClusterListDto,
  ClusterSummaryDto,
} from '@visual-compare/api/types';

/**
 * Anomaly queue — singleton clusters (pair_count = 1) gathered into a
 * flat, severity-sorted list. After the bulk pass, this is where most of
 * the reviewer's attention should land: one-off changes that don't fit
 * any larger pattern.
 *
 * Clicking a row jumps to the cluster detail page where the per-cluster
 * Accept / Reject buttons live.
 */

function severityRank(s: string | null | undefined): number {
  switch (s) {
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

export function AnomaliesPage(): JSX.Element {
  const { id = '' } = useParams();
  const [data, setData] = useState<ClusterListDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api.listClusters(id)
      .then((dto) => { if (!cancelled) setData(dto); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [id]);

  const anomalies = useMemo(() => {
    if (!data) return [] as ClusterSummaryDto[];
    return [...data.clusters]
      .filter((c) => c.pair_count === 1)
      .sort((a, b) => {
        const sevDiff = severityRank(b.sample?.severity) - severityRank(a.sample?.severity);
        if (sevDiff !== 0) return sevDiff;
        const reg = (a.region_role ?? '').localeCompare(b.region_role ?? '');
        if (reg !== 0) return reg;
        return (a.change_type ?? '').localeCompare(b.change_type ?? '');
      });
  }, [data]);

  const byState = useMemo(() => {
    const out = { open: 0, accepted: 0, rejected: 0 };
    for (const a of anomalies) {
      if (a.review_state === 'open') out.open += 1;
      else if (a.review_state === 'accepted') out.accepted += 1;
      else if (a.review_state === 'rejected') out.rejected += 1;
    }
    return out;
  }, [anomalies]);

  return (
    <main className="anomalies-page">
      <Link to={`/sessions/${id}/clusters`} className="clusters-page__back">← Back to clusters</Link>
      <header className="clusters-page__header">
        <div>
          <h2>Anomaly queue</h2>
          <p className="clusters-page__summary">
            Singleton clusters (changes that occurred on exactly one pair).
            After bulk-accepting common patterns, this is the long tail
            worth careful eyes.
          </p>
          {data && (
            <p className="clusters-page__summary">
              {anomalies.length} anomal{anomalies.length === 1 ? 'y' : 'ies'} ·{' '}
              {byState.open} open · {byState.accepted} accepted · {byState.rejected} rejected
            </p>
          )}
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {data && anomalies.length === 0 && (
        <p className="clusters-page__empty">
          No singleton clusters in this session. (Once you bulk-accept the
          broad changes, the remaining ones will surface here.)
        </p>
      )}

      {anomalies.length > 0 && (
        <ul className="anomaly-list">
          {anomalies.map((a) => (
            <li key={a.id} className={`anomaly-row anomaly-row--${a.review_state}`}>
              <Link to={`/sessions/${id}/clusters/${a.id}`} className="anomaly-row__link">
                <span className={`anomaly-row__sev anomaly-row__sev--${a.sample?.severity ?? 'unknown'}`}>
                  {a.sample?.severity ?? '—'}
                </span>
                <span className="anomaly-row__tags">
                  <code>{a.region_role ?? '—'}</code>{' / '}
                  <code>{a.change_type ?? '—'}</code>{' / '}
                  <code>{a.element_label ?? '(unlabelled)'}</code>
                </span>
                <span className="anomaly-row__description">
                  {a.sample?.description ?? '—'}
                </span>
                <span className="anomaly-row__url">
                  {a.sample?.url_a ?? ''}
                </span>
                <span className={`anomaly-row__state cluster-row__state cluster-row__state--${a.review_state}`}>
                  {a.review_state}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
