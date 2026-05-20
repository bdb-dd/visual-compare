import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { api, type ReviewDashboardDto } from '../api/client.js';
import { useVisiblePolling } from './useVisiblePolling.js';

/**
 * One poll per session, distributed via context. Consolidates what used
 * to be three independent pollers — evaluation status (1.5s),
 * results-delta (5s), capture-eta (2.5s) — into a single request the
 * provider fires at the fastest cadence any consumer cares about.
 *
 * The provider holds the latest aggregate snapshot in state and exposes
 * it through `useReviewDashboard`. Child components (PlanAndEvaluate,
 * SessionResultsList, ClusterDetailPanel, ComparisonDetail, etc.) read
 * the slices they need without re-polling.
 *
 * Cursor + last-seen evaluation id are kept in refs so the polling
 * effect doesn't restart on every tick — the next request carries the
 * latest cursor without re-arming the timer.
 */

export interface ReviewDashboardSnapshot {
  data: ReviewDashboardDto | null;
  /** True until the first successful response lands. */
  loading: boolean;
  /** Last error message (transient — cleared on next successful tick). */
  error: string | null;
  /**
   * Tell the provider about a fresh evaluation id (e.g., the user just
   * clicked Evaluate). The next poll includes `?eval=<id>` so the
   * dashboard always tracks the right one.
   */
  trackEvaluation(id: string | null): void;
  /** Force-refresh outside the normal cadence. */
  refresh(): Promise<void>;
}

const ReviewDashboardContext = createContext<ReviewDashboardSnapshot | null>(null);

const FAST_POLL_MS = 1_500;

export function ReviewDashboardProvider({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}): JSX.Element {
  const [data, setData] = useState<ReviewDashboardDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Refs so the polling effect doesn't restart per render.
  const cursorRef = useRef<string | null>(null);
  const trackedEvalRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const since = cursorRef.current ?? undefined;
      const evaluationId = trackedEvalRef.current ?? undefined;
      const res = await api.getReviewDashboard(sessionId, { since, evaluationId });
      // Advance the cursor for the next tick — once set, the dashboard
      // always returns results_delta.
      if (res.results_delta?.cursor) {
        cursorRef.current = res.results_delta.cursor;
      } else if (cursorRef.current === null) {
        cursorRef.current = new Date().toISOString();
      }
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Self-pacing background poll: pauses when tab is hidden, waits for
  // each request to settle before scheduling the next, fires immediately
  // on tab return.
  useVisiblePolling(refresh, FAST_POLL_MS, !!sessionId);

  const trackEvaluation = useCallback((id: string | null) => {
    trackedEvalRef.current = id;
  }, []);

  const value = useMemo<ReviewDashboardSnapshot>(
    () => ({ data, loading, error, trackEvaluation, refresh }),
    [data, loading, error, trackEvaluation, refresh],
  );

  return (
    <ReviewDashboardContext.Provider value={value}>
      {children}
    </ReviewDashboardContext.Provider>
  );
}

/**
 * Read the latest dashboard snapshot. Returns null when used outside a
 * provider (e.g., during initial mount or in components rendered for a
 * non-session context) — callers must handle the null case.
 */
export function useReviewDashboard(): ReviewDashboardSnapshot | null {
  return useContext(ReviewDashboardContext);
}

/**
 * Selector for the capture-eta map. Returns an empty Map when the
 * dashboard isn't ready or capture-eta has no in-flight members.
 */
export function useReviewCaptureEta(): Map<string, { eta_ms: number; rank: number; sides: ('a' | 'b')[] }> {
  const snap = useReviewDashboard();
  return useMemo(() => {
    if (!snap?.data?.capture_eta?.members) return new Map();
    return new Map(Object.entries(snap.data.capture_eta.members));
  }, [snap?.data?.capture_eta]);
}
