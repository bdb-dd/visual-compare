import { useCallback, useMemo, useRef } from 'react';
import type { UIEvent } from 'react';

/**
 * Mirrors scrollTop / scrollLeft across N peer elements. Used by
 * ComparisonDetail (split mode, 2 panes) and ClusterDetailPanel
 * (triple/ab modes, 2–3 panes) so a single scroll gesture moves all
 * panes together.
 *
 * Leader-lock pattern: the first element to fire onScroll becomes the
 * leader for `LEADER_TTL_MS`. While locked, scroll events from other
 * elements are ignored — they're our own programmatic scrolls echoing
 * back. The timer is reset on every leader event so a continuous gesture
 * keeps ownership; after the gesture ends, the lock releases and any
 * pane can become the new leader.
 *
 * The hook is a no-op when `count` is 0 or 1.
 */
const LEADER_TTL_MS = 100;

export interface SyncedScroll {
  /** Stable ref callbacks per pane index. Apply as `ref={refs[i]}`. */
  refs: Array<(el: HTMLElement | null) => void>;
  /** Shared scroll handler. Apply as `onScroll={onScroll}` on every pane. */
  onScroll: (e: UIEvent<HTMLElement>) => void;
}

export function useSyncedScroll(count: number): SyncedScroll {
  const els = useRef<Array<HTMLElement | null>>([]);
  const leader = useRef<HTMLElement | null>(null);
  const leaderTimer = useRef<number | null>(null);

  const onScroll = useCallback((e: UIEvent<HTMLElement>): void => {
    const src = e.currentTarget;
    if (leader.current && leader.current !== src) return;
    leader.current = src;
    if (leaderTimer.current !== null) window.clearTimeout(leaderTimer.current);
    leaderTimer.current = window.setTimeout(() => {
      leader.current = null;
      leaderTimer.current = null;
    }, LEADER_TTL_MS);
    for (const el of els.current) {
      if (!el || el === src) continue;
      if (el.scrollTop !== src.scrollTop) el.scrollTop = src.scrollTop;
      if (el.scrollLeft !== src.scrollLeft) el.scrollLeft = src.scrollLeft;
    }
  }, []);

  // Pre-create stable ref callbacks per index so React doesn't churn them
  // every render (a fresh callback fires the ref with null first, then the
  // element — extra work for nothing). Regenerates only when count changes,
  // e.g. switching from ab (2) to triple (3) view.
  const refs = useMemo<Array<(el: HTMLElement | null) => void>>(() => {
    els.current = new Array(count).fill(null);
    return Array.from({ length: count }, (_, i) => (el: HTMLElement | null) => {
      els.current[i] = el;
    });
  }, [count]);

  return { refs, onScroll };
}
