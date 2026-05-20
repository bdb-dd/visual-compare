import { useEffect, useRef } from 'react';

/**
 * Self-pacing background poller that:
 *
 *   1. Pauses while the tab is hidden (no network round-trip).
 *   2. Fires once immediately when the tab returns to the foreground.
 *   3. **Waits for each callback to settle before scheduling the next
 *      tick.** When upstream is slow, the effective cadence backs off
 *      from `intervalMs` to roughly `intervalMs + responseTimeMs` —
 *      so a struggling server doesn't accumulate a backlog of
 *      pending requests behind keep-alive connections.
 *
 * Motivation: across the app we run ~6 background pollers (Evaluate
 * status, worker activity, LM activity, LM status, session result deltas,
 * capture ETA). With `setInterval` each fires on schedule regardless of
 * the previous request's state, so a 502 storm or a 5-second slow
 * response stacks pending requests indefinitely — that's exactly what
 * the network panel showed before this change.
 *
 * Caller passes a callback (kept in a ref so fresh function references
 * per render don't rearm the timer), an interval, and an `enabled`
 * flag. When `enabled` flips to false the loop stops and listeners
 * unbind.
 */
export function useVisiblePolling(
  callback: () => void | Promise<void>,
  intervalMs: number,
  enabled = true,
): void {
  const cbRef = useRef(callback);
  useEffect(() => {
    cbRef.current = callback;
  });

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    const runCallback = async (): Promise<void> => {
      if (inFlight) return; // Belt-and-suspenders against re-entry.
      inFlight = true;
      try {
        await cbRef.current();
      } catch {
        // Swallow — the next tick will try again.
      } finally {
        inFlight = false;
      }
    };

    const tick = async (): Promise<void> => {
      if (stopped) return;
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        await runCallback();
      }
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
    };

    timer = setTimeout(() => void tick(), intervalMs);

    const onVisibilityChange = (): void => {
      if (stopped) return;
      if (document.visibilityState === 'visible') {
        // Fire immediately on return-to-foreground so the user sees
        // fresh data without waiting out a full interval. The in-flight
        // guard means we won't double-fire if the regular tick happens
        // to fire at the same moment.
        void runCallback();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs, enabled]);
}
