import type { JSX } from 'react';
import type { CaptureStatusInfo } from '@visual-compare/api/types';

/**
 * Compact "what's wrong with this pair's captures" chip. Used in the
 * Clusters member list and the Rows list so both surfaces speak the same
 * vocabulary:
 *
 *   - Red `failed (A)` / `failed (B)` / `failed (A+B)` — capture errored
 *     on at least one side. Tooltip surfaces the error message when one
 *     side reports it.
 *   - Yellow `~45s` / `~2m 15s` — at least one side is mid-recapture and
 *     an ETA is known. Worst-side ETA wins (the side gating the eventual
 *     comparison dispatch).
 *   - Yellow `stale` — one side is stale but no ETA is available (the
 *     run hasn't completed enough captures for an average yet).
 *   - Returns `null` when both sides are fresh; consumers omit the cell.
 *
 * Error takes precedence over stale: a pair with one errored side and
 * one pending side still renders as `failed (…)`.
 */

export interface CaptureStatusChipProps {
  statusA: CaptureStatusInfo;
  statusB: CaptureStatusInfo;
  /** Pair-level ETA from useCaptureEta; ignored on errored pairs. */
  etaMs?: number;
}

export function CaptureStatusChip({
  statusA,
  statusB,
  etaMs,
}: CaptureStatusChipProps): JSX.Element | null {
  const aErr = statusA.status === 'error';
  const bErr = statusB.status === 'error';
  if (aErr || bErr) {
    const which = aErr && bErr ? 'A+B' : aErr ? 'A' : 'B';
    const errMsg = (aErr && statusA.error_message) || (bErr && statusB.error_message) || null;
    return (
      <span
        className="capture-status-chip capture-status-chip--failed"
        title={errMsg ? `Capture failed on ${which}: ${errMsg}` : `Capture failed on ${which}`}
      >
        failed ({which})
      </span>
    );
  }

  const aStale = statusA.is_stale;
  const bStale = statusB.is_stale;
  if (!aStale && !bStale) return null;

  const which = aStale && bStale ? 'A+B' : aStale ? 'A' : 'B';
  const inProgress =
    statusA.status === 'in_progress' || statusB.status === 'in_progress';

  if (inProgress && etaMs !== undefined && etaMs > 0) {
    const formatted = formatEta(etaMs);
    return (
      <span
        className="capture-status-chip capture-status-chip--stale"
        title={`Showing prior capture on ${which} — recapturing (${formatted} until ready)`}
      >
        ~{formatted}
      </span>
    );
  }

  return (
    <span
      className="capture-status-chip capture-status-chip--stale"
      title={`Showing prior capture on ${which} — ${inProgress ? 'recapturing' : 'stale'}`}
    >
      stale
    </span>
  );
}

function formatEta(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}
