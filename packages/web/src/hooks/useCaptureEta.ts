import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useVisiblePolling } from './useVisiblePolling.js';

export interface MemberEta {
  eta_ms: number;
  rank: number;
  sides: ('a' | 'b')[];
}

/** Polling cadence while a capture run is in flight. */
const POLL_INTERVAL_MS = 2_500;

/**
 * Poll `/api/sessions/:id/capture-eta` while `active` is true and return
 * the latest per-`${pair_id}::${viewport_name}` ETA map. Consumers turn
 * on polling when they have at least one stale row/member visible and
 * turn it back off when nothing's stale, so the request doesn't keep
 * running once the recapture is done.
 *
 * Polling pauses when the tab is hidden via `useVisiblePolling` — a
 * forgotten tab won't keep hammering the API.
 *
 * Returns a stable Map reference per response. Lookup keys are
 * `${url_pair_id}::${viewport_name}`. Empty Map = nothing in flight.
 */
export function useCaptureEta(
  sessionId: string | null,
  active: boolean,
): Map<string, MemberEta> {
  const [members, setMembers] = useState<Map<string, MemberEta>>(() => new Map());
  const enabled = !!(sessionId && active);

  useVisiblePolling(
    async () => {
      if (!sessionId) return;
      try {
        const res = await api.getCaptureEta(sessionId);
        const next = new Map<string, MemberEta>();
        for (const [key, val] of Object.entries(res.members)) next.set(key, val);
        setMembers(next);
      } catch {
        // Swallow transient errors; the next tick will try again.
      }
    },
    POLL_INTERVAL_MS,
    enabled,
  );

  // Clear the map when polling switches off so consumers don't show
  // stale ETAs after a recapture finishes.
  useEffect(() => {
    if (!enabled) setMembers(new Map());
  }, [enabled]);

  return members;
}
