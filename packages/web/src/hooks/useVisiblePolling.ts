import { useEffect, useRef } from 'react';

/**
 * `setInterval`-style polling that pauses while the tab is hidden and
 * fires once immediately when the tab becomes visible again.
 *
 * Motivation: across the app we run ~6 background pollers (Evaluate
 * status, worker activity, LM activity, LM status, session result deltas,
 * capture ETA). A single forgotten tab still hits the API every few
 * seconds, and a single 502 turns into a tight retry storm because
 * every poller fires its next tick the moment its timer expires. Gating
 * each `setTimeout` chain on `document.visibilityState === 'visible'`
 * collapses the background load to ~0 and gives the upstream room to
 * recover when it's overloaded.
 *
 * Caller passes a callback (kept in a ref internally, so a fresh
 * function reference per render doesn't rearm the timer) plus an
 * interval and an `enabled` flag. When `enabled` flips to false the
 * timer stops and the visibility listener unbinds.
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

    const tick = (): void => {
      if (stopped) return;
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        void cbRef.current();
      }
      timer = setTimeout(tick, intervalMs);
    };

    timer = setTimeout(tick, intervalMs);

    const onVisibilityChange = (): void => {
      if (!stopped && document.visibilityState === 'visible') {
        // Fire immediately on return-to-foreground so the user sees
        // fresh data without waiting out a full interval.
        void cbRef.current();
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
