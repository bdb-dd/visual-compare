import { Fragment, useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { ActionsMenu } from '../components/ActionsMenu.js';
import { AnomaliesTab } from '../components/AnomaliesTab.js';
import { ClustersTab } from '../components/ClustersTab.js';
import { DetailPane } from '../components/DetailPane.js';
import { FilterStrip } from '../components/FilterStrip.js';
import { ShortcutsOverlay } from '../components/ShortcutsOverlay.js';
import {
  applyFilterStateToParams,
  parseFilterState,
  type FilterState,
} from '../api/filterState.js';
import { LmStatusPill } from '../components/LmStatusPill.js';
import { PlanAndEvaluate } from '../components/PlanAndEvaluate.js';
import { SessionConfigPanel } from '../components/SessionConfigPanel.js';
import { SessionResultsList } from '../components/SessionResultsList.js';
import { UrlPairsEditor } from '../components/UrlPairsEditor.js';
import type {
  AcceptanceRow,
  CaptureRunRow,
  ComparisonRunRow,
  EquivalenceLevelId,
  EvaluationStatusDto,
  SessionConfig,
  SessionResultRow,
  SessionResultsDto,
  SessionRow,
  UrlPairRow,
  ViewportDef,
} from '@visual-compare/api/types';
import type { EquivalenceLevelDef } from '@visual-compare/api/constants/equivalence';

type SidebarTab = 'review' | 'config';
type DetailTab = 'comparison' | 'history' | 'pairs';
type Mode = 'clusters' | 'rows' | 'anomalies';

const MODE_VALUES: readonly Mode[] = ['clusters', 'rows', 'anomalies'];

function parseMode(raw: string | null): Mode {
  return (MODE_VALUES as readonly string[]).includes(raw ?? '')
    ? (raw as Mode)
    : 'clusters'; // funnel default per implementation plan §β
}

export function SessionDetailPage(): JSX.Element {
  const { id = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const mode = parseMode(searchParams.get('mode'));
  const setMode = useCallback(
    (next: Mode) => {
      const sp = new URLSearchParams(searchParams);
      if (next === 'clusters') sp.delete('mode'); // canonical default → clean URL
      else sp.set('mode', next);
      // Drop focus when switching modes — focus identifiers are mode-specific.
      sp.delete('focus');
      setSearchParams(sp, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // Cluster focus is URL-driven so deep links + back/forward work. Only
  // meaningful in clusters/anomalies modes; in rows mode the existing
  // selectedRowKey state drives the comparison selection (and ignores
  // ?focus= for now — δ may harmonise).
  const focusParam = searchParams.get('focus');
  const focusedClusterId =
    (mode === 'clusters' || mode === 'anomalies') && focusParam ? focusParam : null;
  const setFocusedClusterId = useCallback(
    (id: string | null) => {
      const sp = new URLSearchParams(searchParams);
      if (id === null) sp.delete('focus');
      else sp.set('focus', id);
      setSearchParams(sp, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // Phase δ: filter state is URL-driven, shared across the three modes.
  const filterState = parseFilterState(searchParams);
  const setFilterState = useCallback(
    (next: FilterState) => {
      const sp = new URLSearchParams(searchParams);
      applyFilterStateToParams(next, sp);
      setSearchParams(sp, { replace: true });
    },
    [searchParams, setSearchParams],
  );
  const [session, setSession] = useState<SessionRow | null>(null);
  const [config, setConfig] = useState<SessionConfig | null>(null);
  const [pairs, setPairs] = useState<UrlPairRow[]>([]);
  const [viewports, setViewports] = useState<ViewportDef[]>([]);
  const [defaultViewportName, setDefaultViewportName] = useState<string>('desktop');
  const [levels, setLevels] = useState<EquivalenceLevelDef[]>([]);
  const [defaultLevel, setDefaultLevel] = useState<EquivalenceLevelId>('tolerant');
  const [results, setResults] = useState<SessionResultsDto | null>(null);
  const [acceptances, setAcceptances] = useState<AcceptanceRow[]>([]);
  const [evaluations, setEvaluations] = useState<EvaluationStatusDto[]>([]);
  const [captureRuns, setCaptureRuns] = useState<CaptureRunRow[]>([]);
  const [comparisonRuns, setComparisonRuns] = useState<ComparisonRunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedEvaluationId, setExpandedEvaluationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('review');
  const [detailTab, setDetailTab] = useState<DetailTab>('comparison');
  /** Phase ζ: cheat-sheet overlay toggle, opened via `?` key. */
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  // Phase δ: resultsFilter is no longer local — the shared filterState
  // above drives row filtering too.
  const [selectedRow, setSelectedRow] = useState<SessionResultRow | null>(null);
  /**
   * Whether the next evaluation (and the current /results plan) should
   * include LM second-pass for target misses. Lifted up from
   * PlanAndEvaluate so refreshResults can pass the same flag — otherwise
   * the plan reports "All cached" even when LM cache misses exist.
   */
  const [invokeLm, setInvokeLm] = useState(false);
  /**
   * Monotonic counter incremented when the keyboard shortcut for "open
   * accept dialog" fires. ComparisonDetail watches it and opens the form
   * on each tick. This avoids passing a boolean that we'd then need to
   * remember to reset.
   */
  const [acceptDialogTrigger, setAcceptDialogTrigger] = useState(0);
  const [clusterAcceptTrigger, setClusterAcceptTrigger] = useState(0);
  const [clusterRejectTrigger, setClusterRejectTrigger] = useState(0);
  const [clusterRefreshTrigger, setClusterRefreshTrigger] = useState(0);
  /**
   * Review state of the cluster currently shown in the detail pane.
   * Lifted out of ClusterDetailPanel so ActionsMenu can correctly
   * disable Accept (when already accepted) and Reject (when not yet
   * accepted). Refreshed via onClusterLoaded from the panel.
   */
  const [focusedClusterReviewState, setFocusedClusterReviewState] =
    useState<import('@visual-compare/api/types').ClusterReviewState | null>(null);
  /**
   * Cluster detail DTO for the currently focused cluster, lifted out of
   * ClusterDetailPanel so the inline Members list under the focused row
   * in ClustersTab can read the same members + representative. Populated
   * by the panel's onDataLoaded callback.
   */
  const [focusedClusterDetail, setFocusedClusterDetail] = useState<
    import('@visual-compare/api/types').ClusterDetailDto | null
  >(null);
  /**
   * Which member of the focused cluster is currently in the image triple.
   * Lifted from ClusterDetailPanel so the inline Members list in
   * ClustersTab drives the same focus. `null` falls back to the
   * cluster's representative.
   */
  const [focusedMemberId, setFocusedMemberId] = useState<string | null>(null);
  // Reset the cached review state + member focus + cluster detail whenever
  // focus moves to a different cluster (or clears). The detail panel
  // re-fires onClusterLoaded / onDataLoaded once the new cluster's data
  // lands.
  useEffect(() => {
    setFocusedClusterReviewState(null);
    setFocusedMemberId(null);
    setFocusedClusterDetail(null);
  }, [focusedClusterId]);
  /**
   * Sticky toasts surfaced after each cluster Recapture's index recompute
   * finishes. Each carries the original clusterId so the user can jump
   * back to it — useful when the cluster has been emptied or shrunk by
   * the recompute. Toasts stack so multiple in-flight recaptures don't
   * clobber each other; dismissal is per-toast.
   */
  const [clusterRecaptureToasts, setClusterRecaptureToasts] = useState<
    Array<{ id: string; clusterId: string }>
  >([]);
  const [lastUsedLabel, setLastUsedLabel] = useState<string | null>(null);

  const refreshResults = useCallback(async () => {
    try {
      const r = await api.getResults(id, invokeLm ? { invoke_lm: true } : undefined);
      setResults(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id, invokeLm]);

  const refreshAcceptances = useCallback(async () => {
    try {
      const r = await api.listAcceptances(id);
      setAcceptances(r.acceptances);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  const refreshEvaluations = useCallback(async () => {
    try {
      const e = await api.listEvaluations(id);
      setEvaluations(e.evaluations);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  const refreshPairs = useCallback(async () => {
    try {
      const sess = await api.getSession(id);
      setPairs(sess.url_pairs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  const refreshHistory = useCallback(async () => {
    try {
      const [cap, comp] = await Promise.all([
        api.listCaptureRuns(id),
        api.listComparisonRuns(id),
      ]);
      setCaptureRuns(cap.capture_runs);
      setComparisonRuns(comp.comparison_runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    void (async () => {
      try {
        const [sess, vp, lv] = await Promise.all([
          api.getSession(id),
          api.getViewports(),
          api.getLevels(),
        ]);
        setSession(sess.session);
        setConfig(sess.config);
        setPairs(sess.url_pairs);
        setViewports(vp.viewports);
        setDefaultViewportName(vp.default);
        setLevels(lv.levels);
        setDefaultLevel(lv.default);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [id]);

  // Once the static bits load, fetch the dynamic plan/results.
  useEffect(() => {
    if (!session) return;
    void refreshResults();
    void refreshAcceptances();
    void refreshEvaluations();
    void refreshHistory();
  }, [session, refreshResults, refreshAcceptances, refreshEvaluations, refreshHistory]);

  // Live refresh while work is outstanding. Uses the delta protocol on
  // /results: each tick fetches a tiny payload (plan + summary +
  // latest_evaluation + changed_pair_keys + cursor) without the row array.
  // If anything actually changed since the last cursor, we make a second
  // call with ?keys=... to fetch just those rows and merge them in. This
  // keeps polling bandwidth ~O(1) regardless of session size — full
  // /results (which can be megabytes for 5K-pair sessions) only fires on
  // initial mount and on user-triggered refreshes.
  const evalRunning =
    evaluations[0]?.status === 'running' || evaluations[0]?.status === 'pending';
  const shouldPoll =
    evalRunning ||
    (results?.plan.capture_misses ?? 0) > 0 ||
    (results?.plan.comparison_misses ?? 0) > 0;
  // Cursor is updated in-place via a ref so the polling effect doesn't have
  // to depend on it (which would tear down/restart the interval each tick).
  const cursorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!session || !shouldPoll) return;
    if (cursorRef.current === null) cursorRef.current = new Date().toISOString();
    let cancelled = false;
    const tick = async () => {
      const since = cursorRef.current ?? new Date().toISOString();
      try {
        const delta = await api.getResults(
          id,
          invokeLm ? { invoke_lm: true } : undefined,
          { since },
        );
        if (cancelled) return;
        // Update header counts + summary chips + latest eval from the
        // (small) delta payload, leaving the rows array untouched.
        setResults((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            plan: delta.plan,
            summary: delta.summary,
            // Keep results from the previous payload; we'll merge changed
            // rows below if needed.
            results: prev.results,
          };
        });
        if (delta.latest_evaluation) {
          setEvaluations((prev) => {
            const head = delta.latest_evaluation!;
            if (prev[0]?.id === head.id) {
              const next = [...prev];
              next[0] = head;
              return next;
            }
            // Fresh evaluation we hadn't seen — prepend; full re-fetch is
            // unnecessary and adds round-trips.
            return [head, ...prev.filter((e) => e.id !== head.id)];
          });
        }
        if (delta.cursor) cursorRef.current = delta.cursor;

        const changed = delta.changed_pair_keys ?? [];
        if (changed.length === 0) return;

        // The `?keys=` followup encodes the changed keys in the URL. Each
        // key is ~45 chars, and Node's default --max-http-header-size is
        // 8 KB; somewhere around 100 keys we'd risk a 431 from the dev
        // server proxy. When the delta is that large (e.g. a server restart
        // bulk-flips thousands of pending rows in one go), just do a full
        // refresh — the row set is small enough that one big payload beats
        // chunking the URL into many requests.
        const MAX_DELTA_KEYS = 100;
        if (changed.length > MAX_DELTA_KEYS) {
          await refreshResults();
          return;
        }

        const rowsResponse = await api.getResults(
          id,
          invokeLm ? { invoke_lm: true } : undefined,
          { keys: changed },
        );
        if (cancelled) return;
        // Merge the changed rows into the existing array, keyed by
        // url_pair_id::viewport_name. New rows (didn't exist before) are
        // appended; existing rows are replaced in place to preserve order.
        setResults((prev) => {
          if (!prev) return prev;
          const byKey = new Map<string, SessionResultRow>();
          for (const r of rowsResponse.results) {
            byKey.set(`${r.url_pair_id}::${r.viewport_name}`, r);
          }
          const merged = prev.results.map((r) => {
            const k = `${r.url_pair_id}::${r.viewport_name}`;
            const updated = byKey.get(k);
            if (updated) {
              byKey.delete(k);
              return updated;
            }
            return r;
          });
          for (const r of byKey.values()) merged.push(r);
          return { ...prev, results: merged };
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    const handle = window.setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [session, shouldPoll, id, invokeLm]);

  // Reset the cursor whenever a full refresh happens (initial load or
  // explicit user actions). The next delta poll then picks up changes since
  // that moment.
  useEffect(() => {
    if (results) cursorRef.current = new Date().toISOString();
  }, [results?.session_id]);

  // Phase ζ: page-level keyboard shortcuts.
  // - 1/2/3 switch mode (works regardless of focus).
  // - c in Rows mode jumps to the selected row's primary cluster.
  // - ? toggles the shortcuts cheat-sheet overlay.
  // - Escape closes the overlay when open.
  // SessionResultsList still owns j/k/a/A/r/Escape inside Rows mode;
  // those don't overlap with the global keys handled here.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore typing into form controls / contenteditable.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (target.isContentEditable) return;
      }
      // Always handle Escape closing the overlay so it works even with
      // a modifier (rare but harmless).
      if (e.key === 'Escape' && showShortcuts) {
        e.preventDefault();
        setShowShortcuts(false);
        return;
      }
      // Don't compete with browser/system modifier shortcuts.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '?') {
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }
      if (e.key === '1') { e.preventDefault(); setMode('clusters'); return; }
      if (e.key === '2') { e.preventDefault(); setMode('rows'); return; }
      if (e.key === '3') { e.preventDefault(); setMode('anomalies'); return; }
      if (e.key === 'c' && !e.shiftKey) {
        // Row → cluster jump. Only meaningful in Rows mode with a
        // selected row that has a cluster.
        if (mode !== 'rows') return;
        const clusterId = selectedRow?.cluster_id ?? null;
        if (!clusterId) return;
        e.preventDefault();
        const sp = new URLSearchParams(searchParams);
        sp.delete('mode');
        sp.set('focus', clusterId);
        setSearchParams(sp, { replace: true });
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showShortcuts, mode, selectedRow, setMode, searchParams, setSearchParams]);

  const handleEvaluationComplete = () => {
    void refreshResults();
    void refreshEvaluations();
    void refreshHistory();
  };

  const handleAcceptShortcut = (row: SessionResultRow | null) => {
    if (!row?.matched_at_level || !row.capture_a_sha || !row.capture_b_sha) return;
    setSidebarTab('review');
    setDetailTab('comparison');
    setAcceptDialogTrigger((v) => v + 1);
  };

  const handleQuickAcceptShortcut = async (row: SessionResultRow | null) => {
    if (!session) return;
    if (!row?.matched_at_level || !row.capture_a_sha || !row.capture_b_sha) return;
    if (!row.comparison_id) return;
    try {
      const detail = await api.getComparisonDetail(row.comparison_id);
      const regions = detail.differences
        .filter((d) => d.source === 'imagick' && d.bounding_box)
        .map((d) => d.bounding_box!);
      await api.createAcceptance(session.id, {
        url_pair_id: row.url_pair_id,
        viewport_name: row.viewport_name,
        accepted_level: row.matched_at_level,
        accepted_pixel_pct: row.pixel?.changed_pct ?? null,
        accepted_ssim: row.pixel?.ssim ?? null,
        accepted_diff_regions: regions,
        accepted_capture_a_sha: row.capture_a_sha,
        accepted_capture_b_sha: row.capture_b_sha,
        accept_any: false,
        label: lastUsedLabel,
      });
      void refreshAcceptances();
      void refreshResults();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleClearShortcut = async (row: SessionResultRow | null) => {
    if (!session || !row) return;
    const target = acceptances.find(
      (a) => a.url_pair_id === row.url_pair_id && a.viewport_name === row.viewport_name,
    );
    if (!target) return;
    try {
      await api.deleteAcceptance(session.id, target.id);
      void refreshAcceptances();
      void refreshResults();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConfigSaved = (next: SessionConfig) => {
    setConfig(next);
    void refreshResults();
  };

  const handleArchive = async () => {
    if (!session) return;
    setBusy(true);
    try {
      const next = await api.patchSession(session.id, { archived: !session.archived_at });
      setSession(next.session);
      setConfig(next.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleInvalidateAll = async () => {
    if (!session) return;
    if (!confirm('Drop every cached capture for this session?')) return;
    setBusy(true);
    try {
      await api.invalidateCaptures(session.id, {});
      await refreshResults();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Cluster Recapture: kicks off the eval, then once it finishes we
  // recompute the cluster index (the new differences may have shifted
  // members between clusters, populated new ones, or emptied existing
  // ones). If the user is still viewing the cluster we recaptured, bump
  // its refresh trigger so the detail pane re-fetches the updated
  // membership. The user may have navigated to a different cluster by
  // the time recompute finishes — in that case we only recompute the
  // index and skip the local refresh.
  const handleClusterRecapture = (clusterId: string) => {
    if (!session) return;
    const sessionId = session.id;
    const focusedAtClickTime = clusterId;
    void (async () => {
      try {
        const { evaluation_id } = await api.recaptureCluster(sessionId, clusterId);
        // Immediate refresh so the header surfaces the new eval right away.
        void Promise.all([refreshEvaluations(), refreshResults()]);
        const finalEval = await api.waitForEvaluation(evaluation_id);
        if (!finalEval || finalEval.status !== 'complete') return;
        // Recompute the cluster index off the new differences. Server-side
        // also re-applies standing rules so accepted clusters stay accepted.
        await api.listClusters(sessionId, { recompute: true });
        if (focusedClusterId === focusedAtClickTime) {
          setClusterRefreshTrigger((v) => v + 1);
        }
        // Sticky toast — the recompute may have emptied or shrunk the
        // original cluster (members moved to differently-shaped signatures
        // after recapture), so we surface a jump-back link rather than
        // silently letting the user lose their place. Append (don't
        // overwrite) so concurrent recaptures all get their own toast.
        setClusterRecaptureToasts((prev) => [
          ...prev,
          { id: crypto.randomUUID(), clusterId: focusedAtClickTime },
        ]);
        // Results / evaluations may have new cache_hits and a fresh
        // completed_at; refresh once more so the header settles.
        void Promise.all([refreshEvaluations(), refreshResults()]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  };

  if (error && !session) return <main><div className="error">{error}</div></main>;
  if (!session || !config) return <main><p className="muted">Loading…</p></main>;

  const lastEval = evaluations[0];

  const cacheHits = results?.plan.cache_hits;

  return (
    <main className="wide">
      {clusterRecaptureToasts.length > 0 && (
        <div className="cluster-recapture-toast-stack" aria-live="polite">
          {clusterRecaptureToasts.map((t) => (
            <div key={t.id} className="cluster-recapture-toast" role="status">
              <span className="cluster-recapture-toast__msg">
                Cluster index refreshed. Members may have moved — the original
                cluster could be empty now.
              </span>
              <button
                type="button"
                className="cluster-recapture-toast__link"
                onClick={() => {
                  const sp = new URLSearchParams(searchParams);
                  sp.delete('mode'); // clusters is the canonical default
                  sp.set('focus', t.clusterId);
                  setSearchParams(sp, { replace: false });
                  setClusterRecaptureToasts((prev) =>
                    prev.filter((x) => x.id !== t.id),
                  );
                }}
              >
                View cluster →
              </button>
              <button
                type="button"
                className="cluster-recapture-toast__close"
                onClick={() =>
                  setClusterRecaptureToasts((prev) =>
                    prev.filter((x) => x.id !== t.id),
                  )
                }
                aria-label="Dismiss"
                title="Dismiss"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <header className="project-header">
        <div className="project-header-top">
          <p className="breadcrumb">
            <Link to="/" className="brand">visual-compare</Link>
            <span className="sep">/</span>
            <Link to="/">Sessions</Link>
            <span className="sep">/</span>
            <span className="title">{session.name}</span>
            {session.archived_at && <span className="muted"> (archived)</span>}
          </p>
          <div className="project-header-actions">
            <button className="btn secondary" onClick={() => void handleInvalidateAll()} disabled={busy}>
              Recapture all
            </button>
            <button className="btn secondary" onClick={() => void handleArchive()} disabled={busy}>
              {session.archived_at ? 'Unarchive' : 'Archive'}
            </button>
            <LmStatusPill />
          </div>
        </div>
        <div className="project-header-bottom">
          <p className="muted project-meta">
            {pairs.length} URL pair{pairs.length === 1 ? '' : 's'}
            {cacheHits
              ? ` · cache c:${cacheHits.captures} p:${cacheHits.pixel} l:${cacheHits.lm}`
              : ''}
            {lastEval ? ` · last evaluated ${formatRelative(lastEval.started_at)}` : ' · not yet evaluated'}
          </p>
          <PlanAndEvaluate
            sessionId={session.id}
            results={results}
            invokeLm={invokeLm}
            onInvokeLmChange={setInvokeLm}
            onEvaluationComplete={handleEvaluationComplete}
            latestEvaluation={lastEval ?? null}
          />
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="mode-tabs" role="tablist" aria-label="Review mode">
        {MODE_VALUES.map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={`mode-tab${mode === m ? ' mode-tab--active' : ''}`}
            onClick={() => setMode(m)}
          >
            {m === 'clusters' ? 'Clusters' : m === 'rows' ? 'Rows' : 'Anomalies'}
          </button>
        ))}
      </div>

      <FilterStrip
        mode={mode}
        state={filterState}
        onChange={setFilterState}
      />


      {mode === 'clusters' && (
        <div className={`mode-body ${focusedClusterId ? 'mode-body--split' : 'mode-body--full'}`}>
          <div className="mode-body__list">
            <ClustersTab
              sessionId={session.id}
              filter={filterState}
              onClusterFocus={setFocusedClusterId}
              focusedClusterId={focusedClusterId}
              focusedClusterDetail={focusedClusterDetail}
              focusedMemberId={focusedMemberId}
              onMemberFocus={setFocusedMemberId}
            />
          </div>
          {focusedClusterId && (
            <div className="mode-body__pane">
              <DetailPane
                sessionId={session.id}
                focused={{ kind: 'cluster', clusterId: focusedClusterId }}
                onClose={() => setFocusedClusterId(null)}
                onClusterChanged={() => void refreshResults()}
                onClusterLoaded={(cluster) => setFocusedClusterReviewState(cluster.review_state)}
                onClusterDataLoaded={setFocusedClusterDetail}
                clusterAcceptDialogTrigger={clusterAcceptTrigger}
                clusterRejectDialogTrigger={clusterRejectTrigger}
                clusterRefreshTrigger={clusterRefreshTrigger}
                focusedMemberId={focusedMemberId}
                onMemberFocus={setFocusedMemberId}
                actionsSlot={
                  <ActionsMenu
                    sessionId={session.id}
                    focused={{ kind: 'cluster', clusterId: focusedClusterId }}
                    clusterReviewState={focusedClusterReviewState}
                    onClusterAccept={() => setClusterAcceptTrigger((v) => v + 1)}
                    onClusterReject={() => setClusterRejectTrigger((v) => v + 1)}
                    onClusterRecapture={() => handleClusterRecapture(focusedClusterId)}
                  />
                }
              />
            </div>
          )}
        </div>
      )}

      {mode === 'anomalies' && (
        <div className={`mode-body ${focusedClusterId ? 'mode-body--split' : 'mode-body--full'}`}>
          <div className="mode-body__list">
            <AnomaliesTab
              sessionId={session.id}
              filter={filterState}
              onClusterFocus={setFocusedClusterId}
              focusedClusterId={focusedClusterId}
            />
          </div>
          {focusedClusterId && (
            <div className="mode-body__pane">
              <DetailPane
                sessionId={session.id}
                focused={{ kind: 'cluster', clusterId: focusedClusterId }}
                onClose={() => setFocusedClusterId(null)}
                onClusterChanged={() => void refreshResults()}
                onClusterLoaded={(cluster) => setFocusedClusterReviewState(cluster.review_state)}
                onClusterDataLoaded={setFocusedClusterDetail}
                clusterAcceptDialogTrigger={clusterAcceptTrigger}
                clusterRejectDialogTrigger={clusterRejectTrigger}
                clusterRefreshTrigger={clusterRefreshTrigger}
                focusedMemberId={focusedMemberId}
                onMemberFocus={setFocusedMemberId}
                actionsSlot={
                  <ActionsMenu
                    sessionId={session.id}
                    focused={{ kind: 'cluster', clusterId: focusedClusterId }}
                    clusterReviewState={focusedClusterReviewState}
                    onClusterAccept={() => setClusterAcceptTrigger((v) => v + 1)}
                    onClusterReject={() => setClusterRejectTrigger((v) => v + 1)}
                    onClusterRecapture={() => handleClusterRecapture(focusedClusterId)}
                  />
                }
              />
            </div>
          )}
        </div>
      )}

      {mode === 'rows' && (
      <div className="project-body">
        <aside className="project-sidebar">
          <div className="tab-bar" role="tablist" aria-label="Sidebar view">
            <button
              type="button"
              role="tab"
              aria-selected={sidebarTab === 'review'}
              className={`tab ${sidebarTab === 'review' ? 'active' : ''}`}
              onClick={() => setSidebarTab('review')}
            >
              Review {results ? <span className="muted">({results.results.length})</span> : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sidebarTab === 'config'}
              className={`tab ${sidebarTab === 'config' ? 'active' : ''}`}
              onClick={() => setSidebarTab('config')}
            >
              Config
            </button>
          </div>

          {sidebarTab === 'review' ? (
            <ReviewSidebar
              sessionId={session.id}
              onRecaptured={() => void refreshResults()}
              results={results}
              targetLevel={config.default_equivalence_level}
              filter={filterState}
              onFilterChange={setFilterState}
              selectedKey={selectedRowKey}
              onSelect={(key, row) => {
                setSelectedRowKey(key);
                setSelectedRow(row);
                if (key !== null) setDetailTab('comparison');
              }}
              onAcceptShortcut={handleAcceptShortcut}
              onQuickAcceptShortcut={(r) => void handleQuickAcceptShortcut(r)}
              onClearShortcut={(r) => void handleClearShortcut(r)}
            />
          ) : (
            <SessionConfigPanel
              sessionId={session.id}
              config={config}
              viewports={viewports}
              levels={levels}
              defaults={{ viewportName: defaultViewportName, level: defaultLevel }}
              onSaved={handleConfigSaved}
            />
          )}
        </aside>

        <section className="project-detail">
          <div className="tab-bar" role="tablist" aria-label="Detail view">
            <button
              type="button"
              role="tab"
              aria-selected={detailTab === 'comparison'}
              className={`tab ${detailTab === 'comparison' ? 'active' : ''}`}
              onClick={() => setDetailTab('comparison')}
            >
              Comparison
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={detailTab === 'history'}
              className={`tab ${detailTab === 'history' ? 'active' : ''}`}
              onClick={() => setDetailTab('history')}
            >
              History {evaluations.length > 0 ? <span className="muted">({evaluations.length})</span> : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={detailTab === 'pairs'}
              className={`tab ${detailTab === 'pairs' ? 'active' : ''}`}
              onClick={() => setDetailTab('pairs')}
            >
              URL pairs <span className="muted">({pairs.length})</span>
            </button>
          </div>

          {detailTab === 'comparison' && (
            selectedRow && !selectedRow.comparison_id ? (
              <PendingRowDetail row={selectedRow} />
            ) : (
              <DetailPane
                sessionId={session.id}
                focused={
                  selectedRow?.comparison_id
                    ? { kind: 'row', comparisonId: selectedRow.comparison_id, row: selectedRow }
                    : null
                }
                targetLevel={config.default_equivalence_level}
                acceptance={
                  selectedRow
                    ? acceptances.find(
                        (a) =>
                          a.url_pair_id === selectedRow.url_pair_id &&
                          a.viewport_name === selectedRow.viewport_name,
                      ) ?? null
                    : null
                }
                openAcceptDialogTrigger={acceptDialogTrigger}
                onAcceptanceChanged={(label) => {
                  if (label !== undefined) setLastUsedLabel(label);
                  void refreshAcceptances();
                  void refreshResults();
                }}
                onRecaptureStarted={() => void refreshEvaluations()}
                actionsSlot={
                  selectedRow?.comparison_id ? (
                    <ActionsMenu
                      sessionId={session.id}
                      focused={{
                        kind: 'row',
                        comparisonId: selectedRow.comparison_id,
                        row: selectedRow,
                      }}
                      onRowAccept={handleAcceptShortcut}
                      onRowQuickAccept={(r) => void handleQuickAcceptShortcut(r)}
                      onRowClear={(r) => void handleClearShortcut(r)}
                      onRowAcceptCluster={(clusterId) => {
                        // Jump to Clusters mode with the cluster focused
                        // and immediately tick the accept-dialog trigger.
                        const sp = new URLSearchParams(searchParams);
                        sp.delete('mode'); // clusters is canonical default
                        sp.set('focus', clusterId);
                        setSearchParams(sp, { replace: true });
                        setClusterAcceptTrigger((v) => v + 1);
                      }}
                      onRowShowCluster={(clusterId) => {
                        const sp = new URLSearchParams(searchParams);
                        sp.delete('mode');
                        sp.set('focus', clusterId);
                        setSearchParams(sp, { replace: true });
                      }}
                    />
                  ) : null
                }
              />
            )
          )}

          {detailTab === 'history' && (
            <HistoryTab
              evaluations={evaluations}
              captureRuns={captureRuns}
              comparisonRuns={comparisonRuns}
              expandedEvaluationId={expandedEvaluationId}
              onToggleEvaluation={(id) =>
                setExpandedEvaluationId((cur) => (cur === id ? null : id))
              }
            />
          )}

          {detailTab === 'pairs' && (
            <UrlPairsEditor
              sessionId={session.id}
              pairs={pairs}
              onChange={() => {
                void refreshPairs();
                void refreshResults();
              }}
            />
          )}
        </section>
      </div>
      )}

      {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}
    </main>
  );
}

interface HistoryTabProps {
  evaluations: EvaluationStatusDto[];
  captureRuns: CaptureRunRow[];
  comparisonRuns: ComparisonRunRow[];
  expandedEvaluationId: string | null;
  onToggleEvaluation: (id: string) => void;
}

function HistoryTab({
  evaluations,
  captureRuns,
  comparisonRuns,
  expandedEvaluationId,
  onToggleEvaluation,
}: HistoryTabProps): JSX.Element {
  if (evaluations.length === 0 && captureRuns.length === 0 && comparisonRuns.length === 0) {
    return (
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          No history yet — press Evaluate above.
        </p>
      </div>
    );
  }
  return (
    <>
      {evaluations.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Evaluations</h3>
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Started</th>
                <th>Status</th>
                <th>Pairs</th>
                <th>Cache hits</th>
                <th>Capture run</th>
                <th>Comparison runs</th>
              </tr>
            </thead>
            <tbody>
              {evaluations.map((e) => {
                const open = expandedEvaluationId === e.id;
                return (
                  <Fragment key={e.id}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          className="btn secondary"
                          style={{ padding: '0 6px', fontSize: 12 }}
                          onClick={() => onToggleEvaluation(e.id)}
                        >
                          {open ? '▾' : '▸'}
                        </button>
                      </td>
                      <td>{formatDate(e.started_at)}</td>
                      <td>{e.status}</td>
                      <td>{e.enabled_pair_count}</td>
                      <td className="muted">
                        c:{e.cache_hits.captures} p:{e.cache_hits.pixel} l:{e.cache_hits.lm}
                      </td>
                      <td className="muted">{e.capture_run_id?.slice(0, 8) ?? '—'}</td>
                      <td className="muted">{e.comparison_run_id ? e.comparison_run_id.slice(0, 8) : '—'}</td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={7}>
                          <EvaluationDetail evaluation={e} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {captureRuns.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Capture runs</h3>
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Viewports</th>
                <th>Run id</th>
              </tr>
            </thead>
            <tbody>
              {captureRuns.map((r) => (
                <tr key={r.id}>
                  <td>{formatDate(r.created_at)}</td>
                  <td>{parseViewports(r.options_json)}</td>
                  <td className="muted">{r.id.slice(0, 8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {comparisonRuns.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Comparison runs</h3>
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Run id</th>
              </tr>
            </thead>
            <tbody>
              {comparisonRuns.map((r) => (
                <tr key={r.id}>
                  <td>{formatDate(r.created_at)}</td>
                  <td className="muted">{r.id.slice(0, 8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function parseViewports(optionsJson: string): string {
  try {
    const opts = JSON.parse(optionsJson) as { viewports?: { name: string }[] };
    return opts.viewports?.map((v) => v.name).join(', ') ?? '—';
  } catch {
    return '—';
  }
}

interface ReviewSidebarProps {
  results: SessionResultsDto | null;
  targetLevel: EquivalenceLevelId;
  filter: FilterState;
  onFilterChange: (next: FilterState) => void;
  selectedKey: string | null;
  onSelect: (key: string | null, row: SessionResultRow | null) => void;
  onAcceptShortcut?: (row: SessionResultRow | null) => void;
  onQuickAcceptShortcut?: (row: SessionResultRow | null) => void;
  onClearShortcut?: (row: SessionResultRow | null) => void;
  sessionId: string;
  onRecaptured: () => void;
}

function ReviewSidebar({
  results,
  targetLevel,
  filter,
  onFilterChange,
  selectedKey,
  onSelect,
  onAcceptShortcut,
  onQuickAcceptShortcut,
  onClearShortcut,
  sessionId,
  onRecaptured,
}: ReviewSidebarProps): JSX.Element {
  if (!results) {
    return <p className="muted" style={{ padding: 12 }}>Loading results…</p>;
  }
  if (results.results.length === 0) {
    return (
      <p className="muted" style={{ padding: 12, margin: 0 }}>
        No results yet — press Evaluate above.
      </p>
    );
  }

  return (
    <SessionResultsList
      results={results.results}
      summary={results.summary}
      targetLevel={targetLevel}
      selectedKey={selectedKey}
      onSelect={onSelect}
      filter={filter}
      onFilterChange={onFilterChange}
      onAcceptShortcut={onAcceptShortcut}
      onQuickAcceptShortcut={onQuickAcceptShortcut}
      onClearShortcut={onClearShortcut}
      sessionId={sessionId}
      onRecaptured={onRecaptured}
    />
  );
}

function PendingRowDetail({ row }: { row: SessionResultRow }): JSX.Element {
  type SideInfo = {
    side: 'A' | 'B';
    url: string;
    info: SessionResultRow['capture_a_status'];
    sha: string | null;
    isMissing: boolean;
  };
  const sides: SideInfo[] = [
    {
      side: 'A',
      url: row.url_a,
      info: row.capture_a_status,
      sha: row.capture_a_sha,
      isMissing: row.pair_outcome === 'a_missing' || row.pair_outcome === 'both_missing',
    },
    {
      side: 'B',
      url: row.url_b,
      info: row.capture_b_status,
      sha: row.capture_b_sha,
      isMissing: row.pair_outcome === 'b_missing' || row.pair_outcome === 'both_missing',
    },
  ];
  const anyError = sides.some((s) => s.info.status === 'error');

  return (
    <div className="card">
      {anyError ? (
        <>
          <h3 style={{ marginTop: 0, color: '#f87171' }}>Capture failed</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            One or both captures errored. The next evaluation won&rsquo;t retry automatically — fix
            the underlying issue (page reachability, hide-selectors, settle delay), then{' '}
            <em>Recapture all</em> at the top to clear the cache and re-attempt.
          </p>
        </>
      ) : (
        <>
          <h3 style={{ marginTop: 0 }}>Pending</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            No comparison verdict for this row yet. Press <em>Evaluate</em> above to run the
            captures and comparisons it depends on.
          </p>
        </>
      )}
      <div className="capture-status-grid">
        {sides.map((s) => (
          <PendingSideCard key={s.side} {...s} />
        ))}
      </div>
    </div>
  );
}

function PendingSideCard({
  side,
  url,
  info,
  sha,
  isMissing,
}: {
  side: 'A' | 'B';
  url: string;
  info: SessionResultRow['capture_a_status'];
  sha: string | null;
  isMissing: boolean;
}): JSX.Element {
  const chipClass =
    info.status === 'error' ? 'fail' : info.status === 'complete' ? 'pass' : 'pending';
  const statusLabel = info.status === 'in_progress' ? 'in progress' : info.status;
  const imageSrc = sha ? `/images/sha256/${sha.slice(0, 2)}/${sha}.png` : null;
  const placeholder = isMissing
    ? 'Page missing on this side'
    : info.status === 'in_progress'
      ? 'Capture in progress…'
      : info.status === 'error'
        ? 'Capture failed'
        : 'Not captured yet';

  return (
    <div className={`capture-status capture-status-${info.status}`}>
      <div className="capture-status-head">
        <span className={`chip ${chipClass}`}>Side {side} · {statusLabel}</span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="capture-status-url"
          title={url}
        >
          {url}
        </a>
      </div>
      {imageSrc ? (
        <a
          href={imageSrc}
          target="_blank"
          rel="noopener noreferrer"
          className="capture-status-image-link"
        >
          <img
            src={imageSrc}
            alt={`Side ${side} screenshot`}
            loading="lazy"
            className="capture-status-image"
          />
        </a>
      ) : (
        <div className="capture-status-placeholder">{placeholder}</div>
      )}
      {info.error_message && (
        <pre className="capture-error">{info.error_message}</pre>
      )}
    </div>
  );
}

function EvaluationDetail({ evaluation }: { evaluation: EvaluationStatusDto }): JSX.Element {
  const config = evaluation.config as
    | {
        viewports?: { name: string }[];
        target_level?: string;
        filter_query?: Record<string, unknown>;
        capture_options?: { hideSelectors?: string[]; settleDelayMs?: number };
      }
    | null;
  return (
    <div className="evaluation-detail">
      <div className="kv">
        <span className="muted">Viewports:</span>
        <span>{config?.viewports?.map((v) => v.name).join(', ') ?? '—'}</span>
      </div>
      <div className="kv">
        <span className="muted">Target level:</span>
        <span>{config?.target_level ?? '—'}</span>
      </div>
      {config?.capture_options?.hideSelectors && config.capture_options.hideSelectors.length > 0 && (
        <div className="kv">
          <span className="muted">Hide selectors:</span>
          <span>{config.capture_options.hideSelectors.join(', ')}</span>
        </div>
      )}
      {config?.filter_query && Object.keys(config.filter_query).length > 0 && (
        <div className="kv">
          <span className="muted">Filter:</span>
          <code>{JSON.stringify(config.filter_query)}</code>
        </div>
      )}
      <div className="kv">
        <span className="muted">Cache hits:</span>
        <span>
          captures {evaluation.cache_hits.captures} · pixel {evaluation.cache_hits.pixel} · lm {evaluation.cache_hits.lm}
        </span>
      </div>
      {evaluation.error_message && (
        <div className="kv">
          <span className="muted">Error:</span>
          <span className="error" style={{ display: 'inline' }}>{evaluation.error_message}</span>
        </div>
      )}
      {evaluation.completed_at && (
        <div className="kv">
          <span className="muted">Completed:</span>
          <span>{formatDate(evaluation.completed_at)}</span>
        </div>
      )}
    </div>
  );
}
