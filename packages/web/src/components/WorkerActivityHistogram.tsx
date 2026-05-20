import { type JSX } from 'react';
import { useSystemStatus } from '../hooks/useSystemStatus.js';

/**
 * Compact sparkline of in-flight capture + comparison work over the last
 * few minutes. Mirrors `LmActivityHistogram` exactly — same cadence, same
 * bar layout — so the two indicators sit next to each other in the
 * session header and read consistently. Reads from the shared
 * `SystemStatusProvider` snapshot, so no per-component polling.
 */
export function WorkerActivityHistogram(): JSX.Element | null {
  const snap = useSystemStatus();
  const data = snap?.data?.worker_activity ?? null;
  const errored = !!snap?.error;

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
