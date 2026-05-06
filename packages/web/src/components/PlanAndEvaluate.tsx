import { useEffect, useRef, useState, type JSX } from 'react';
import { api } from '../api/client.js';
import type { EvaluationStatusDto, SessionResultsDto } from '@visual-compare/api/types';

interface Props {
  sessionId: string;
  results: SessionResultsDto | null;
  onEvaluationComplete: () => void;
}

const POLL_INTERVAL_MS = 1500;

/**
 * Plan summary card and Evaluate button. Shows what's missing from the
 * cache so the cost of pressing Evaluate is visible up-front. While an
 * evaluation is in flight, polls until status flips to complete/error and
 * triggers `onEvaluationComplete` so the parent can refresh /results.
 */
export function PlanAndEvaluate({
  sessionId,
  results,
  onEvaluationComplete,
}: Props): JSX.Element {
  const [evaluation, setEvaluation] = useState<EvaluationStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, []);

  const startPolling = (evaluationId: string) => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      try {
        const res = await api.getEvaluation(evaluationId);
        setEvaluation(res.evaluation);
        if (res.evaluation.status === 'complete' || res.evaluation.status === 'error') {
          if (pollRef.current !== null) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
          }
          onEvaluationComplete();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, POLL_INTERVAL_MS);
  };

  const click = async () => {
    setError(null);
    try {
      const res = await api.evaluate(sessionId);
      const initial = await api.getEvaluation(res.evaluation_id);
      setEvaluation(initial.evaluation);
      if (initial.evaluation.status === 'complete' || initial.evaluation.status === 'error') {
        onEvaluationComplete();
      } else {
        startPolling(res.evaluation_id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const captureMisses = results?.plan.capture_misses ?? null;
  const comparisonMisses = results?.plan.comparison_misses ?? null;
  const cacheHits = results?.plan.cache_hits;
  const enabledPairs = results?.plan.enabled_pair_count ?? 0;
  const allCached =
    captureMisses !== null && comparisonMisses !== null && captureMisses === 0 && comparisonMisses === 0;
  const isRunning = evaluation?.status === 'running' || evaluation?.status === 'pending';
  const buttonLabel = isRunning
    ? 'Evaluating…'
    : allCached
      ? 'All cached'
      : captureMisses !== null && comparisonMisses !== null
        ? `Evaluate (${captureMisses} captures, ${comparisonMisses} comparisons missing)`
        : 'Evaluate';

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Evaluate</h3>
      {error && <div className="error">{error}</div>}

      {results ? (
        <p className="muted" style={{ marginTop: 0 }}>
          {enabledPairs} pair{enabledPairs === 1 ? '' : 's'} enabled
          {cacheHits ? ` · cache hits: captures ${cacheHits.captures}, pixel ${cacheHits.pixel}, lm ${cacheHits.lm}` : ''}
        </p>
      ) : (
        <p className="muted">Loading plan…</p>
      )}

      <button
        className="btn"
        onClick={() => void click()}
        disabled={isRunning || !results || allCached}
      >
        {buttonLabel}
      </button>

      {evaluation && (
        <p className="muted" style={{ marginTop: 8 }}>
          {evaluation.status === 'error'
            ? `Errored: ${evaluation.error_message ?? 'unknown'}`
            : evaluation.status === 'complete'
              ? `Last evaluation: complete · cache hits captures ${evaluation.cache_hits.captures}, pixel ${evaluation.cache_hits.pixel}, lm ${evaluation.cache_hits.lm}`
              : `Status: ${evaluation.status}…`}
        </p>
      )}
    </div>
  );
}
