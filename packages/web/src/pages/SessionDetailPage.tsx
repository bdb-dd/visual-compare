import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
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
import { LmActivityHistogram } from '../components/LmActivityHistogram.js';
import { WorkerActivityHistogram } from '../components/WorkerActivityHistogram.js';
import { PlanAndEvaluate } from '../components/PlanAndEvaluate.js';
import { SessionConfigPanel } from '../components/SessionConfigPanel.js';
import { SessionResultsList } from '../components/SessionResultsList.js';
import { UrlPairsEditor } from '../components/UrlPairsEditor.js';
import { ErrorLogTab } from '../components/ErrorLogTab.js';
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

type Mode = 'clusters' | 'rows' | 'anomalies' | 'config';
type ConfigSection = 'config' | 'pairs' | 'history' | 'errors';

const MODE_VALUES: readonly Mode[] = ['clusters', 'rows', 'anomalies', 'config'];

function parseMode(raw: string | null): Mode {
  return (MODE_VALUES as readonly string[]).includes(raw ?? '')
    ? (raw as Mode)
    : 'clusters'; // funnel default per implementation plan §β
}

const MODE_LABELS: Record<Mode, string> = {
  clusters: 'Clusters',
  rows: 'Rows',
  anomalies: 'Anomalies',
  config: 'Config',
};

export function SessionDetailPage(): JSX.Element {
  const { id = '' } = useParams();
  // URL schema for this page (Phase 4 audit):
  //   mode    = clusters | rows | anomalies   (clusters omitted as canonical)
  //   focus   = cluster id (clusters / anomalies mode only)
  //   cat     = category tab key (clusters mode only — owned by ClusterTab)
  //   view    = comparison view mode (triple | ab | slider — owned by ClusterDetailPanel)
  //   plus all filter chips (status / level / region / change / outcome) via
  //   `applyFilterStateToParams`.
  //
  // Push vs replace policy:
  //   - Discrete navigations (mode switch, cross-mode jumps, Shift+Arrow,
  //     toast-driven jumps) PUSH so back/forward walks the journey.
  //   - In-place edits (cluster click, filter chip toggle, view-mode
  //     selector) REPLACE so rapid input doesn't flood history.
  const [searchParams, setSearchParams] = useSearchParams();
  const mode = parseMode(searchParams.get('mode'));
  const setMode = useCallback(
    (next: Mode) => {
      const sp = new URLSearchParams(searchParams);
      if (next === 'clusters') sp.delete('mode'); // canonical default → clean URL
      else sp.set('mode', next);
      // Drop focus when switching modes — focus identifiers are mode-specific.
      sp.delete('focus');
      // Mode is a discrete navigation — push so back returns to the
      // previous mode.
      setSearchParams(sp, { replace: false });
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

  // Push-history sibling for keyboard nav (Shift+Arrow). Each step adds a
  // history entry so back/forward walks the cluster sequence — that's the
  // contract for "discrete navigation" gestures, vs. the replace behavior
  // used for clicks (rapid clicks shouldn't flood history).
  const stepFocusedClusterId = useCallback(
    (id: string) => {
      const sp = new URLSearchParams(searchParams);
      sp.set('focus', id);
      setSearchParams(sp, { replace: false });
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
  const [configSection, setConfigSection] = useState<ConfigSection>('config');
  /** Phase ζ: cheat-sheet overlay toggle, opened via `?` key. */
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  // Phase δ: resultsFilter is no longer local — the shared filterState
  // above drives row filtering too.
  const [selectedRow, setSelectedRow] = useState<SessionResultRow | null>(null);
  /**
   * Monotonic counter incremented when the keyboard shortcut for "open
   * accept dialog" fires. ComparisonDetail watches it and opens the form
   * on each tick. This avoids passing a boolean that we'd then need to
   * remember to reset.
   */
  const [acceptDialogTrigger, setAcceptDialogTrigger] = useState(0);
  const [clusterAcceptTrigger, setClusterAcceptTrigger] = useState(0);
  const [clusterRejectTrigger, setClusterRejectTrigger] = useState(0);
  const [clusterSplitTrigger, setClusterSplitTrigger] = useState(0);
  const [clusterRefreshTrigger, setClusterRefreshTrigger] = useState(0);
  // Bumped after cluster-shape-changing actions (Split, Recapture) and
  // state changes (Accept/Reject) so ClustersTab re-fetches its list.
  // Keeps the list in sync with the panel without manual refresh.
  const [clusterListRefreshTrigger, setClusterListRefreshTrigger] = useState(0);
  /**
   * Cluster detail DTO for the currently focused cluster, lifted out of
   * ClusterDetailPanel so:
   *  - the inline Members list under the focused row in ClustersTab can
   *    read the same members + representative;
   *  - the chrome title (rendered by this page into DetailPane's
   *    titleSlot) can show the cluster's label / change-type / state pill
   *    and the chrome action pills can disable themselves based on
   *    review_state without round-tripping through the panel.
   * Populated by the panel's onDataLoaded callback.
   */
  const [focusedClusterDetail, setFocusedClusterDetail] = useState<
    import('@visual-compare/api/types').ClusterDetailDto | null
  >(null);
  /**
   * Which member of each cluster the user last focused, keyed by
   * cluster id. Persists across cluster navigation so revisiting a
   * cluster restores the previously-focused member; the absence of a
   * key falls back to the cluster's representative (handled in
   * ClusterDetailPanel). Kept out of the URL on purpose — share links
   * always open at the representative (per the refactor plan §7.3).
   */
  const [clusterMemberFocus, setClusterMemberFocus] = useState<Map<string, string>>(
    () => new Map(),
  );
  const focusedMemberId = focusedClusterId
    ? clusterMemberFocus.get(focusedClusterId) ?? null
    : null;
  const setFocusedMemberId = useCallback(
    (id: string | null) => {
      if (!focusedClusterId) return;
      setClusterMemberFocus((prev) => {
        const next = new Map(prev);
        if (id === null) next.delete(focusedClusterId);
        else next.set(focusedClusterId, id);
        return next;
      });
    },
    [focusedClusterId],
  );
  // Reset the cached cluster detail whenever focus moves to a different
  // cluster (or clears). The detail panel re-fires onDataLoaded once the
  // new cluster's data lands. Member focus is per-cluster (see
  // clusterMemberFocus above) so it doesn't need to be reset here.
  useEffect(() => {
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
      // No invoke_lm override: the server reads session.default_invoke_lm
      // when planning, which is the source of truth set in the Config tab.
      const r = await api.getResults(id);
      setResults(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  const refreshAcceptances = useCallback(async () => {
    try {
      const r = await api.listAcceptances(id);
      setAcceptances(r.acceptances);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  /**
   * Tracks whether listEvaluations has completed at least once on this
   * page load. The decide-landing effect below waits on this so it can
   * distinguish "no evaluations yet" from "we haven't fetched them yet".
   */
  const evaluationsLoadedRef = useRef(false);
  /** Guards the one-shot landing decision so it doesn't bounce the user later. */
  const initialLandingRef = useRef(false);

  const refreshEvaluations = useCallback(async () => {
    try {
      const e = await api.listEvaluations(id);
      setEvaluations(e.evaluations);
      evaluationsLoadedRef.current = true;
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

  // Reset the landing refs whenever the session id changes so the next
  // mount of a different session re-runs the decision.
  useEffect(() => {
    evaluationsLoadedRef.current = false;
    initialLandingRef.current = false;
  }, [id]);

  // One-shot: if the session has no evaluations yet and the URL doesn't
  // pin a mode, land on Config so the user is dropped into setup rather
  // than an empty Clusters/Rows view. Waits for the initial listEvaluations
  // to resolve so an empty `evaluations` state can't be misread as
  // "no evals" before the fetch has run.
  useEffect(() => {
    if (initialLandingRef.current) return;
    if (!evaluationsLoadedRef.current) return;
    initialLandingRef.current = true;
    if (evaluations.length === 0 && searchParams.get('mode') === null) {
      setMode('config');
    }
  }, [evaluations, searchParams, setMode]);

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
        const delta = await api.getResults(id, undefined, { since });
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

        const rowsResponse = await api.getResults(id, undefined, { keys: changed });
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
    const wrappedTick = (): void => {
      // Skip the network round-trip while the tab is hidden — the next
      // visible tick picks up the cursor and pulls the merged delta.
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void tick();
    };
    const handle = window.setInterval(wrappedTick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [session, shouldPoll, id]);

  // Reset the cursor whenever a full refresh happens (initial load or
  // explicit user actions). The next delta poll then picks up changes since
  // that moment.
  useEffect(() => {
    if (results) cursorRef.current = new Date().toISOString();
  }, [results?.session_id]);

  // Phase ζ: page-level keyboard shortcuts.
  // - 1/2/3/4 switch mode (works regardless of focus).
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
      if (e.key === '4') { e.preventDefault(); setMode('config'); return; }
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
        // Cross-mode jump from a keyboard shortcut — push history so the
        // user can back-button to where they were in Rows mode.
        setSearchParams(sp, { replace: false });
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
    if (!confirm('Start a new evaluation that recaptures every pair in this session?')) return;
    setBusy(true);
    try {
      await api.recapture(session.id, {});
      await Promise.all([refreshEvaluations(), refreshResults()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Pairs whose most recent capture errored on at least one side. Drives
  // the "Recapture failed" header action so the user can retry just the
  // broken captures instead of flushing the whole session cache.
  const failedPairIds = useMemo(() => {
    if (!results) return [];
    const ids = new Set<string>();
    for (const r of results.results) {
      if (
        r.capture_a_status.status === 'error' ||
        r.capture_b_status.status === 'error'
      ) {
        ids.add(r.url_pair_id);
      }
    }
    return Array.from(ids);
  }, [results]);

  const handleInvalidateFailed = async () => {
    if (!session) return;
    if (failedPairIds.length === 0) return;
    if (
      !confirm(
        `Start a new evaluation that recaptures ${failedPairIds.length} pair${
          failedPairIds.length === 1 ? '' : 's'
        } whose last capture failed?`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.recapture(session.id, { pair_ids: failedPairIds });
      await Promise.all([refreshEvaluations(), refreshResults()]);
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

  // Derived chrome bits for the focused cluster. Computed once per detail
  // load + acceptances change so both the title (state pill + counts +
  // partial-acceptance badge) and the action pills (disabled-state) read
  // from the same source. When the detail hasn't loaded yet, leave this
  // null so DetailPane falls back to its default "Cluster" eyebrow until
  // we have real data to show.
  const focusedClusterChrome = useMemo(() => {
    if (!focusedClusterDetail) return null;
    const cluster = focusedClusterDetail.cluster;
    // Only positive acceptances count toward the "X/N accepted" facet —
    // rejected members (tagged with the REJECTED_LABEL_MARKER sentinel in
    // ClusterDetailPanel) ride the same primitive but represent the
    // opposite intent and shouldn't inflate the accepted count.
    const acceptedKeys = new Set(
      acceptances
        .filter((a) => a.label !== '[Rejected]')
        .map((a) => `${a.url_pair_id}::${a.viewport_name}`),
    );
    const partialAccepted = focusedClusterDetail.members.filter((m) =>
      acceptedKeys.has(`${m.url_pair_id}::${m.viewport_name}`),
    ).length;
    return {
      cluster,
      partialAccepted,
      totalMembers: focusedClusterDetail.members.length,
    };
  }, [focusedClusterDetail, acceptances]);

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
            <HeaderOverflowMenu
              archived={!!session.archived_at}
              busy={busy}
              failedCount={failedPairIds.length}
              onRecaptureAll={() => void handleInvalidateAll()}
              onRecaptureFailed={() => void handleInvalidateFailed()}
              onArchiveToggle={() => void handleArchive()}
            />
            <WorkerActivityHistogram />
            <LmActivityHistogram />
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
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      {mode !== 'config' && (
        <FilterStrip
          mode={mode}
          state={filterState}
          onChange={setFilterState}
          viewportOptions={
            (config?.default_viewports.length ?? 0) > 0
              ? config!.default_viewports.map((v) => v.name)
              : viewports.map((v) => v.name)
          }
          sessionId={session.id}
        />
      )}


      {mode === 'clusters' && (
        <div className={`mode-body ${focusedClusterId ? 'mode-body--split' : 'mode-body--full'}`}>
          <div className="mode-body__list">
            <ClustersTab
              sessionId={session.id}
              filter={filterState}
              onClusterFocus={setFocusedClusterId}
              onClusterStep={stepFocusedClusterId}
              focusedClusterId={focusedClusterId}
              focusedClusterDetail={focusedClusterDetail}
              focusedMemberId={focusedMemberId}
              onMemberFocus={setFocusedMemberId}
              acceptances={acceptances}
              refreshTick={clusterListRefreshTrigger}
            />
          </div>
          {focusedClusterId && (
            <div className="mode-body__pane">
              <DetailPane
                sessionId={session.id}
                focused={{ kind: 'cluster', clusterId: focusedClusterId }}
                onClose={() => setFocusedClusterId(null)}
                onClusterChanged={() => {
                  void refreshResults();
                  setClusterListRefreshTrigger((v) => v + 1);
                }}
                onClusterDataLoaded={setFocusedClusterDetail}
                clusterAcceptDialogTrigger={clusterAcceptTrigger}
                clusterRejectDialogTrigger={clusterRejectTrigger}
                clusterSplitDialogTrigger={clusterSplitTrigger}
                clusterRefreshTrigger={clusterRefreshTrigger}
                focusedMemberId={focusedMemberId}
                onMemberFocus={setFocusedMemberId}
                acceptances={acceptances}
                onMemberAcceptanceChanged={() => {
                  void refreshAcceptances();
                  void refreshResults();
                }}
                titleSlot={
                  focusedClusterChrome ? (
                    <ClusterChromeTitle
                      cluster={focusedClusterChrome.cluster}
                      partialAccepted={focusedClusterChrome.partialAccepted}
                      totalMembers={focusedClusterChrome.totalMembers}
                    />
                  ) : undefined
                }
                actionsSlot={
                  focusedClusterChrome ? (
                    <ClusterChromeActions
                      sessionId={session.id}
                      clusterId={focusedClusterId}
                      cluster={focusedClusterChrome.cluster}
                      onAccept={() => setClusterAcceptTrigger((v) => v + 1)}
                      onReject={() => setClusterRejectTrigger((v) => v + 1)}
                      onSplit={() => setClusterSplitTrigger((v) => v + 1)}
                      onRecapture={() => handleClusterRecapture(focusedClusterId)}
                    />
                  ) : null
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
              onClusterStep={stepFocusedClusterId}
              focusedClusterId={focusedClusterId}
            />
          </div>
          {focusedClusterId && (
            <div className="mode-body__pane">
              <DetailPane
                sessionId={session.id}
                focused={{ kind: 'cluster', clusterId: focusedClusterId }}
                onClose={() => setFocusedClusterId(null)}
                onClusterChanged={() => {
                  void refreshResults();
                  setClusterListRefreshTrigger((v) => v + 1);
                }}
                onClusterDataLoaded={setFocusedClusterDetail}
                clusterAcceptDialogTrigger={clusterAcceptTrigger}
                clusterRejectDialogTrigger={clusterRejectTrigger}
                clusterSplitDialogTrigger={clusterSplitTrigger}
                clusterRefreshTrigger={clusterRefreshTrigger}
                focusedMemberId={focusedMemberId}
                onMemberFocus={setFocusedMemberId}
                acceptances={acceptances}
                onMemberAcceptanceChanged={() => {
                  void refreshAcceptances();
                  void refreshResults();
                }}
                titleSlot={
                  focusedClusterChrome ? (
                    <ClusterChromeTitle
                      cluster={focusedClusterChrome.cluster}
                      partialAccepted={focusedClusterChrome.partialAccepted}
                      totalMembers={focusedClusterChrome.totalMembers}
                    />
                  ) : undefined
                }
                actionsSlot={
                  focusedClusterChrome ? (
                    <ClusterChromeActions
                      sessionId={session.id}
                      clusterId={focusedClusterId}
                      cluster={focusedClusterChrome.cluster}
                      onAccept={() => setClusterAcceptTrigger((v) => v + 1)}
                      onReject={() => setClusterRejectTrigger((v) => v + 1)}
                      onSplit={() => setClusterSplitTrigger((v) => v + 1)}
                      onRecapture={() => handleClusterRecapture(focusedClusterId)}
                    />
                  ) : null
                }
              />
            </div>
          )}
        </div>
      )}

      {mode === 'rows' && (
        <div className="project-body">
          <aside className="project-sidebar">
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
              }}
              onAcceptShortcut={handleAcceptShortcut}
              onQuickAcceptShortcut={(r) => void handleQuickAcceptShortcut(r)}
              onClearShortcut={(r) => void handleClearShortcut(r)}
            />
          </aside>

          <section className="project-detail">
            {selectedRow && !selectedRow.comparison_id ? (
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
                        // Cross-mode jump from a row's ActionsMenu — push
                        // so back returns to the originating row view.
                        const sp = new URLSearchParams(searchParams);
                        sp.delete('mode'); // clusters is canonical default
                        sp.set('focus', clusterId);
                        setSearchParams(sp, { replace: false });
                        setClusterAcceptTrigger((v) => v + 1);
                      }}
                      onRowShowCluster={(clusterId) => {
                        const sp = new URLSearchParams(searchParams);
                        sp.delete('mode');
                        sp.set('focus', clusterId);
                        setSearchParams(sp, { replace: false });
                      }}
                    />
                  ) : null
                }
              />
            )}
          </section>
        </div>
      )}

      {mode === 'config' && (
        <div className="config-body">
          <nav className="config-nav" role="tablist" aria-label="Config section">
            <button
              type="button"
              role="tab"
              aria-selected={configSection === 'config'}
              className={configSection === 'config' ? 'active' : ''}
              onClick={() => setConfigSection('config')}
            >
              Config
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={configSection === 'pairs'}
              className={configSection === 'pairs' ? 'active' : ''}
              onClick={() => setConfigSection('pairs')}
            >
              URL pairs <span className="muted">({pairs.length})</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={configSection === 'history'}
              className={configSection === 'history' ? 'active' : ''}
              onClick={() => setConfigSection('history')}
            >
              History {evaluations.length > 0 ? <span className="muted">({evaluations.length})</span> : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={configSection === 'errors'}
              className={configSection === 'errors' ? 'active' : ''}
              onClick={() => setConfigSection('errors')}
            >
              Errors
            </button>
          </nav>

          <section className="config-content">
            {configSection === 'config' && (
              <SessionConfigPanel
                sessionId={session.id}
                config={config}
                viewports={viewports}
                levels={levels}
                defaults={{ viewportName: defaultViewportName, level: defaultLevel }}
                onSaved={handleConfigSaved}
              />
            )}
            {configSection === 'pairs' && (
              <UrlPairsEditor
                sessionId={session.id}
                pairs={pairs}
                onChange={() => {
                  void refreshPairs();
                  void refreshResults();
                }}
              />
            )}
            {configSection === 'history' && (
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
            {configSection === 'errors' && <ErrorLogTab sessionId={session.id} />}
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

/**
 * Inline cluster title for the detail-pane chrome. Replaces the old
 * "CLUSTER" eyebrow + separate h2 layout — label + change_type + state
 * pill + counts badge all live on the chrome row.
 */
function ClusterChromeTitle({
  cluster,
  partialAccepted,
  totalMembers,
}: {
  cluster: import('@visual-compare/api/types').DifferenceClusterRow;
  partialAccepted: number;
  totalMembers: number;
}): JSX.Element {
  const label = cluster.element_label;
  const changeType = cluster.change_type;
  const hasTitleText = !!(label || changeType);
  return (
    <div className="cluster-chrome">
      <span className="cluster-chrome__title">
        {label && <span className="cluster-chrome__label">{label}</span>}
        {label && changeType && <span className="cluster-chrome__sep">·</span>}
        {changeType && (
          <code className="cluster-chrome__change-type">{changeType}</code>
        )}
        {!hasTitleText && <span className="cluster-chrome__label">(unlabelled)</span>}
      </span>
      <span
        className={`facet facet--state facet--state-${cluster.review_state}`}
      >
        {cluster.review_state}
      </span>
      <span
        className="facet cluster-chrome__counts"
        title={`${cluster.member_count} member${cluster.member_count === 1 ? '' : 's'} across ${cluster.pair_count} pair${cluster.pair_count === 1 ? '' : 's'}`}
      >
        {cluster.member_count}/{cluster.pair_count}
      </span>
      {cluster.review_state !== 'accepted' && partialAccepted > 0 && (
        <span className="facet facet--partial-accepted">
          {partialAccepted}/{totalMembers} accepted
        </span>
      )}
    </div>
  );
}

/**
 * Inline Accept / Reject / Split pills + a `⋯` overflow that holds the
 * less-frequent cluster actions (Recapture, Open in new tab). Replaces
 * the old "Actions ▾" dropdown for cluster focus — the row case still
 * uses ActionsMenu, which is friendlier when most items are disabled.
 */
function ClusterChromeActions({
  sessionId,
  clusterId,
  cluster,
  onAccept,
  onReject,
  onSplit,
  onRecapture,
}: {
  sessionId: string;
  clusterId: string;
  cluster: import('@visual-compare/api/types').DifferenceClusterRow;
  onAccept: () => void;
  onReject: () => void;
  onSplit: () => void;
  onRecapture: () => void;
}): JSX.Element {
  const isSyntheticOutcome = cluster.signature_version === 'outcome';
  const syntheticTitle =
    'Outcome buckets are read-only — accept/reject these rows from the Rows view.';
  const acceptDisabled = cluster.review_state === 'accepted' || isSyntheticOutcome;
  const rejectDisabled =
    cluster.review_state === 'rejected' ||
    cluster.review_state === 'split' ||
    isSyntheticOutcome;
  const splitDisabled =
    cluster.member_count < 2 ||
    cluster.review_state === 'split' ||
    isSyntheticOutcome;
  return (
    <>
      <button
        type="button"
        className="btn btn-compact"
        onClick={onAccept}
        disabled={acceptDisabled}
        title={
          isSyntheticOutcome
            ? syntheticTitle
            : cluster.review_state === 'accepted'
              ? 'Already accepted — reject first to re-accept'
              : 'Accept this cluster: snapshot every member pair as accepted'
        }
      >
        Accept cluster
      </button>
      <button
        type="button"
        className="btn btn-compact secondary"
        onClick={onReject}
        disabled={rejectDisabled}
        title={
          isSyntheticOutcome
            ? syntheticTitle
            : cluster.review_state === 'rejected'
              ? 'Already rejected'
              : cluster.review_state === 'split'
                ? 'Split clusters cannot be rejected'
                : cluster.review_state === 'accepted'
                  ? 'Reject this cluster: delete its rule-owned acceptances and flip state to rejected'
                  : 'Reject this cluster'
        }
      >
        Reject
      </button>
      <button
        type="button"
        className="btn btn-compact secondary"
        onClick={onSplit}
        disabled={splitDisabled}
        title={
          isSyntheticOutcome
            ? syntheticTitle
            : cluster.member_count < 2
              ? 'Need at least 2 members to split'
              : cluster.review_state === 'split'
                ? 'Already a split cluster'
                : 'Extract some members into a new cluster'
        }
      >
        Split
      </button>
      <ClusterOverflowMenu
        sessionId={sessionId}
        clusterId={clusterId}
        onRecapture={onRecapture}
      />
    </>
  );
}

function ClusterOverflowMenu({
  sessionId,
  clusterId,
  onRecapture,
}: {
  sessionId: string;
  clusterId: string;
  onRecapture: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);
  return (
    <div className="actions-menu" ref={ref}>
      <button
        type="button"
        className="actions-menu__toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="More cluster actions"
      >
        ⋯
      </button>
      {open && (
        <ul className="actions-menu__list" role="menu">
          <li>
            <button
              type="button"
              role="menuitem"
              className="actions-menu__item"
              onClick={() => {
                setOpen(false);
                onRecapture();
              }}
            >
              Recapture cluster pairs
            </button>
          </li>
          <li>
            <a
              role="menuitem"
              className="actions-menu__item"
              href={`/sessions/${sessionId}/clusters/${clusterId}`}
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(false)}
            >
              Open in new tab ↗
            </a>
          </li>
        </ul>
      )}
    </div>
  );
}

function HeaderOverflowMenu({
  archived,
  busy,
  failedCount,
  onRecaptureAll,
  onRecaptureFailed,
  onArchiveToggle,
}: {
  archived: boolean;
  busy: boolean;
  failedCount: number;
  onRecaptureAll: () => void;
  onRecaptureFailed: () => void;
  onArchiveToggle: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const choose = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="actions-menu" ref={ref}>
      <button
        type="button"
        className="actions-menu__toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        title="More actions"
      >
        ⋯
      </button>
      {open && (
        <ul className="actions-menu__list" role="menu">
          <li>
            <button
              type="button"
              role="menuitem"
              className="actions-menu__item"
              onClick={choose(onRecaptureAll)}
              disabled={busy}
            >
              Recapture all
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
              className="actions-menu__item"
              onClick={choose(onRecaptureFailed)}
              disabled={busy || failedCount === 0}
              title={
                failedCount === 0
                  ? 'No pairs with failed captures'
                  : `Drop cached captures for ${failedCount} pair${
                      failedCount === 1 ? '' : 's'
                    } whose last capture errored`
              }
            >
              Recapture failed{failedCount > 0 ? ` (${failedCount})` : ''}
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
              className="actions-menu__item"
              onClick={choose(onArchiveToggle)}
              disabled={busy}
            >
              {archived ? 'Unarchive' : 'Archive'}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
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
