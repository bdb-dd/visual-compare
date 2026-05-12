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
  /** Optional close button; absent when the parent doesn't want to allow deselect. */
  onClose?: () => void;

  // Row-focus passthroughs.
  targetLevel?: EquivalenceLevelId;
  acceptance?: AcceptanceRow | null;
  openAcceptDialogTrigger?: number;
  onAcceptanceChanged?: (label?: string | null) => void;

  // Cluster-focus passthroughs.
  onClusterChanged?: () => void;
  /** Trigger counter the ActionsMenu bumps to open the cluster accept dialog. */
  clusterAcceptDialogTrigger?: number;
  /** Counterpart for cluster reject. */
  clusterRejectDialogTrigger?: number;
}

export function DetailPane({
  sessionId,
  focused,
  actionsSlot,
  onClose,
  targetLevel,
  acceptance,
  openAcceptDialogTrigger,
  onAcceptanceChanged,
  onClusterChanged,
  clusterAcceptDialogTrigger,
  clusterRejectDialogTrigger,
}: DetailPaneProps): JSX.Element {
  return (
    <section className="detail-pane">
      <header className="detail-pane__chrome">
        <span className="detail-pane__kind">
          {focused?.kind === 'cluster'
            ? 'Cluster'
            : focused?.kind === 'row'
              ? 'Comparison'
              : 'Detail'}
        </span>
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
            openAcceptDialogTrigger={clusterAcceptDialogTrigger}
            openRejectDialogTrigger={clusterRejectDialogTrigger}
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
    </div>
  );
}
