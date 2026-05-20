import { useEffect, useMemo, useRef, useState, type JSX, type UIEvent } from 'react';
import { api } from '../api/client.js';
import { ImageWithBoxes } from './ImageWithBoxes.js';
import { FitModeToggle, useFitMode } from './FitModeToggle.js';
import { useSyncedScroll } from './useSyncedScroll.js';
import { RecapturePairButton } from './RecapturePairButton.js';
import { StatusPill } from './StatusPill.js';
import { StaleBadge } from './StaleBadge.js';
import { isAtLeastAsStrict } from '@visual-compare/api/constants/equivalence';
import type {
  AcceptanceRow,
  AcceptanceStatus,
  BoundingBoxPercent,
  ComparisonDetailDto,
  EquivalenceLevelId,
  SessionResultRow,
} from '@visual-compare/api/types';

type ViewMode = 'diff' | 'a' | 'b' | 'split';

interface Props {
  id: string;
  /** When set, the right panel can show acceptance state and Accept controls. */
  row?: SessionResultRow | null;
  /** Session target level. Used to decide whether a row "passed" (reached target) or "failed". */
  targetLevel?: EquivalenceLevelId;
  sessionId?: string;
  acceptance?: AcceptanceRow | null;
  /**
   * Counter that the parent increments to ask AcceptanceBar to open its
   * dialog (keyboard shortcut "a"). The current value is consumed once
   * per change.
   */
  openAcceptDialogTrigger?: number;
  /** Called after a successful upsert/delete; receives the saved label so the parent can remember "last used". */
  onAcceptanceChanged?: (label?: string | null) => void;
  onLoaded?: (detail: ComparisonDetailDto) => void;
  /**
   * Fires the instant a Recapture kicks off an evaluation, before the
   * polling/navigation flow runs. The parent (SessionDetailPage) uses this
   * to refresh its evaluations list so PlanAndEvaluate in the header
   * adopts the new eval and shows its progress.
   */
  onRecaptureStarted?: (evaluation_id: string) => void;
  /**
   * When provided, Recapture's "newer comparison row landed" path calls
   * this with the new comparison id instead of running its own
   * navigation. The standalone comparison page uses it to swap the URL
   * to /sessions/<sid>/comparisons/<newId>. When omitted (DetailPane
   * embed inside SessionDetailPage), the component refreshes in place
   * and the parent stays on the session URL.
   */
  onComparisonIdChange?: (newId: string) => void;
}

const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: 'diff', label: 'Diff' },
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
  { id: 'split', label: 'A | B' },
];

export function ComparisonDetail({
  id,
  row,
  targetLevel,
  sessionId,
  acceptance,
  openAcceptDialogTrigger,
  onAcceptanceChanged,
  onLoaded,
  onRecaptureStarted,
  onComparisonIdChange,
}: Props): JSX.Element {
  const [detail, setDetail] = useState<ComparisonDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showBoxes, setShowBoxes] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('diff');
  const [fitMode, setFitMode] = useFitMode();
  const splitSync = useSyncedScroll(2);
  const [refreshTick, setRefreshTick] = useState(0);
  const [recapturing, setRecapturing] = useState(false);

  // Note: the comparison-detail pane intentionally does NOT show ETAs in
  // its stale badge — ETAs are reserved for the cluster panel (small
  // focused set). The badge here still shows the stale + recapture-
  // status state, just without the `~Xs` suffix.

  useEffect(() => {
    setDetail(null);
    setError(null);
    let cancelled = false;
    void (async () => {
      try {
        const d = await api.getComparisonDetail(id);
        if (cancelled) return;
        setDetail(d);
        onLoaded?.(d);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, refreshTick, onLoaded]);

  if (error) return <div className="error">{error}</div>;
  if (!detail) return <p className="muted">Loading…</p>;

  const { comparison: c, capture_a, capture_b, differences, url_pair } = detail;
  const boxes: BoundingBoxPercent[] = showBoxes
    ? differences.flatMap((d) => (d.bounding_box ? [d.bounding_box] : []))
    : [];
  const pairLabel = url_pair.label?.trim() || `Pair #${url_pair.row_index + 1}`;

  // Verdict against the session target: a row only "passes" when its
  // matched_at_level reaches the target. matching at a weaker level is a
  // fail from the user's perspective even though pixel rules confirmed
  // some level. Falls back to the legacy "any-non-none = pass" rule when
  // the parent didn't supply a targetLevel (e.g., direct deep-link).
  const matchedEquivalent = matchedAgainstTarget(c.matched_at_level, targetLevel);
  const verdictKind = verdictOf(matchedEquivalent);
  const lmGlyph =
    c.lm_determined_equivalent === null ? '—' : c.lm_determined_equivalent ? '✓' : '✗';
  const lmTitle = c.lm_prompt_version
    ? `${c.lm_invocation_reason} · prompt ${c.lm_prompt_version}`
    : c.lm_invocation_reason ?? '';

  const isMissing = c.pair_outcome !== 'both_present';
  const missingDetailLabel =
    c.pair_outcome === 'a_missing'
      ? 'A is a missing page'
      : c.pair_outcome === 'b_missing'
        ? 'B is a missing page'
        : c.pair_outcome === 'both_missing'
          ? 'Both A and B are missing pages'
          : null;

  return (
    <>
      {recapturing && (
        <div className="recapture-banner" role="status" aria-live="polite">
          Recapturing… waiting for new captures and verdict. The comparison
          will update automatically when ready.
        </div>
      )}
      <div className="detail-head">
        <div className="dh-title-row">
          {isMissing ? (
            <span className="verdict-chip verdict-missing">∅</span>
          ) : (
            <span className={`verdict-chip verdict-${verdictKind}`}>{verdictGlyph(matchedEquivalent)}</span>
          )}
          <strong className="dh-title">{pairLabel}</strong>
          <span className="dh-sep">·</span>
          <span className="muted">{c.viewport_name}</span>
          <span className="dh-sep">·</span>
          <span className="muted">
            {isMissing
              ? missingDetailLabel
              : (
                <>
                  {c.matched_at_level ?? '—'}
                  {targetLevel && c.matched_at_level && ` / ${targetLevel} target`}
                </>
              )}
          </span>
          <StatusPill status={c.status} />
          <label className="dh-toggle">
            <input
              type="checkbox"
              checked={showBoxes}
              onChange={(e) => setShowBoxes(e.target.checked)}
            />{' '}
            Boxes
          </label>
          <RecapturePairButton
            sessionId={url_pair.session_id}
            pairId={url_pair.id}
            compact
            onTriggered={async ({ evaluation_id }) => {
              // Tell the parent right away so the session header's
              // PlanAndEvaluate can adopt the new eval and start showing
              // progress while we poll for the resulting comparison id.
              onRecaptureStarted?.(evaluation_id);
              setRecapturing(true);
              try {
                const newId = await pollForNewComparisonId(
                  evaluation_id,
                  url_pair.id,
                  c.viewport_name,
                );
                // Two flavours of "the comparison id changed":
                //   - parent supplied `onComparisonIdChange` (the
                //     standalone page): hand the new id back so the
                //     parent swaps the URL.
                //   - parent didn't (DetailPane embed): refresh this
                //     component in place. The session URL stays on the
                //     row's session view.
                if (newId && newId !== id) {
                  if (onComparisonIdChange) {
                    onComparisonIdChange(newId);
                    return;
                  }
                }
                setRefreshTick((t) => t + 1);
              } finally {
                setRecapturing(false);
              }
            }}
          />
        </div>
        <div className="dh-urls">
          <div className="dh-url" title={url_pair.url_a}>
            <span className="dh-url-side">A</span>
            <a href={url_pair.url_a} target="_blank" rel="noreferrer">
              {url_pair.url_a}
            </a>
          </div>
          <div className="dh-url" title={url_pair.url_b}>
            <span className="dh-url-side">B</span>
            <a href={url_pair.url_b} target="_blank" rel="noreferrer">
              {url_pair.url_b}
            </a>
          </div>
        </div>
        {!isMissing && (
          <div className="dh-metrics">
            <span><span className="dh-key">Changed</span> {fmtPct(c.changed_pixel_percentage)}</span>
            <span><span className="dh-key">SSIM</span> {fmtNum(c.ssim, 4)}</span>
            <span><span className="dh-key">Box</span> {fmtPct(c.bounding_box_area_percentage)}</span>
            <span><span className="dh-key">Components</span> {c.connected_component_count ?? '—'}</span>
          </div>
        )}
        {c.lm_invocation_reason && (
          <div className="dh-lm" title={lmTitle}>
            <span className="dh-key">LM</span>
            <span className={`verdict-chip verdict-${verdictOf(c.lm_determined_equivalent)}`}>{lmGlyph}</span>
            <span className="muted">{c.lm_model ?? '—'}</span>
            <span className="muted">conf {fmtNum(c.lm_confidence, 2)}</span>
            {c.lm_diff_summary && <span className="dh-lm-summary">{c.lm_diff_summary}</span>}
          </div>
        )}
      </div>

      {c.error_message && <div className="error">{c.error_message}</div>}

      {row && sessionId && (
        <AcceptanceBar
          sessionId={sessionId}
          row={row}
          acceptance={acceptance ?? null}
          differences={differences}
          openTrigger={openAcceptDialogTrigger}
          onChanged={onAcceptanceChanged}
        />
      )}

      <div className="detail-tabs-row">
        <div className="detail-tabs" role="tablist">
          {VIEW_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={viewMode === m.id}
              className={`tab ${viewMode === m.id ? 'active' : ''}`}
              onClick={() => setViewMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <FitModeToggle mode={fitMode} onChange={setFitMode} />
      </div>

      <div className={`detail-frame mode-${viewMode} fit-${fitMode}`}>
        {viewMode === 'diff' && (
          <Pane label="Diff" src={c.im_diff_url} alt="diff" boxes={boxes} />
        )}
        {viewMode === 'a' && (
          <Pane
            label={`A · ${capture_a.viewport_name}`}
            badge={<StaleBadge status={row?.capture_a_status} />}
            src={capture_a.screenshot_url}
            alt="A"
            boxes={boxes}
          />
        )}
        {viewMode === 'b' && (
          <Pane
            label={`B · ${capture_b.viewport_name}`}
            badge={<StaleBadge status={row?.capture_b_status} />}
            src={capture_b.screenshot_url}
            alt="B"
            boxes={boxes}
          />
        )}
        {viewMode === 'split' && (
          <>
            <Pane
              label="A"
              badge={<StaleBadge status={row?.capture_a_status} />}
              src={capture_a.screenshot_url}
              alt="A"
              boxes={boxes}
              paneRef={splitSync.refs[0]}
              onScroll={splitSync.onScroll}
            />
            <Pane
              label="B"
              badge={<StaleBadge status={row?.capture_b_status} />}
              src={capture_b.screenshot_url}
              alt="B"
              boxes={boxes}
              paneRef={splitSync.refs[1]}
              onScroll={splitSync.onScroll}
            />
          </>
        )}
      </div>

      {differences.length > 0 && (
        <details className="differences" open>
          <summary>Differences ({differences.length})</summary>
          <ul className="diff-list">
            {differences.map((d) => (
              <li key={d.id}>
                <strong>[{d.source}]</strong>
                {d.severity ? <span className="muted"> {d.severity}</span> : null}{' '}
                {d.description}
                {d.bounding_box ? (
                  <span className="muted">
                    {' '}— ({d.bounding_box.x.toFixed(1)}%, {d.bounding_box.y.toFixed(1)}%)
                    {' '}{d.bounding_box.width.toFixed(1)}×{d.bounding_box.height.toFixed(1)}%
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Pane({
  label,
  badge,
  src,
  alt,
  boxes,
  paneRef,
  onScroll,
}: {
  label: string;
  badge?: JSX.Element | null;
  src: string | null;
  alt: string;
  boxes: BoundingBoxPercent[];
  paneRef?: (el: HTMLElement | null) => void;
  onScroll?: (e: UIEvent<HTMLElement>) => void;
}): JSX.Element {
  return (
    <div className="panel" ref={paneRef} onScroll={onScroll}>
      <header>
        {label}
        {badge}
      </header>
      {src ? (
        <ImageWithBoxes src={src} alt={alt} boxes={boxes} />
      ) : (
        <div style={{ padding: 16 }} className="muted">no image</div>
      )}
    </div>
  );
}


/**
 * Inline accept/clear controls. Three states:
 *   1. No acceptance — shows "Accept" button that opens a label/notes form.
 *   2. Acceptance + status='accepted' — shows "Accepted (label)" and a "Clear" button.
 *   3. Acceptance + regressed/expanded_diff — shows the regression badge and
 *      offers Re-accept (overwrites the snapshot) or Clear.
 *
 * Form snapshot is auto-populated from the current row's metrics + the
 * imagick differences for this comparison. The user only types label/notes.
 */
function AcceptanceBar({
  sessionId,
  row,
  acceptance,
  differences,
  openTrigger,
  onChanged,
}: {
  sessionId: string;
  row: SessionResultRow;
  acceptance: AcceptanceRow | null;
  differences: ComparisonDetailDto['differences'];
  openTrigger?: number;
  onChanged?: (label?: string | null) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [acceptAny, setAcceptAny] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status: AcceptanceStatus = row.acceptance_status;
  const canAccept =
    row.matched_at_level !== null &&
    row.capture_a_sha !== null &&
    row.capture_b_sha !== null;

  const imagickRegions = useMemo<BoundingBoxPercent[]>(
    () =>
      differences
        .filter((d) => d.source === 'imagick' && d.bounding_box)
        .map((d) => d.bounding_box as BoundingBoxPercent),
    [differences],
  );

  // Pre-fill the form when re-accepting an existing acceptance.
  function startAccept() {
    setLabel(acceptance?.label ?? '');
    setNotes(acceptance?.notes ?? '');
    setAcceptAny(acceptance?.accept_any === 1);
    setError(null);
    setOpen(true);
  }

  // Keyboard shortcut: parent increments openTrigger when "a" is pressed.
  // We compare against the previous value so the initial render (which
  // also has openTrigger set) doesn't auto-open the dialog.
  const lastTriggerRef = useRef(openTrigger);
  useEffect(() => {
    if (openTrigger === undefined) return;
    if (lastTriggerRef.current === openTrigger) return;
    lastTriggerRef.current = openTrigger;
    if (!canAccept) return;
    startAccept();
    // The form pre-fill comes from the latest `acceptance` at render
    // time, so we only depend on openTrigger here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTrigger]);

  async function submit() {
    if (!canAccept || row.matched_at_level === null) return;
    setBusy(true);
    setError(null);
    try {
      const trimmedLabel = label.trim() || null;
      await api.createAcceptance(sessionId, {
        url_pair_id: row.url_pair_id,
        viewport_name: row.viewport_name,
        accepted_level: row.matched_at_level,
        accepted_pixel_pct: row.pixel?.changed_pct ?? null,
        accepted_ssim: row.pixel?.ssim ?? null,
        accepted_diff_regions: imagickRegions,
        accepted_capture_a_sha: row.capture_a_sha!,
        accepted_capture_b_sha: row.capture_b_sha!,
        accept_any: acceptAny,
        label: trimmedLabel,
        notes: notes.trim() || null,
      });
      setOpen(false);
      onChanged?.(trimmedLabel);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearAcceptance() {
    if (!acceptance) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAcceptance(sessionId, acceptance.id);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`acceptance-bar acceptance-${status}`}>
      <div className="acceptance-summary">
        <AcceptanceStatusBadge status={status} />
        {acceptance && (
          <>
            {acceptance.label && <span className="acceptance-label">"{acceptance.label}"</span>}
            <span className="muted">accepted at {acceptance.accepted_level}</span>
            {acceptance.accept_any === 1 && (
              <span className="muted">· any future diff</span>
            )}
            {acceptance.acceptance_rule_id && (
              <span
                className="provenance-badge"
                title={`This acceptance was created by a ${row?.acceptance_rule_scope ?? 'cluster'} rule fan-out. Clearing it locally won't revoke the rule — use the cluster's Reject in Clusters mode.`}
              >
                via {row?.acceptance_rule_scope ?? 'rule'}
              </span>
            )}
          </>
        )}
        <div className="acceptance-actions">
          {acceptance ? (
            <>
              <button
                type="button"
                className="btn secondary"
                onClick={() => startAccept()}
                disabled={!canAccept || busy}
              >
                Re-accept
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={() => void clearAcceptance()}
                disabled={busy}
                title="Remove this acceptance"
              >
                Clear
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn primary"
              onClick={() => startAccept()}
              disabled={!canAccept || busy}
              title={canAccept ? 'Accept this comparison as the baseline' : 'No verdict yet'}
            >
              Accept
            </button>
          )}
        </div>
      </div>
      {open && (
        <form
          className="acceptance-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span>Label</span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. cookie banner"
              autoFocus
            />
          </label>
          <label className="field">
            <span>Notes</span>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional context for future you"
            />
          </label>
          <label className="field-inline">
            <input
              type="checkbox"
              checked={acceptAny}
              onChange={(e) => setAcceptAny(e.target.checked)}
            />
            <span>Accept any future diff (skip regression check)</span>
          </label>
          {error && <div className="error">{error}</div>}
          <div className="acceptance-form-buttons">
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save acceptance'}
            </button>
            <button
              type="button"
              className="btn secondary"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function AcceptanceStatusBadge({ status }: { status: AcceptanceStatus }): JSX.Element {
  if (status === 'unaccepted') {
    return <span className="acceptance-badge unaccepted">Not accepted</span>;
  }
  if (status === 'accepted') {
    return <span className="acceptance-badge accepted">~ Accepted</span>;
  }
  if (status === 'regressed') {
    return <span className="acceptance-badge regressed">↓ Regressed</span>;
  }
  return <span className="acceptance-badge expanded">△ New diff</span>;
}

function matchedToBool(level: ComparisonDetailDto['comparison']['matched_at_level']): number | null {
  if (level === null) return null;
  return level === 'none' ? 0 : 1;
}

function matchedAgainstTarget(
  level: ComparisonDetailDto['comparison']['matched_at_level'],
  target: EquivalenceLevelId | undefined,
): number | null {
  if (level === null) return null;
  if (level === 'none') return 0;
  // No target provided → fall back to the looser "any match counts" rule.
  if (!target) return 1;
  return isAtLeastAsStrict(level, target) ? 1 : 0;
}
function verdictOf(v: number | null): 'failed' | 'passed' | 'unknown' {
  if (v === 0) return 'failed';
  if (v === 1) return 'passed';
  return 'unknown';
}
function verdictGlyph(v: number | null): string {
  if (v === 0) return '✗';
  if (v === 1) return '✓';
  return '…';
}
function fmtPct(v: number | null): string {
  if (v === null) return '—';
  return `${v.toFixed(3)}%`;
}
function fmtNum(v: number | null, digits = 3): string {
  if (v === null) return '—';
  return v.toFixed(digits);
}

/**
 * Wait for the evaluation a Recapture kicked off, then locate the
 * comparison row it produced for this (pair, viewport). Returns the new
 * comparison id, or `null` if the evaluation didn't end up producing a
 * matching row (errored, cancelled, or the new SHAs short-circuited so
 * the orchestrator reused an existing comparison).
 */
async function pollForNewComparisonId(
  evaluationId: string,
  pairId: string,
  viewportName: string,
): Promise<string | null> {
  const evaluation = await api.waitForEvaluation(evaluationId);
  if (!evaluation || evaluation.status !== 'complete') return null;
  if (!evaluation.comparison_run_id) return null;
  const { comparisons } = await api.listComparisons({
    comparison_run_id: evaluation.comparison_run_id,
  });
  const match = comparisons.find(
    (c) => c.url_pair_id === pairId && c.viewport_name === viewportName,
  );
  return match?.id ?? null;
}
