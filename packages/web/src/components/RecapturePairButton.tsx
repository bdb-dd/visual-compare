import { useState, type JSX, type MouseEvent } from 'react';
import { api } from '../api/client.js';

interface Props {
  sessionId: string;
  pairId: string;
  className?: string;
  /** Compact variant for use inside dense list rows. */
  compact?: boolean;
  /**
   * Icon-only variant: renders a single ↻ glyph. Used when the button
   * sits inline next to other row chrome (e.g. the verdict chip) where
   * a wide "Recapture" label would crowd the row meta.
   */
  iconOnly?: boolean;
  /**
   * Fires after the invalidate + evaluate kick-off succeeds, with the
   * evaluate result. Callers may return a Promise (e.g. to poll the
   * evaluation and then navigate); the button stays in "Recapturing…"
   * until the returned promise resolves so the user sees one continuous
   * busy state across the whole pipeline rather than a flicker.
   */
  onTriggered?: (
    result: { evaluation_id: string; coalesced: boolean },
  ) => void | Promise<void>;
}

export function RecapturePairButton({
  sessionId,
  pairId,
  className,
  compact,
  iconOnly,
  onTriggered,
}: Props): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setBusy(true);
    setError(null);
    try {
      const result = await api.recapturePair(sessionId, pairId);
      await onTriggered?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const title = error
    ?? (busy
      ? 'Recapture in flight'
      : 'Drop cached captures for this pair and re-evaluate both URLs from source');
  const classes = ['btn', 'secondary'];
  if (compact) classes.push('btn-compact');
  if (iconOnly) classes.push('btn-icon');
  if (className) classes.push(className);

  const label = iconOnly
    ? busy ? '↻' : '↻'   // glyph stays; busy state shown via the spin class
    : busy ? 'Recapturing…' : 'Recapture';

  return (
    <button
      type="button"
      className={`${classes.join(' ')}${iconOnly && busy ? ' btn-icon--spinning' : ''}`}
      onClick={(e) => void handleClick(e)}
      disabled={busy}
      title={title}
      aria-label="Recapture this pair"
    >
      {label}
    </button>
  );
}
