import type { JSX, ReactNode } from 'react';
import { ClusterDetailPanel } from './ClusterDetailPanel.js';
import { ComparisonDetail } from './ComparisonDetail.js';
import type {
  AcceptanceRow,
  EquivalenceLevelId,
  SessionResultRow,
} from '@visual-compare/api/types';

/**
 * Unified detail pane introduced in Phase γ. Renders one of:
 *   - ComparisonDetail   (focused.kind === 'row')
 *   - ClusterDetailPanel (focused.kind === 'cluster')
 *   - empty-state hint   (focused === null)
 *
 * Outer chrome is constant across modes — header bar with an optional
 * close button and a slot for the ActionsMenu (filled in next task).
 * Keeps SessionDetailPage's per-mode rendering small: the pane
 * encapsulates the focused-item delegation.
 */

const noop = (): void => {};

export type Focused =
  | {
      kind: 'row';
      comparisonId: string | null;
      row: SessionResultRow | null;
    }
  | {
      kind: 'cluster';
      clusterId: string;
    };

export interface DetailPaneProps {
  sessionId: string;
  focused: Focused | null;
  /** Slot for the actions dropdown — populated in the next task. */
  actionsSlot?: ReactNode;
  /**
   * Slot for a rich title on the left of the chrome. When provided,
   * replaces the static "Cluster" / "Comparison" eyebrow. Cluster mode
   * uses this to inline the cluster's label, change-type, state pill,
   * and counts — saving a whole row over the old eyebrow + h2 layout.
   */
  titleSlot?: ReactNode;
  /** Optional close button; absent when the parent doesn't want to allow deselect. */
  onClose?: () => void;

  // Row-focus passthroughs.
  targetLevel?: EquivalenceLevelId;
  acceptance?: AcceptanceRow | null;
  openAcceptDialogTrigger?: number;
  onAcceptanceChanged?: (label?: string | null) => void;
  /** Fires when a Recapture kicks off; SessionDetailPage uses this to refresh its evaluations list. */
  onRecaptureStarted?: (evaluation_id: string) => void;

  // Cluster-focus passthroughs.
  onClusterChanged?: () => void;
  /** Fires when the cluster panel loads or updates its cluster row. */
  onClusterLoaded?: (cluster: import('@visual-compare/api/types').DifferenceClusterRow) => void;
  /** Fires when the cluster panel loads/refreshes the full cluster detail DTO. */
  onClusterDataLoaded?: (data: import('@visual-compare/api/types').ClusterDetailDto) => void;
  /** Trigger counter the ActionsMenu bumps to open the cluster accept dialog. */
  clusterAcceptDialogTrigger?: number;
  /** Counterpart for cluster reject. */
  clusterRejectDialogTrigger?: number;
  /** Counterpart for cluster split. */
  clusterSplitDialogTrigger?: number;
  /** Counter the parent bumps to ask the cluster panel to re-fetch (post-Recapture). */
  clusterRefreshTrigger?: number;
  /**
   * Member focus is lifted to the page so the inline ClustersTab list
   * shares state with the panel. Required when `focused.kind === 'cluster'`;
   * row-mode callers can omit (defaults are unused there).
   */
  focusedMemberId?: string | null;
  onMemberFocus?: (id: string | null) => void;
  /**
   * Session acceptances. The cluster panel cross-references members
   * (keyed by url_pair_id + viewport_name) to surface partial-acceptance
   * state and let users accept/clear individual members.
   */
  acceptances?: AcceptanceRow[];
  /** Called after a per-member accept/clear so the parent can refresh. */
  onMemberAcceptanceChanged?: () => void;
}

export function DetailPane({
  sessionId,
  focused,
  actionsSlot,
  titleSlot,
  onClose,
  targetLevel,
  acceptance,
  openAcceptDialogTrigger,
  onAcceptanceChanged,
  onRecaptureStarted,
  onClusterChanged,
  onClusterLoaded,
  onClusterDataLoaded,
  clusterAcceptDialogTrigger,
  clusterRejectDialogTrigger,
  clusterSplitDialogTrigger,
  clusterRefreshTrigger,
  focusedMemberId,
  onMemberFocus,
  acceptances,
  onMemberAcceptanceChanged,
}: DetailPaneProps): JSX.Element {
  return (
    <section className="detail-pane">
      <header className="detail-pane__chrome">
        {titleSlot ?? (
          <span className="detail-pane__kind">
            {focused?.kind === 'cluster'
              ? 'Cluster'
              : focused?.kind === 'row'
                ? 'Comparison'
                : 'Detail'}
          </span>
        )}
        <div className="detail-pane__chrome-actions">
          {actionsSlot}
          {onClose && (
            <button
              type="button"
              className="detail-pane__close"
              onClick={onClose}
              title="Close detail pane"
              aria-label="Close detail pane"
            >
              ✕
            </button>
          )}
        </div>
      </header>

      <div className="detail-pane__body">
        {focused === null && <EmptyState />}
        {focused?.kind === 'row' && focused.comparisonId && (
          <ComparisonDetail
            id={focused.comparisonId}
            row={focused.row}
            targetLevel={targetLevel}
            sessionId={sessionId}
            acceptance={acceptance ?? null}
            openAcceptDialogTrigger={openAcceptDialogTrigger}
            onAcceptanceChanged={onAcceptanceChanged}
            onRecaptureStarted={onRecaptureStarted}
          />
        )}
        {focused?.kind === 'row' && !focused.comparisonId && (
          <p className="muted" style={{ margin: 0 }}>
            Comparison hasn't been evaluated yet for this row.
          </p>
        )}
        {focused?.kind === 'cluster' && (
          <ClusterDetailPanel
            sessionId={sessionId}
            clusterId={focused.clusterId}
            onChanged={onClusterChanged}
            onClusterLoaded={onClusterLoaded}
            onDataLoaded={onClusterDataLoaded}
            openAcceptDialogTrigger={clusterAcceptDialogTrigger}
            openRejectDialogTrigger={clusterRejectDialogTrigger}
            openSplitDialogTrigger={clusterSplitDialogTrigger}
            refreshTrigger={clusterRefreshTrigger}
            focusedMemberId={focusedMemberId ?? null}
            onMemberFocus={onMemberFocus ?? noop}
            acceptances={acceptances ?? []}
            onMemberAcceptanceChanged={onMemberAcceptanceChanged}
          />
        )}
      </div>
    </section>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div className="detail-pane__empty">
      <p>Nothing focused.</p>
      <p className="muted">
        Click a cluster card on the left, or a row in Rows mode, to inspect
        it here. Bulk-accept the broad patterns from Clusters mode, then
        sweep the residual one-offs in Anomalies.
      </p>
      <p className="muted">
        Press <kbd>?</kbd> for keyboard shortcuts.
      </p>
    </div>
  );
}
