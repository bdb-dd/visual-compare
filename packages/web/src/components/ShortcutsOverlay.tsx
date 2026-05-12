import type { JSX } from 'react';

/**
 * Phase ζ: cheat-sheet overlay toggled by the `?` key. Reviewer can
 * scan all shortcuts in one place without leaving the review surface.
 * Grouped by where the shortcut applies so the cross-mode model is
 * legible.
 *
 * Closes on Escape or clicking the backdrop; both flows are handled by
 * the parent (SessionDetailPage) — this component is dumb display.
 */

export interface ShortcutsOverlayProps {
  onClose: () => void;
}

interface ShortcutRow {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: 'Global',
    rows: [
      { keys: ['1'], description: 'Switch to Clusters mode' },
      { keys: ['2'], description: 'Switch to Rows mode' },
      { keys: ['3'], description: 'Switch to Anomalies mode' },
      { keys: ['?'], description: 'Toggle this cheat-sheet' },
      { keys: ['Esc'], description: 'Close this overlay (or clear row selection in Rows mode)' },
    ],
  },
  {
    title: 'Rows mode',
    rows: [
      { keys: ['j', '↓'], description: 'Next row' },
      { keys: ['k', '↑'], description: 'Previous row' },
      { keys: ['a'], description: 'Open accept dialog for the focused row' },
      { keys: ['Shift', 'a'], description: 'Quick-accept with the last-used label' },
      { keys: ['r'], description: "Clear the focused row's acceptance" },
      { keys: ['c'], description: "Jump to the focused row's cluster (Clusters mode + cluster focused)" },
    ],
  },
];

export function ShortcutsOverlay({ onClose }: ShortcutsOverlayProps): JSX.Element {
  return (
    <div className="shortcuts-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="shortcuts-overlay__panel" onClick={(e) => e.stopPropagation()}>
        <header className="shortcuts-overlay__header">
          <h3>Keyboard shortcuts</h3>
          <button
            type="button"
            className="shortcuts-overlay__close"
            onClick={onClose}
            aria-label="Close shortcuts"
          >
            ✕
          </button>
        </header>
        <div className="shortcuts-overlay__groups">
          {GROUPS.map((g) => (
            <section key={g.title} className="shortcuts-overlay__group">
              <h4>{g.title}</h4>
              <dl>
                {g.rows.map((row) => (
                  <div key={row.keys.join('+')} className="shortcuts-overlay__row">
                    <dt>
                      {row.keys.map((k, i) => (
                        <span key={i}>
                          <kbd>{k}</kbd>
                          {i < row.keys.length - 1 && <span className="shortcuts-overlay__sep">{k === 'Shift' ? '+' : 'or'}</span>}
                        </span>
                      ))}
                    </dt>
                    <dd>{row.description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <footer className="shortcuts-overlay__footer">
          <span className="muted">Press <kbd>?</kbd> again or <kbd>Esc</kbd> to close</span>
        </footer>
      </div>
    </div>
  );
}
