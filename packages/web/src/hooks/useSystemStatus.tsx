import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { api, type SystemStatusDto } from '../api/client.js';
import { useVisiblePolling } from './useVisiblePolling.js';

/**
 * App-level provider that polls `/api/meta/system-status` (lm + lm
 * activity + worker activity) on a single cadence and exposes the
 * snapshot to all consumers via context. Replaces three independent
 * polls from `LmStatusPill`, `LmActivityHistogram`, and
 * `WorkerActivityHistogram`.
 *
 * Cadence is the fastest the chrome cared about (4s for the activity
 * sparklines). The LM status pill used to poll at 30s; over-polling it
 * here is cheap because the server-side preflight has its own 30s
 * cache and the response is small.
 */

const POLL_INTERVAL_MS = 5_000;

export interface SystemStatusSnapshot {
  data: SystemStatusDto | null;
  loading: boolean;
  error: string | null;
  /** Force-refresh, bypassing the LM preflight's 30s server cache. */
  forceRefresh(): Promise<void>;
}

const SystemStatusContext = createContext<SystemStatusSnapshot | null>(null);

export function SystemStatusProvider({ children }: { children: ReactNode }): JSX.Element {
  const [data, setData] = useState<SystemStatusDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(async (force = false) => {
    try {
      const res = await api.getSystemStatus(force);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useVisiblePolling(() => fetchOnce(false), POLL_INTERVAL_MS);

  const value = useMemo<SystemStatusSnapshot>(
    () => ({ data, loading, error, forceRefresh: () => fetchOnce(true) }),
    [data, loading, error, fetchOnce],
  );

  return (
    <SystemStatusContext.Provider value={value}>{children}</SystemStatusContext.Provider>
  );
}

export function useSystemStatus(): SystemStatusSnapshot | null {
  return useContext(SystemStatusContext);
}
