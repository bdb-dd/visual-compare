import { useEffect, useRef, useState, type JSX } from 'react';
import { api } from '../api/client.js';
import type { EvaluationStatusDto, SessionResultsDto } from '@visual-compare/api/types';
import { useReviewDashboard } from '../hooks/useReviewDashboard.js';

interface Props {
  sessionId: string;
  results: SessionResultsDto | null;
  onEvaluationComplete: () => void;
}

/**
 * The Evaluate button + a single status line. Used in the project header
 * strip; the button label carries the plan summary so a separate card
 * isn't needed. Reads evaluation state from the per-session
 * `ReviewDashboardProvider` (no local polling) and fires
 * `onEvaluationComplete` once when the tracked eval reaches a terminal
 * state.
 */
export function PlanAndEvaluate({
  sessionId,
  results,
  onEvaluationComplete,
}: Props): JSX.Element {
  const dashboard = useReviewDashboard();
  // Optimistic state for the moment between click() resolving and the
  // dashboard's next poll catching up. Once the dashboard reports the
  // same id we clear this and read from the snapshot exclusively.
  const [localEval, setLocalEval] = useState<EvaluationStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True between the moment the user clicks Stop and the orchestrator
  // settling the row to `cancelled`. Drives the "Stopping…" label so the
  // button can't be clicked twice. Reset on every fresh evaluation.
  const [stopRequested, setStopRequested] = useState(false);
  const onCompleteRef = useRef(onEvaluationComplete);
  onCompleteRef.current = onEvaluationComplete;

  // The dashboard's evaluation overrides local once it catches up.
  const dashboardEval = dashboard?.data?.evaluation ?? null;
  const evaluation =
    localEval && dashboardEval?.id !== localEval.id ? localEval : dashboardEval ?? localEval;

  // Once the dashboard returns the locally-tracked eval, drop the
  // optimistic copy.
  useEffect(() => {
    if (localEval && dashboardEval?.id === localEval.id) {
      setLocalEval(null);
    }
  }, [localEval, dashboardEval?.id]);

  // Fire onComplete once per terminal evaluation id.
  const lastNotifiedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!evaluation) return;
    const terminal =
      evaluation.status === 'complete' ||
      evaluation.status === 'error' ||
      evaluation.status === 'cancelled';
    if (!terminal) return;
    if (lastNotifiedIdRef.current === evaluation.id) return;
    lastNotifiedIdRef.current = evaluation.id;
    onCompleteRef.current();
  }, [evaluation?.id, evaluation?.status]);

  const click = async () => {
    setError(null);
    setStopRequested(false);
    try {
      // invoke_lm comes from session config (set in the Config tab). The
      // server defaults it from `session.default_invoke_lm` when not
      // provided here.
      const res = await api.evaluate(sessionId);
      const initial = await api.getEvaluation(res.evaluation_id);
      setLocalEval(initial.evaluation);
      // No standalone poller — the ReviewDashboardProvider's next tick
      // will deliver the same evaluation_id, after which `localEval`
      // clears and we read from the shared snapshot.
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
      // Optimistically reflect the cancel; the dashboard catches up
      // on its next tick and replaces this with the canonical row.
      setLocalEval(res.evaluation);
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
