import { useEffect, useRef, useState, type JSX } from 'react';
import { api } from '../api/client.js';
import type { EvaluationStatusDto, SessionResultsDto } from '@visual-compare/api/types';

interface Props {
  sessionId: string;
  results: SessionResultsDto | null;
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
      // Skip network round-trip while the tab is hidden — the next visible
      // tick will catch up. Cuts background load to ~0 for forgotten tabs.
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
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
      // invoke_lm comes from session config (set in the Config tab). The
      // server defaults it from `session.default_invoke_lm` when not
      // provided here.
      const res = await api.evaluate(sessionId);
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
          className={`btn ${isRunning ? 'secondary' : 'primary'}`}
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
      {isRunning && progress && (
        <EvaluationMetrics evaluationId={evaluation!.id} progress={progress} />
      )}
    </>
  );
}

/**
 * Total / Remaining / Speed / ETA strip shown only while an evaluation is
 * running. Maintains a rolling sample buffer (last ~30s) of progress
 * updates so speed reflects current throughput, not the whole-run average.
 *
 * Sample buffer resets on:
 *   - evaluation id change (a different run)
 *   - phase change (capture → comparison have different totals/items)
 *
 * Speed reads samples in the most recent phase only; ETA = remaining /
 * speed. Both show "—" until there are at least two distinct samples.
 */
type Phase = 'capture' | 'comparison';
interface ProgressSample {
  ts: number;
  current: number;
  phase: Phase;
}

const SPEED_WINDOW_MS = 30_000;

function EvaluationMetrics({
  evaluationId,
  progress,
}: {
  evaluationId: string;
  progress: { phase: Phase; current: number; total: number };
}): JSX.Element {
  const [samples, setSamples] = useState<ProgressSample[]>([]);

  // Reset the buffer when the evaluation changes — different run, no
  // continuity. Phase changes are handled in the sampling effect below.
  useEffect(() => {
    setSamples([]);
  }, [evaluationId]);

  useEffect(() => {
    const now = Date.now();
    setSamples((prev) => {
      const lastPhase = prev[prev.length - 1]?.phase;
      const base = lastPhase && lastPhase !== progress.phase ? [] : prev;
      const next: ProgressSample[] = [
        ...base,
        { ts: now, current: progress.current, phase: progress.phase },
      ];
      // Trim entries older than the speed window.
      const cutoff = now - SPEED_WINDOW_MS;
      return next.filter((s) => s.ts >= cutoff);
    });
  }, [progress.current, progress.phase]);

  const remaining = Math.max(0, progress.total - progress.current);
  // Speed and ETA are computed only from same-phase samples; the buffer
  // resets on phase change so any sample in it is in the active phase.
  let speed = 0;
  if (samples.length >= 2) {
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    const elapsedSec = (last.ts - first.ts) / 1000;
    const itemsDone = last.current - first.current;
    if (elapsedSec > 0 && itemsDone > 0) {
      speed = itemsDone / elapsedSec;
    }
  }
  const etaSec = speed > 0 ? remaining / speed : null;

  return (
    <div className="evaluation-metrics" role="status" aria-live="polite">
      <span className="evaluation-metrics__phase">{progress.phase}</span>
      <Metric label="total" value={progress.total.toString()} />
      <Metric label="remaining" value={remaining.toString()} />
      <Metric label="speed" value={speed > 0 ? `${speed.toFixed(1)}/s` : '—'} />
      <Metric label="ETA" value={etaSec !== null && Number.isFinite(etaSec) ? formatEta(etaSec) : '—'} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <span className="evaluation-metrics__item">
      <span className="evaluation-metrics__label">{label}</span>
      <span className="evaluation-metrics__value">{value}</span>
    </span>
  );
}

function formatEta(seconds: number): string {
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  return `${h}h ${mr.toString().padStart(2, '0')}m`;
}
