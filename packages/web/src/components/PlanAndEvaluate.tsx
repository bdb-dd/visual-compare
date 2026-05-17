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
  /**
   * Most-recent evaluation surfaced by the parent. When the page loads
   * mid-run the user expects to see the button reflect that — without this
   * prop, local `evaluation` would start null and the idle label would show
   * until the user re-triggered. Adopting the in-flight one here reattaches
   * polling automatically.
   */
  latestEvaluation?: EvaluationStatusDto | null;
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
  latestEvaluation,
}: Props): JSX.Element {
  const [evaluation, setEvaluation] = useState<EvaluationStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True between the moment the user clicks Stop and the orchestrator
  // settling the row to `cancelled`. Drives the "Stopping…" label so the
  // button can't be clicked twice. Reset on every fresh evaluation.
  const [stopRequested, setStopRequested] = useState(false);
  const pollRef = useRef<number | null>(null);
  const onCompleteRef = useRef(onEvaluationComplete);
  onCompleteRef.current = onEvaluationComplete;

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
        if (
          res.evaluation.status === 'complete' ||
          res.evaluation.status === 'error' ||
          res.evaluation.status === 'cancelled'
        ) {
          if (pollRef.current !== null) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
          }
          onCompleteRef.current();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, POLL_INTERVAL_MS);
  };

  // Adopt an in-flight evaluation surfaced by the parent. Fires when:
  //   1. Page loads mid-run — local `evaluation` is null, parent's
  //      `latestEvaluation` is running/pending → adopt + start polling.
  //   2. The evaluations list re-fetches and the latest one is still running
  //      while we don't have local state for it (e.g. user landed on a
  //      different session and came back).
  // We deliberately don't override an evaluation we already track locally —
  // the user-initiated path (`click()`) is authoritative for the current
  // session.
  useEffect(() => {
    if (!latestEvaluation) return;
    if (evaluation && evaluation.id === latestEvaluation.id) return;
    const isLive =
      latestEvaluation.status === 'running' || latestEvaluation.status === 'pending';
    if (!isLive) return;
    setEvaluation(latestEvaluation);
    setStopRequested(false);
    startPolling(latestEvaluation.id);
    // intentional: don't depend on `evaluation` (avoid restart loops); we
    // only adopt once per latestEvaluation id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestEvaluation?.id, latestEvaluation?.status]);

  const click = async () => {
    setError(null);
    setStopRequested(false);
    try {
      const res = await api.evaluate(sessionId, invokeLm ? { invoke_lm: true } : undefined);
      const initial = await api.getEvaluation(res.evaluation_id);
      setEvaluation(initial.evaluation);
      if (
        initial.evaluation.status === 'complete' ||
        initial.evaluation.status === 'error' ||
        initial.evaluation.status === 'cancelled'
      ) {
        onEvaluationComplete();
      } else {
        startPolling(res.evaluation_id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const stop = async () => {
    if (!evaluation) return;
    setError(null);
    setStopRequested(true);
    try {
      const res = await api.cancelEvaluation(evaluation.id);
      // The orchestrator marks the row `cancelled` once in-flight work
      // settles, which can take seconds. Reflect whatever the server returned
      // now; polling will reconcile when the row flips.
      setEvaluation(res.evaluation);
    } catch (err) {
      setStopRequested(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const captureMisses = results?.plan.capture_misses ?? null;
  const comparisonMisses = results?.plan.comparison_misses ?? null;
  const allCached =
    captureMisses !== null && comparisonMisses !== null && captureMisses === 0 && comparisonMisses === 0;
  const isRunning = evaluation?.status === 'running' || evaluation?.status === 'pending';
  const isStopping = isRunning && stopRequested;
  const progress = evaluation?.progress ?? null;
  // Single-button label rotates through three modes: stopping (after Stop
  // click, while in-flight work drains), running (active eval), idle (the
  // resume case is just the misses-count idle label — clicking it
  // re-evaluates and the planner skips cached work).
  const buttonLabel = isStopping
    ? progress
      ? `Stopping… ${progress.current}/${progress.total}`
      : 'Stopping…'
    : isRunning
      ? progress
        ? `Stop (${progress.phase === 'capture' ? 'captures' : 'comparisons'} ${progress.current}/${progress.total})`
        : 'Stop'
      : allCached
        ? 'All cached'
        : captureMisses !== null && comparisonMisses !== null
          ? `Evaluate (${captureMisses} captures · ${comparisonMisses} comparisons missing)`
          : 'Evaluate';

  return (
    <>
      <div className="evaluate-control">
        <button
          className="btn primary"
          onClick={() => void (isRunning ? stop() : click())}
          disabled={isStopping || (!isRunning && (!results || allCached))}
          title={
            isRunning
              ? 'Stop dispatching new work. In-flight tasks finish; click Evaluate again to resume — cached work is skipped.'
              : undefined
          }
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
                  : evaluation?.status === 'cancelled'
                    ? 'Evaluation stopped'
                    : `Status: ${evaluation?.status ?? ''}…`}
          </p>
        )}
      </div>
    </>
  );
}
