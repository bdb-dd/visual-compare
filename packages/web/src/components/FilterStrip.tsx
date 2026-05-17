import type { JSX } from 'react';
import { CHANGE_TYPES, REGION_ROLES } from '@visual-compare/api/constants/taxonomy';
import type {
  FilterState,
  Level,
  Outcome,
  Status,
} from '../api/filterState.js';

/**
 * Shared filter strip for the unified review surface (Phase δ). Four
 * zones, mode-aware applicability — see `unified-review-proposal.md`
 * §3.4 for the spec.
 *
 * - Status (shared, single-select). Chips that don't apply to the
 *   current mode render disabled-with-tooltip rather than hiding —
 *   layout stays predictable and the disabled-with-reason teaches the
 *   cross-mode model.
 * - Level (Rows + Anomalies, multi-select).
 * - Region + Change-type (Clusters only, multi-select).
 * - Outcome (Rows + Anomalies, single-select).
 *
 * State flows entirely through props; serialisation lives in
 * `api/filterState.ts`. The parent (SessionDetailPage) owns the
 * URL-backed state.
 */

export type Mode = 'clusters' | 'rows' | 'anomalies';

export interface FilterStripProps {
  mode: Mode;
  state: FilterState;
  onChange: (next: FilterState) => void;
  /** Optional badge counts per chip. Keys like `status:accepted`, `level:tolerant`. */
  counts?: Record<string, number>;
}

interface ChipDef<T extends string> {
  value: T;
  label: string;
}

const STATUS_CHIPS: ChipDef<Status>[] = [
  { value: 'all', label: 'All' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'regressed', label: 'Regressed' },
  { value: 'expanded', label: 'Expanded' },
];

const LEVEL_CHIPS: ChipDef<Level>[] = [
  { value: 'pixel-perfect', label: 'pp' },
  { value: 'strict', label: 'strict' },
  { value: 'tolerant', label: 'tolerant' },
  { value: 'loose', label: 'loose' },
  { value: 'none', label: 'none' },
  { value: 'pending', label: 'pending' },
  { value: 'missing', label: 'missing' },
];

const OUTCOME_CHIPS: ChipDef<Outcome>[] = [
  { value: 'present', label: 'present' },
  { value: 'a-missing', label: 'A missing' },
  { value: 'b-missing', label: 'B missing' },
  { value: 'both-missing', label: 'Both missing' },
  { value: 'capture-failed', label: 'Capture failed' },
];

/** Status chip applicability per mode. Disabled-with-reason for false. */
function statusApplicable(status: Status, mode: Mode): true | string {
  if (mode === 'clusters') {
    if (status === 'regressed' || status === 'expanded') {
      return 'Row-level concept — switch to Rows mode';
    }
  }
  if (mode === 'anomalies') {
    if (status === 'regressed' || status === 'expanded') {
      return 'Inspect the underlying row from the cluster detail';
    }
  }
  return true;
}

export function FilterStrip({ mode, state, onChange, counts }: FilterStripProps): JSX.Element {
  const setStatus = (status: Status) => onChange({ ...state, status });

  const toggleLevel = (lvl: Level) => {
    const next = state.levels.includes(lvl)
      ? state.levels.filter((l) => l !== lvl)
      : [...state.levels, lvl].sort();
    onChange({ ...state, levels: next });
  };

  const toggleRegion = (r: string) => {
    const next = state.regions.includes(r)
      ? state.regions.filter((x) => x !== r)
      : [...state.regions, r].sort();
    onChange({ ...state, regions: next });
  };

  const toggleChange = (c: string) => {
    const next = state.changes.includes(c)
      ? state.changes.filter((x) => x !== c)
      : [...state.changes, c].sort();
    onChange({ ...state, changes: next });
  };

  const toggleOutcome = (o: Outcome) => {
    const next = state.outcomes.includes(o)
      ? state.outcomes.filter((x) => x !== o)
      : [...state.outcomes, o].sort();
    onChange({ ...state, outcomes: next });
  };

  return (
    <div className="filter-strip" role="toolbar" aria-label="Filter results">
      <Zone label="Status">
        {STATUS_CHIPS.map((c) => {
          const applicable = statusApplicable(c.value, mode);
          const disabled = applicable !== true;
          return (
            <Chip
              key={c.value}
              active={state.status === c.value}
              disabled={disabled}
              title={disabled ? (applicable as string) : undefined}
              onClick={() => !disabled && setStatus(c.value)}
              count={counts?.[`status:${c.value}`]}
            >
              {c.label}
            </Chip>
          );
        })}
      </Zone>

      {(mode === 'rows' || mode === 'anomalies') && (
        <Zone label="Level">
          {LEVEL_CHIPS.map((c) => (
            <Chip
              key={c.value}
              active={state.levels.includes(c.value)}
              onClick={() => toggleLevel(c.value)}
              count={counts?.[`level:${c.value}`]}
            >
              {c.label}
            </Chip>
          ))}
        </Zone>
      )}

      {mode === 'clusters' && (
        <>
          <Zone label="Region">
            {REGION_ROLES.map((r) => (
              <Chip
                key={r}
                active={state.regions.includes(r)}
                onClick={() => toggleRegion(r)}
                count={counts?.[`region:${r}`]}
              >
                {r}
              </Chip>
            ))}
          </Zone>
          <Zone label="Change">
            {CHANGE_TYPES.map((c) => (
              <Chip
                key={c}
                active={state.changes.includes(c)}
                onClick={() => toggleChange(c)}
                count={counts?.[`change:${c}`]}
              >
                {c}
              </Chip>
            ))}
          </Zone>
        </>
      )}

      {(mode === 'rows' || mode === 'anomalies') && (
        <Zone label="Outcome">
          {OUTCOME_CHIPS.map((c) => (
            <Chip
              key={c.value}
              active={state.outcomes.includes(c.value)}
              onClick={() => toggleOutcome(c.value)}
              count={counts?.[`outcome:${c.value}`]}
            >
              {c.label}
            </Chip>
          ))}
        </Zone>
      )}
    </div>
  );
}

function Zone({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="filter-strip__zone">
      <span className="filter-strip__zone-label">{label}</span>
      <div className="filter-strip__zone-chips">{children}</div>
    </div>
  );
}

function Chip({
  active,
  disabled,
  title,
  onClick,
  count,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  count?: number;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`filter-chip${active ? ' filter-chip--active' : ''}`}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {children}
      {count !== undefined && <span className="filter-chip__count">{count}</span>}
    </button>
  );
}
