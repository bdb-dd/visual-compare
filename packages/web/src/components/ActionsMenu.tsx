import { useEffect, useRef, useState, type JSX } from 'react';
import type { SessionResultRow } from '@visual-compare/api/types';
import type { Focused } from './DetailPane.js';

/**
 * Context-aware Actions dropdown for the unified detail pane (Phase γ).
 * Single, stable affordance — the items inside change based on what's
 * focused, but the button always says "Actions ▾" and lives in the
 * pane's top-right.
 *
 * Items that don't apply to the current focused-item type render as
 * disabled with a one-line reason, rather than hiding. The layout
 * stays predictable and the disabled-with-reason teaches the
 * cross-mode model (proposal §3.5).
 */

export interface ActionsMenuProps {
  focused: Focused | null;
  sessionId: string;

  // Row-focus handlers (passed through from SessionDetailPage).
  onRowAccept?: (row: SessionResultRow) => void;
  onRowQuickAccept?: (row: SessionResultRow) => void;
  onRowClear?: (row: SessionResultRow) => void;

  // Phase ε row → cluster cross-mode gestures.
  /** Open the cluster accept dialog for the row's primary cluster. */
  onRowAcceptCluster?: (clusterId: string) => void;
  /** Switch to Clusters mode and focus the row's primary cluster. */
  onRowShowCluster?: (clusterId: string) => void;

  // Cluster-focus handlers.
  onClusterAccept?: () => void;
  onClusterReject?: () => void;

  // Cluster state passed through so we can disable Accept/Reject correctly.
  clusterReviewState?: 'open' | 'accepted' | 'rejected' | 'split' | 'anomaly' | null;
}

interface MenuItem {
  key: string;
  label: string;
  onClick?: () => void;
  href?: string;
  disabledReason?: string;
  /** When true, render a separator above this item. */
  separator?: boolean;
}

export function ActionsMenu(props: ActionsMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const items = computeItems(props);

  return (
    <div className="actions-menu" ref={containerRef}>
      <button
        type="button"
        className="actions-menu__toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        disabled={items.length === 0}
        title={items.length === 0 ? 'No actions available' : 'Actions'}
      >
        Actions ▾
      </button>
      {open && (
        <ul role="menu" className="actions-menu__list">
          {items.map((item) => (
            <Item
              key={item.key}
              item={item}
              onAfterClick={() => setOpen(false)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function Item({
  item,
  onAfterClick,
}: {
  item: MenuItem;
  onAfterClick: () => void;
}): JSX.Element {
  if (item.separator) {
    return (
      <>
        <li className="actions-menu__separator" role="separator" />
        <BaseItem item={item} onAfterClick={onAfterClick} />
      </>
    );
  }
  return <BaseItem item={item} onAfterClick={onAfterClick} />;
}

function BaseItem({
  item,
  onAfterClick,
}: {
  item: MenuItem;
  onAfterClick: () => void;
}): JSX.Element {
  const disabled = !!item.disabledReason;
  if (item.href && !disabled) {
    return (
      <li role="none">
        <a
          role="menuitem"
          className="actions-menu__item"
          href={item.href}
          target="_blank"
          rel="noreferrer"
          onClick={() => onAfterClick()}
        >
          {item.label}
        </a>
      </li>
    );
  }
  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        className="actions-menu__item"
        disabled={disabled}
        title={item.disabledReason}
        onClick={() => {
          if (disabled || !item.onClick) return;
          item.onClick();
          onAfterClick();
        }}
      >
        {item.label}
      </button>
    </li>
  );
}

function computeItems(props: ActionsMenuProps): MenuItem[] {
  const { focused } = props;
  if (focused === null) return [];

  if (focused.kind === 'row') {
    const row = focused.row;
    const canAccept = !!(row?.matched_at_level && row?.capture_a_sha && row?.capture_b_sha);
    const noAcceptReason = row
      ? canAccept ? undefined : 'Row hasn\'t reached a final verdict yet'
      : 'No row data';
    const clusterId = row?.cluster_id ?? null;
    const clusterAlreadyAccepted = row?.cluster_review_state === 'accepted';
    const noClusterReason = clusterId
      ? undefined
      : 'This row doesn\'t belong to a v1 cluster (imagick-only or v2-era diffs)';
    return [
      {
        key: 'accept',
        label: 'Accept (with dialog)',
        onClick: row && canAccept && props.onRowAccept ? () => props.onRowAccept!(row) : undefined,
        disabledReason: noAcceptReason ?? (props.onRowAccept ? undefined : 'No handler'),
      },
      {
        key: 'quick-accept',
        label: 'Quick accept',
        onClick: row && canAccept && props.onRowQuickAccept ? () => props.onRowQuickAccept!(row) : undefined,
        disabledReason: noAcceptReason ?? (props.onRowQuickAccept ? undefined : 'No handler'),
      },
      {
        key: 'clear',
        label: 'Clear acceptance',
        onClick: row && props.onRowClear ? () => props.onRowClear!(row) : undefined,
        disabledReason: row ? (props.onRowClear ? undefined : 'No handler') : 'No row data',
      },
      {
        key: 'accept-cluster',
        label: 'Accept this row\'s cluster',
        onClick:
          clusterId && !clusterAlreadyAccepted && props.onRowAcceptCluster
            ? () => props.onRowAcceptCluster!(clusterId)
            : undefined,
        disabledReason:
          noClusterReason
          ?? (clusterAlreadyAccepted
              ? 'Cluster is already accepted'
              : (props.onRowAcceptCluster ? undefined : 'No handler')),
        separator: true,
      },
      {
        key: 'show-cluster',
        label: 'Show this row\'s cluster',
        onClick:
          clusterId && props.onRowShowCluster
            ? () => props.onRowShowCluster!(clusterId)
            : undefined,
        disabledReason: noClusterReason ?? (props.onRowShowCluster ? undefined : 'No handler'),
      },
      {
        key: 'open',
        label: 'Open in new tab ↗',
        href: focused.comparisonId ? `/comparisons/${focused.comparisonId}` : undefined,
        disabledReason: focused.comparisonId ? undefined : 'No comparison id',
        separator: true,
      },
    ];
  }

  // focused.kind === 'cluster'
  const isAccepted = props.clusterReviewState === 'accepted';
  return [
    {
      key: 'accept',
      label: 'Accept cluster',
      onClick: isAccepted ? undefined : props.onClusterAccept,
      disabledReason: isAccepted
        ? 'Already accepted — reject first to re-accept'
        : (props.onClusterAccept ? undefined : 'No handler'),
    },
    {
      key: 'reject',
      label: 'Reject cluster',
      onClick: isAccepted ? props.onClusterReject : undefined,
      disabledReason: isAccepted
        ? (props.onClusterReject ? undefined : 'No handler')
        : 'Only accepted clusters can be rejected',
    },
    {
      key: 'split',
      label: 'Split cluster',
      disabledReason: 'Coming in a later phase',
    },
    {
      key: 'show-members',
      label: 'Show members in Rows',
      disabledReason: 'Needs row-filter-by-cluster — Phase δ',
      separator: true,
    },
    {
      key: 'accept-category',
      label: 'Accept entire category',
      disabledReason: 'Available from the category bulk-accept buttons in the Clusters list — pending menu integration',
    },
    {
      key: 'open',
      label: 'Open in new tab ↗',
      href: `/sessions/${props.sessionId}/clusters/${focused.clusterId}`,
      separator: true,
    },
  ];
}
