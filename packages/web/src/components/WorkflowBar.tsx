import { useState, type JSX, type ReactNode } from 'react';

interface RowSummary {
  label: string;
  primary: string;
  meta?: string;
  actionLabel: string;
  controls: ReactNode;
}

interface Props {
  capture: RowSummary;
  comparison: RowSummary | null;
}

export function WorkflowBar({ capture, comparison }: Props): JSX.Element {
  const [openCapture, setOpenCapture] = useState(false);
  const [openComparison, setOpenComparison] = useState(false);

  return (
    <div className="workflow-bar">
      <Row
        row={capture}
        open={openCapture}
        onToggle={() => setOpenCapture((v) => !v)}
      />
      {comparison && (
        <Row
          row={comparison}
          open={openComparison}
          onToggle={() => setOpenComparison((v) => !v)}
        />
      )}
    </div>
  );
}

function Row({
  row,
  open,
  onToggle,
}: {
  row: RowSummary;
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <div>
      <div className="row">
        <div className="summary">
          <span className="label">{row.label}</span>
          <span>{row.primary}</span>
          {row.meta && <span className="meta">{row.meta}</span>}
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn secondary"
            style={{ padding: '4px 10px', fontSize: 13 }}
            aria-expanded={open}
            onClick={onToggle}
          >
            {row.actionLabel} {open ? '▴' : '▾'}
          </button>
        </div>
      </div>
      {open && <div className="expanded">{row.controls}</div>}
    </div>
  );
}
