import type { JSX } from 'react';
import type { CaptureStatusInfo } from '@visual-compare/api/types';

/**
 * Stale capture badge for a per-side image header. Returns null when the
 * side isn't stale; otherwise renders a small chip describing why:
 *
 *   - `in_progress` — a recapture is in flight; displayed image is the
 *     prior good capture.
 *   - `error` — the latest recapture errored; the prior good capture is
 *     still rendered so the user can see what changed.
 *   - `complete` — a newer completed capture exists under a different
 *     opts_hash (rare; effectively means the displayed image is older
 *     than what would be captured under the current config).
 *
 * Shared by the row-level `ComparisonDetail` panes and the cluster detail
 * panel so badge wording stays in lockstep across surfaces.
 */
export function StaleBadge({
  status,
  etaMs,
}: {
  status: CaptureStatusInfo | undefined;
  /**
   * Optional ETA in milliseconds for when this side's recapture is
   * expected to land. Only rendered when status is `in_progress` —
   * an ETA on an errored capture would be meaningless, and a complete
   * capture isn't waiting for anything. Pass `undefined` to omit the
   * ETA suffix (e.g., when polling hasn't produced a value yet).
   */
  etaMs?: number;
}): JSX.Element | null {
  if (!status?.is_stale) return null;
  const base =
    status.status === 'in_progress'
      ? 'Stale · recapturing'
      : status.status === 'error'
        ? 'Stale · recapture failed'
        : 'Stale';
  const label =
    status.status === 'in_progress' && etaMs !== undefined && etaMs > 0
      ? `${base} (~${formatEta(etaMs)})`
      : base;
  return <span className={`stale-badge stale-badge--${status.status}`}>{label}</span>;
}

function formatEta(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}
