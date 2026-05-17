import { useEffect, useState, type JSX } from 'react';
import { api, type WorkerActivityDto } from '../api/client.js';

/**
 * Compact sparkline of in-flight capture + comparison work over the last
 * few minutes. Mirrors `LmActivityHistogram` exactly — same cadence, same
 * bar layout — so the two indicators sit next to each other in the
 * session header and read consistently.
 *
 * Stays correct after the Phase 6 worker pool lands: at that point the
 * /api/meta/worker-activity endpoint serves data aggregated from the
 * pool's telemetry instead of in-process `createLimit` calls, but the
 * DTO shape is unchanged.
 */
export interface WorkerActivityHistogramProps {
  /** Override the poll cadence in ms. Default: trust server's interval_ms. */
  pollMs?: number;
}

export function WorkerActivityHistogram(
  _props: WorkerActivityHistogramProps = {},
): JSX.Element | null {
  const [data, setData] = useState<WorkerActivityDto | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const next = await api.getWorkerActivity();
        if (cancelled) return;
        setData(next);
        setErrored(false);
      } catch {
        if (cancelled) return;
        setErrored(true);
      }
    };
    void fetchOnce();
    const interval = _props.pollMs ?? data?.interval_ms ?? 4000;
    const t = setInterval(() => { void fetchOnce(); }, interval);
    return () => { cancelled = true; clearInterval(t); };
  }, [_props.pollMs, data?.interval_ms]);

  if (errored || !data || data.samples.length === 0 || data.capacity <= 0) {
    return null;
  }

  const capacity = data.capacity;
  const intervalSec = Math.round((data.interval_ms ?? 4000) / 1000);
  const windowSec = data.samples.length * intervalSec;
  const peak = data.samples.reduce((m, n) => (n > m ? n : m), 0);
  const tooltip =
    `CPU workers — last ${windowSec}s, sampled every ${intervalSec}s.\n` +
    `capacity: ${capacity}. peak in window: ${peak}.`;

  return (
    <span
      className="lm-activity worker-activity"
      title={tooltip}
      aria-label="Capture/comparison worker activity over last 2 minutes"
    >
      {data.samples.map((s, i) => {
        const ratio = Math.min(1, Math.max(0, s / capacity));
        const heightPct = Math.max(2, Math.round(ratio * 100));
        const cls = s === 0 ? 'idle' : ratio >= 0.5 ? 'high' : 'low';
        return (
          <span
            key={i}
            className={`lm-activity__bar lm-activity__bar--${cls}`}
            style={{ height: `${heightPct}%` }}
          />
        );
      })}
    </span>
  );
}
