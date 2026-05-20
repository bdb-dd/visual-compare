import { type JSX } from 'react';
import { useSystemStatus } from '../hooks/useSystemStatus.js';

/**
 * Compact sparkline of in-flight LM `analyze` calls over the last few
 * minutes. Each bar = one sample; height = sample / parallel (clamped to
 * 1.0). Lives next to the LM status pill in the session header so an
 * operator can immediately see whether the GPU is being exercised.
 *
 * Reads from the shared `SystemStatusProvider` snapshot — no per-
 * component polling. The server tracks concurrency directly (we broker
 * every call), so this is GPU-faithful for our single-tenant LM Studio
 * deployment; see services/lm-activity.ts for the caveat.
 */
export function LmActivityHistogram(): JSX.Element | null {
  const snap = useSystemStatus();
  const data = snap?.data?.lm_activity ?? null;
  const errored = !!snap?.error;

  if (errored || !data || data.samples.length === 0 || data.parallel <= 0) {
    // Render nothing rather than a confusing empty box. The LM status
    // pill conveys the "LM is up" signal already.
    return null;
  }

  const parallel = data.parallel;
  const intervalSec = Math.round((data.interval_ms ?? 4000) / 1000);
  const windowSec = data.samples.length * intervalSec;
  const peak = data.samples.reduce((m, n) => (n > m ? n : m), 0);
  const tooltip =
    `LM activity — last ${windowSec}s, sampled every ${intervalSec}s.\n` +
    `parallel cap: ${parallel}. peak in window: ${peak}.`;

  return (
    <span className="lm-activity" title={tooltip} aria-label="LM activity over last 2 minutes">
      {data.samples.map((s, i) => {
        // Clamp to [0, 1]. parallel might be 0 in odd configs; we already
        // guard above, but belt-and-braces in case of an in-flight burst
        // that exceeded parallel briefly (LM Studio queues internally).
        const ratio = Math.min(1, Math.max(0, s / parallel));
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
