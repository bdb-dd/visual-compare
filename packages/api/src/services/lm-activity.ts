/**
 * Rolling histogram of LM concurrency. We track the number of in-flight
 * `LmClient.analyze` calls and sample that count on a fixed interval; the
 * frontend renders the last N samples as a sparkline so an operator can
 * see whether the GPU is actually being exercised during a run.
 *
 * Why not actual GPU%: the GPU lives on a separate VM (Scaleway L40S) and
 * exposing real `nvidia-smi` would require an HTTP daemon on that box.
 * For our single-tenant setup the API VM brokers every LM call, so
 * "concurrent calls / --parallel" is a faithful proxy for GPU saturation.
 * If that diverges from reality we can swap this implementation for a
 * real-GPU agent without changing the public DTO shape.
 */

export interface LmActivitySnapshot {
  /** Oldest-first ring of in-flight counts at sample time. Max sampleCount entries. */
  samples: number[];
  /**
   * LM Studio's `--parallel` cap — the maximum value `samples[i]` should
   * approach when the GPU is fully utilized. Caller (server boot) supplies
   * the value used at load time so the frontend can render `count / parallel`
   * without knowing how the GPU is configured.
   */
  parallel: number;
  /** Sample cadence in ms. Caller renders timestamps from it. */
  interval_ms: number;
}

export interface LmActivityTrackerOptions {
  /** Default 2 — matches the systemd unit's `--parallel 2`. */
  parallel?: number;
  /** Default 4000 ms (sample every 4 s). */
  intervalMs?: number;
  /** Default 30 → last 2 min of history at the 4 s default. */
  sampleCount?: number;
}

export interface LmActivityTracker {
  /** Begin sampling on the configured interval. Idempotent. */
  start(): void;
  /** Stop the sampler. Safe to call repeatedly. */
  stop(): void;
  /**
   * Mark the start of an `analyze` call. Returns a function to call when
   * the analyze resolves (success OR failure). Designed for `try { ... }
   * finally { release(); }` use sites so a thrown error doesn't leak a
   * counted call.
   */
  trackCall(): () => void;
  /** Snapshot the ring buffer for the HTTP endpoint. */
  snapshot(): LmActivitySnapshot;
}

export function createLmActivityTracker(
  options: LmActivityTrackerOptions = {},
): LmActivityTracker {
  const parallel = options.parallel ?? 2;
  const intervalMs = options.intervalMs ?? 4000;
  const sampleCount = options.sampleCount ?? 30;

  let inFlight = 0;
  const samples: number[] = [];
  let timer: NodeJS.Timeout | null = null;

  const sample = (): void => {
    samples.push(inFlight);
    if (samples.length > sampleCount) samples.shift();
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(sample, intervalMs);
      // unref so the timer doesn't keep the process alive during shutdown.
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    trackCall() {
      inFlight += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (inFlight > 0) inFlight -= 1;
      };
    },
    snapshot() {
      return {
        samples: [...samples],
        parallel,
        interval_ms: intervalMs,
      };
    },
  };
}
