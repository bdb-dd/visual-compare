import { useEffect, useMemo, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import type {
  ClusterListDto,
  ClusterSummaryDto,
} from '@visual-compare/api/types';

/**
 * Anomaly queue body — singleton clusters (pair_count = 1) gathered into
 * a flat, severity-sorted list. Extracted from `pages/AnomaliesPage.tsx`
 * in Phase α so it can be reused inside `SessionDetailPage`'s mode-tab
 * strip in Phase β.
 *
 * Behaviour is identical to the previous AnomaliesPage body. The page
 * shell keeps only the back-link + heading; everything that depends on
 * fetched data lives here.
 */

function severityRank(s: string | null | undefined): number {
  switch (s) {
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

export interface AnomaliesTabProps {
  sessionId: string;
}

export function AnomaliesTab({ sessionId }: AnomaliesTabProps): JSX.Element {
  const [data, setData] = useState<ClusterListDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api.listClusters(sessionId)
      .then((dto) => { if (!cancelled) setData(dto); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [sessionId]);

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
    <>
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
              <Link to={`/sessions/${sessionId}/clusters/${a.id}`} className="anomaly-row__link">
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
    </>
  );
}
