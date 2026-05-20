import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Thin wrapper around `perf_hooks.monitorEventLoopDelay`. The histogram
 * accumulates lag samples between event-loop ticks; `snapshot()` reads the
 * percentiles and resets so the next interval starts fresh.
 *
 * The point of having this in production code (not just a one-off debug
 * script) is to let us correlate user-visible API latency with EL health:
 * if /healthz takes 500ms during a comparison run, we want to know whether
 * the EL is actually blocked, or whether IM is just hogging CPU at the OS
 * level and Node is getting scheduled out.
 */

export interface EventLoopSnapshot {
  /** Milliseconds. p50 = median lag between scheduled and actual tick. */
  p50: number;
  p99: number;
  /** Worst lag observed in the interval. */
  max: number;
  mean: number;
  stddev: number;
  /** Sample count in the interval — verifies the monitor is running. */
  count: number;
}

export interface EventLoopMonitor {
  start(): void;
  stop(): void;
  /** Snapshot current percentiles, then reset the histogram. */
  snapshot(): EventLoopSnapshot;
}

export interface EventLoopMonitorOptions {
  /**
   * Sampling resolution. Lower = finer-grained percentiles, higher CPU
   * overhead. 10ms is plenty for diagnosing IM-class stalls (we're looking
   * for >100ms blockages).
   */
  resolutionMs?: number;
}

export function createEventLoopMonitor(
  opts: EventLoopMonitorOptions = {},
): EventLoopMonitor {
  const histogram = monitorEventLoopDelay({ resolution: opts.resolutionMs ?? 10 });
  return {
    start: () => histogram.enable(),
    stop: () => histogram.disable(),
    snapshot: () => {
      const snap: EventLoopSnapshot = {
        p50: histogram.percentile(50) / 1e6,
        p99: histogram.percentile(99) / 1e6,
        max: histogram.max / 1e6,
        mean: histogram.mean / 1e6,
        stddev: histogram.stddev / 1e6,
        count: histogram.count,
      };
      histogram.reset();
      return snap;
    },
  };
}

/**
 * Format a snapshot for log output. One line, sortable, greppable.
 */
export function formatSnapshot(snap: EventLoopSnapshot): string {
  const fmt = (n: number) => n.toFixed(1).padStart(7, ' ');
  return (
    `[event-loop] p50=${fmt(snap.p50)}ms ` +
    `p99=${fmt(snap.p99)}ms ` +
    `max=${fmt(snap.max)}ms ` +
    `mean=${fmt(snap.mean)}ms ` +
    `stddev=${fmt(snap.stddev)}ms ` +
    `n=${snap.count}`
  );
}
