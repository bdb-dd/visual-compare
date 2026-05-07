import { useEffect, useRef, useState, type JSX } from 'react';
import { api } from '../api/client.js';
import type { EvaluationStatusDto, SessionResultsDto } from '@visual-compare/api/types';

interface Props {
  sessionId: string;
  results: SessionResultsDto | null;
  /** Whether to run the LM second pass on target-level misses. Lifted to the parent so the plan can reflect LM-cache misses. */
  invokeLm: boolean;
  onInvokeLmChange: (next: boolean) => void;
  onEvaluationComplete: () => void;
}

const POLL_INTERVAL_MS = 1500;

/**
 * The Evaluate button + a single status line. Used in the project header
 * strip; the button label carries the plan summary so a separate card
 * isn't needed. Polls the in-flight evaluation until it terminates and
 * fires `onEvaluationComplete` so the parent can refresh `/results`.
 */
export function PlanAndEvaluate({
  sessionId,
  results,
  invokeLm,
  onInvokeLmChange,
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
      const res = await api.evaluate(sessionId, invokeLm ? { invoke_lm: true } : undefined);
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
  const allCached =
    captureMisses !== null && comparisonMisses !== null && captureMisses === 0 && comparisonMisses === 0;
  const isRunning = evaluation?.status === 'running' || evaluation?.status === 'pending';
  const buttonLabel = isRunning
    ? 'Evaluating…'
    : allCached
      ? 'All cached'
      : captureMisses !== null && comparisonMisses !== null
        ? `Evaluate (${captureMisses} captures · ${comparisonMisses} comparisons missing)`
        : 'Evaluate';

  return (
    <div className="evaluate-control">
      <button
        className="btn primary"
        onClick={() => void click()}
        disabled={isRunning || !results || allCached}
      >
        {buttonLabel}
      </button>
      <label
        className="muted evaluate-lm-toggle"
        title="Invoke LM Studio as a second pass on comparisons that miss the target level."
      >
        <input
          type="checkbox"
          checked={invokeLm}
          onChange={(e) => onInvokeLmChange(e.target.checked)}
          disabled={isRunning}
        />{' '}
        LM second pass
      </label>
      {(error || evaluation) && (
        <p className="muted evaluate-status">
          {error
            ? `Error: ${error}`
            : evaluation?.status === 'error'
              ? `Errored: ${evaluation.error_message ?? 'unknown'}`
              : evaluation?.status === 'complete'
                ? 'Evaluation complete'
                : `Status: ${evaluation?.status ?? ''}…`}
        </p>
      )}
    </div>
  );
}
