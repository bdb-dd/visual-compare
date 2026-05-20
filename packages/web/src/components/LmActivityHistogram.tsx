import { useEffect, useState, type JSX } from 'react';
import { api, type LmActivityDto } from '../api/client.js';
import { useVisiblePolling } from '../hooks/useVisiblePolling.js';

/**
 * Compact sparkline of in-flight LM `analyze` calls over the last few
 * minutes. Each bar = one sample; height = sample / parallel (clamped to
 * 1.0). Lives next to the LM status pill in the session header so an
 * operator can immediately see whether the GPU is being exercised.
 *
 * The server tracks concurrency directly (we broker every call), so this
 * is GPU-faithful for our single-tenant LM Studio deployment — see the
 * server-side comment in services/lm-activity.ts for the caveat.
 */
export interface LmActivityHistogramProps {
  /** Override the poll cadence in ms. Default: trust server's interval_ms. */
  pollMs?: number;
}

export function LmActivityHistogram(_props: LmActivityHistogramProps = {}): JSX.Element | null {
  const [data, setData] = useState<LmActivityDto | null>(null);
  const [errored, setErrored] = useState(false);

  const fetchOnce = async () => {
    try {
      const next = await api.getLmActivity();
      setData(next);
      setErrored(false);
    } catch {
      setErrored(true);
    }
  };

  useEffect(() => {
    void fetchOnce();
  }, []);

  // Re-poll at the server's cadence so each new sample shows up exactly
  // once. Default 4 s falls back if the server didn't ship a value.
  // Polling pauses when the tab is hidden via useVisiblePolling.
  const interval = _props.pollMs ?? data?.interval_ms ?? 4000;
  useVisiblePolling(fetchOnce, interval);

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
