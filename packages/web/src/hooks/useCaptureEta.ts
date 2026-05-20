import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

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
 * Returns a stable Map reference per response. Lookup keys are
 * `${url_pair_id}::${viewport_name}`. Empty Map = nothing in flight.
 */
export function useCaptureEta(
  sessionId: string | null,
  active: boolean,
): Map<string, MemberEta> {
  const [members, setMembers] = useState<Map<string, MemberEta>>(() => new Map());
  // Track liveness so we don't setState after unmount or after the
  // hook is told to stop polling mid-request.
  const liveRef = useRef(true);

  useEffect(() => {
    liveRef.current = true;
    if (!sessionId || !active) {
      setMembers(new Map());
      return () => {
        liveRef.current = false;
      };
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await api.getCaptureEta(sessionId);
        if (cancelled) return;
        const next = new Map<string, MemberEta>();
        for (const [key, val] of Object.entries(res.members)) next.set(key, val);
        setMembers(next);
      } catch {
        // Swallow transient errors; the next tick will try again.
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
        }
      }
    };

    void tick();

    return () => {
      cancelled = true;
      liveRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, active]);

  return members;
}
