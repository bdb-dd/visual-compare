/**
 * Rolling histogram of capture/comparison worker concurrency. Mirrors
 * `lm-activity` but for the CPU-bound work (Playwright captures and
 * ImageMagick comparisons) — together they're the API's main load.
 *
 * Today everything runs in-process and we observe concurrency by wrapping
 * each `limit(...)` callback in `trackCall()`. When Phase 6 lands the
 * worker VM pool, the tracker swaps for an aggregator over the pool's
 * telemetry — the DTO shape stays the same so the frontend doesn't
 * change.
 *
 * `capacity` is the largest concurrency cap observed at runtime: the
 * tracker doesn't know the configured value up front (capture/comparison
 * options can carry different ceilings), so callers call
 * `observeCapacity(n)` whenever they pick a fresh ceiling. The bar
 * heights then read `sample / capacity` for normalization.
 */

export interface WorkerActivitySnapshot {
  /** Oldest-first ring of in-flight counts at sample time. */
  samples: number[];
  /** Observed concurrency ceiling, for rendering bars as a ratio. */
  capacity: number;
  /** Sample cadence in ms. */
  interval_ms: number;
}

export interface WorkerActivityTrackerOptions {
  /** Default 4000 ms (sample every 4 s) — same cadence as the LM tracker. */
  intervalMs?: number;
  /** Default 30 → last 2 min of history at the 4 s default. */
  sampleCount?: number;
  /**
   * Initial capacity floor before any `observeCapacity` calls land.
   * Defaults to availableParallelism() at the call site (see
   * index.ts wiring) so the histogram has a sane scale on a fresh
   * process.
   */
  initialCapacity?: number;
}

export interface WorkerActivityTracker {
  start(): void;
  stop(): void;
  /**
   * Mark the start of a worker call (capture or comparison). Returns
   * a release fn to call when the work resolves. Designed for
   * `try { ... } finally { release(); }` so a thrown error doesn't
   * leak a counted call.
   */
  trackCall(): () => void;
  /**
   * Tell the tracker the largest ceiling currently in play. Idempotent;
   * monotonic upward — capacity only grows during a process lifetime.
   * Keeps the histogram normalisation stable as different runs roll in
   * with different concurrency knobs.
   */
  observeCapacity(n: number): void;
  snapshot(): WorkerActivitySnapshot;
}

export function createWorkerActivityTracker(
  options: WorkerActivityTrackerOptions = {},
): WorkerActivityTracker {
  const intervalMs = options.intervalMs ?? 4000;
  const sampleCount = options.sampleCount ?? 30;
  let capacity = Math.max(1, options.initialCapacity ?? 1);

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
    observeCapacity(n: number) {
      if (Number.isFinite(n) && n > capacity) capacity = n;
    },
    snapshot() {
      return {
        samples: [...samples],
        capacity,
        interval_ms: intervalMs,
      };
    },
  };
}
