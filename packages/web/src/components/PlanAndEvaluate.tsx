import { useEffect, useRef, useState, type JSX } from 'react';
import { api } from '../api/client.js';
import type { EvaluationStatusDto, SessionResultsDto } from '@visual-compare/api/types';
import { PromptConfigPanel } from './PromptConfigPanel.js';

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
  const [promptPanelOpen, setPromptPanelOpen] = useState(false);
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
        if (res.evaluation.status === 'complete' || res.evaluation.status === 'error') {
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
    startPolling(latestEvaluation.id);
    // intentional: don't depend on `evaluation` (avoid restart loops); we
    // only adopt once per latestEvaluation id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestEvaluation?.id, latestEvaluation?.status]);

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
  const progress = evaluation?.progress ?? null;
  const runningLabel = progress
    ? `Evaluating ${progress.phase === 'capture' ? 'captures' : 'comparisons'}… ${progress.current}/${progress.total}`
    : 'Evaluating…';
  const buttonLabel = isRunning
    ? runningLabel
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
        <button
          type="button"
          className="btn secondary"
          onClick={() => setPromptPanelOpen((o) => !o)}
          title="Tune the LM prompt — toggles, house rules, advanced raw-text editor."
        >
          {promptPanelOpen ? 'Hide LM prompt' : 'Configure LM prompt…'}
        </button>
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
      {promptPanelOpen && (
        <PromptConfigPanel sessionId={sessionId} onClose={() => setPromptPanelOpen(false)} />
      )}
    </>
  );
}
