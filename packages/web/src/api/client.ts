import type {
  AcceptanceRow,
  BoundingBoxPercent,
  CaptureDto,
  CaptureRunRow,
  ClusterDetailDto,
  ClusterListDto,
  ClusterReviewState,
  ComparisonDetailDto,
  ComparisonDto,
  ComparisonRunRow,
  EquivalenceLevelId,
  EvaluationStatusDto,
  JobAcceptedResponse,
  JobRow,
  LmPromptDto,
  LmPromptInvocationReasonDto,
  LmPromptUpdateBodyDto,
  MatchedAtLevel,
  SessionConfig,
  SessionDto,
  SessionResultsDto,
  SessionRow,
  UrlPairRow,
  ViewportDef,
} from '@visual-compare/api/types';
import type { EquivalenceLevelDef } from '@visual-compare/api/constants/equivalence';

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const finalInit: RequestInit =
    method === 'GET' || method === 'HEAD'
      ? init ?? {}
      : {
          ...init,
          headers: { ...(init?.headers as Record<string, string> | undefined), 'X-Requested-With': 'visual-compare' },
        };
  const res = await fetch(input, finalInit);
  const contentType = res.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const message =
      typeof body === 'object' && body && 'message' in body
        ? String((body as { message: unknown }).message)
        : `HTTP ${res.status}`;
    const err = new Error(message) as Error & { status: number; body: unknown };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

export const api = {
  listSessions: (includeArchived = false) =>
    request<{ sessions: SessionDto[] }>(
      `/api/sessions${includeArchived ? '?include_archived=true' : ''}`,
    ),
  getSession: (id: string) =>
    request<{ session: SessionRow; config: SessionConfig; url_pairs: UrlPairRow[] }>(
      `/api/sessions/${id}`,
    ),
  uploadCsv: async (csvFile: File, name?: string): Promise<{ session: SessionRow; url_pairs: UrlPairRow[] }> => {
    const fd = new FormData();
    fd.append('csv', csvFile);
    if (name) fd.append('name', name);
    return request('/api/sessions', { method: 'POST', body: fd });
  },

  patchSession: (id: string, patch: { name?: string; archived?: boolean }) =>
    request<{ session: SessionRow; config: SessionConfig }>(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  getSessionConfig: (id: string) =>
    request<{ config: SessionConfig }>(`/api/sessions/${id}/config`),
  putSessionConfig: (id: string, config: Partial<SessionConfig>) =>
    request<{ config: SessionConfig }>(`/api/sessions/${id}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }),

  getResults: (
    id: string,
    configOverride?: Partial<SessionConfig> & { invoke_lm?: boolean },
    /**
     * Optional delta-poll / selective fetch parameters. `since` returns a
     * tiny payload (no rows, just plan/summary/latest_evaluation +
     * `changed_pair_keys` + `cursor`); `keys` returns rows for those
     * compound `<url_pair_id>::<viewport_name>` keys only. Both omitted
     * means full row dump (initial load semantics).
     */
    opts?: { since?: string; keys?: string[] },
  ) => {
    const params = new URLSearchParams();
    if (configOverride && Object.keys(configOverride).length > 0) {
      params.set('config', JSON.stringify(configOverride));
    }
    if (opts?.since) params.set('since', opts.since);
    if (opts?.keys && opts.keys.length > 0) params.set('keys', opts.keys.join(','));
    const qs = params.toString();
    return request<SessionResultsDto>(
      `/api/sessions/${id}/results${qs ? `?${qs}` : ''}`,
    );
  },

  evaluate: (
    id: string,
    configInput?: Partial<SessionConfig> & { invoke_lm?: boolean; url_pair_ids?: string[] },
  ) =>
    request<{ evaluation_id: string; coalesced: boolean }>(
      `/api/sessions/${id}/evaluate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: configInput ?? {} }),
      },
    ),

  /**
   * Drop the cached captures for this pair (both A and B), then trigger an
   * evaluation scoped to it. The new captures get fresh shas so the pixel
   * and LM caches miss naturally and the full pipeline re-runs end-to-end.
   * `invoke_lm: true` so the LM second-pass actually runs when the LM
   * cache misses — Recapture is the gesture you reach for when a verdict
   * (often an LM one) needs to be re-derived.
   */
  recapturePair: async (sessionId: string, pairId: string) => {
    await api.invalidateCaptures(sessionId, { pair_ids: [pairId] });
    return api.evaluate(sessionId, { url_pair_ids: [pairId], invoke_lm: true });
  },

  /**
   * Recapture every distinct pair that contributes to this cluster. Uses
   * the same chain as recapturePair, fanned out over the cluster's member
   * pair ids. Throws if the cluster has no resolvable members.
   */
  recaptureCluster: async (sessionId: string, clusterId: string) => {
    const dto = await api.getCluster(sessionId, clusterId, { limit: 10000 });
    const pairIds = [...new Set(dto.members.map((m) => m.url_pair_id))];
    if (pairIds.length === 0) {
      throw new Error('Cluster has no member pairs to recapture');
    }
    await api.invalidateCaptures(sessionId, { pair_ids: pairIds });
    return api.evaluate(sessionId, { url_pair_ids: pairIds, invoke_lm: true });
  },

  listEvaluations: (id: string) =>
    request<{ evaluations: EvaluationStatusDto[] }>(`/api/sessions/${id}/evaluations`),
  getEvaluation: (id: string) =>
    request<{ evaluation: EvaluationStatusDto }>(`/api/evaluations/${id}`),

  /**
   * Poll an evaluation until it reaches a terminal state and return the
   * final row. Caps at `timeoutMs` (default 5 min) so callers never hang
   * forever; on timeout the most recent poll result is returned. Used by
   * post-Recapture flows that want to do follow-up work (locate the new
   * comparison id, recompute clusters) once the eval is actually done.
   */
  waitForEvaluation: async (
    id: string,
    opts: { intervalMs?: number; timeoutMs?: number } = {},
  ) => {
    const intervalMs = opts.intervalMs ?? 1500;
    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    const startedAt = Date.now();
    let evaluation: EvaluationStatusDto | null = null;
    while (Date.now() - startedAt < timeoutMs) {
      const { evaluation: ev } = await api.getEvaluation(id);
      evaluation = ev;
      if (ev.status === 'complete' || ev.status === 'error' || ev.status === 'cancelled') {
        return ev;
      }
      await new Promise<void>((r) => setTimeout(r, intervalMs));
    }
    return evaluation;
  },
  cancelEvaluation: (id: string) =>
    request<{ evaluation: EvaluationStatusDto }>(`/api/evaluations/${id}/cancel`, {
      method: 'POST',
    }),

  invalidateCaptures: (id: string, body: { pair_ids?: string[]; side?: 'a' | 'b' }) =>
    request<{ deleted_count: number; invalidated_urls: string[]; unknown_pair_ids: string[] }>(
      `/api/sessions/${id}/invalidate-captures`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),

  addUrlPairs: (
    id: string,
    pairs: Array<{
      url_a: string;
      url_b: string;
      label?: string | null;
      language?: string | null;
      category?: string | null;
      subcategory?: string | null;
      path?: string | null;
    }>,
  ) =>
    request<{ url_pairs: UrlPairRow[] }>(`/api/sessions/${id}/url-pairs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairs }),
    }),
  patchUrlPair: (
    id: string,
    pairId: string,
    patch: {
      url_a?: string;
      url_b?: string;
      label?: string | null;
      language?: string | null;
      category?: string | null;
      subcategory?: string | null;
      path?: string | null;
      disabled?: boolean;
    },
  ) =>
    request<{ pair: UrlPairRow; replaced_id: string | null }>(
      `/api/sessions/${id}/url-pairs/${pairId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    ),

  startCaptureRun: (sessionId: string, options?: { viewports?: ViewportDef[]; concurrency?: number }) =>
    request<JobAcceptedResponse>('/api/capture-runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, options: options ?? {} }),
    }),
  getCaptureRun: (id: string) =>
    request<{ capture_run: { id: string; session_id: string; job_id: string; options_json: string }; captures: CaptureDto[] }>(
      `/api/capture-runs/${id}`,
    ),

  startComparisonRun: (
    sessionId: string,
    captureRunId: string,
    targetLevel: EquivalenceLevelId,
    invokeLm = false,
  ) =>
    request<JobAcceptedResponse>('/api/comparison-runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        capture_run_id: captureRunId,
        options: { targetLevel, invokeLm },
      }),
    }),
  getComparisonRun: (id: string) =>
    request<{ comparison_run: { id: string; session_id: string; capture_run_id: string; job_id: string }; comparisons: ComparisonDto[] }>(
      `/api/comparison-runs/${id}`,
    ),
  getComparisonDetail: (id: string) =>
    request<ComparisonDetailDto>(`/api/comparisons/${id}`),
  listComparisons: (opts: { comparison_run_id?: string; session_id?: string; status?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.comparison_run_id) params.set('comparison_run_id', opts.comparison_run_id);
    if (opts.session_id) params.set('session_id', opts.session_id);
    if (opts.status) params.set('status', opts.status);
    const qs = params.toString();
    return request<{ comparisons: ComparisonDto[] }>(
      `/api/comparisons${qs ? `?${qs}` : ''}`,
    );
  },

  listCaptureRuns: (sessionId: string) =>
    request<{ capture_runs: CaptureRunRow[] }>(`/api/capture-runs?session_id=${encodeURIComponent(sessionId)}`),
  listComparisonRuns: (sessionId: string) =>
    request<{ comparison_runs: ComparisonRunRow[] }>(`/api/comparison-runs?session_id=${encodeURIComponent(sessionId)}`),

  getJob: (id: string) => request<{ job: JobRow }>(`/api/jobs/${id}`),

  getViewports: () => request<{ viewports: ViewportDef[]; default: string }>(`/api/meta/viewports`),
  getLevels: () =>
    request<{ levels: EquivalenceLevelDef[]; default: EquivalenceLevelId }>(
      '/api/meta/equivalence-levels',
    ),
  getSystemInfo: () =>
    request<{ max_capture_concurrency: number; cpu_count: number }>(
      '/api/meta/system-info',
    ),

  getLmStatus: (force = false) =>
    request<LmStatusDto>(`/api/meta/lm-status${force ? '?force=1' : ''}`),

  getLmActivity: () =>
    request<LmActivityDto>('/api/meta/lm-activity'),

  getWorkerActivity: () =>
    request<WorkerActivityDto>('/api/meta/worker-activity'),

  getSessionErrors: (sessionId: string) =>
    request<{ errors: SessionErrorEntry[] }>(`/api/sessions/${sessionId}/errors`),

  splitCluster: (
    sessionId: string,
    clusterId: string,
    body: { member_difference_ids: string[] },
  ) =>
    request<{
      source_cluster: import('@visual-compare/api/types').DifferenceClusterRow;
      new_cluster: import('@visual-compare/api/types').DifferenceClusterRow;
      recompute: { clusters_upserted: number; clusters_removed: number; members_indexed: number };
    }>(`/api/sessions/${sessionId}/clusters/${clusterId}/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  listAcceptances: (sessionId: string) =>
    request<{ acceptances: AcceptanceRow[] }>(`/api/sessions/${sessionId}/acceptances`),
  createAcceptance: (
    sessionId: string,
    body: {
      url_pair_id: string;
      viewport_name: string;
      accepted_level: MatchedAtLevel;
      accepted_pixel_pct?: number | null;
      accepted_ssim?: number | null;
      accepted_diff_regions: BoundingBoxPercent[];
      accepted_capture_a_sha: string;
      accepted_capture_b_sha: string;
      accept_any?: boolean;
      label?: string | null;
      notes?: string | null;
    },
  ) =>
    request<{ acceptance: AcceptanceRow }>(`/api/sessions/${sessionId}/acceptances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteAcceptance: (sessionId: string, acceptanceId: string) =>
    request<unknown>(
      `/api/sessions/${sessionId}/acceptances/${acceptanceId}`,
      { method: 'DELETE' },
    ),

  listSessionPrompts: (sessionId: string) =>
    request<{ prompts: LmPromptDto[] }>(`/api/sessions/${sessionId}/lm-prompts`),
  putSessionPrompt: (
    sessionId: string,
    reason: LmPromptInvocationReasonDto,
    body: LmPromptUpdateBodyDto,
  ) =>
    request<{ prompt: LmPromptDto }>(
      `/api/sessions/${sessionId}/lm-prompts/${reason}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  resetSessionPrompt: (sessionId: string, reason: LmPromptInvocationReasonDto) =>
    request<{ prompt: LmPromptDto }>(
      `/api/sessions/${sessionId}/lm-prompts/${reason}/reset`,
      { method: 'POST' },
    ),

  listClusters: (sessionId: string, opts: { reviewState?: ClusterReviewState; recompute?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (opts.reviewState) params.set('review_state', opts.reviewState);
    if (opts.recompute) params.set('recompute', '1');
    const qs = params.toString();
    return request<ClusterListDto>(
      `/api/sessions/${sessionId}/clusters${qs ? `?${qs}` : ''}`,
    );
  },
  getCluster: (sessionId: string, clusterId: string, opts: { limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return request<ClusterDetailDto>(
      `/api/sessions/${sessionId}/clusters/${clusterId}${qs ? `?${qs}` : ''}`,
    );
  },
  acceptCluster: (
    sessionId: string,
    clusterId: string,
    body: { label?: string; notes?: string; created_by?: string } = {},
  ) =>
    request<{
      cluster: import('@visual-compare/api/types').DifferenceClusterRow;
      rule: import('@visual-compare/api/types').AcceptanceRuleRow;
      acceptances_created: number;
      acceptances_preserved: number;
    }>(`/api/sessions/${sessionId}/clusters/${clusterId}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  rejectCluster: (sessionId: string, clusterId: string, body: { notes?: string } = {}) =>
    request<{
      cluster: import('@visual-compare/api/types').DifferenceClusterRow;
      acceptances_revoked: number;
      rules_deleted: number;
    }>(`/api/sessions/${sessionId}/clusters/${clusterId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  acceptCategory: (
    sessionId: string,
    body: {
      region_role: string;
      change_type: string;
      signature_version?: string;
      label?: string;
      notes?: string;
      created_by?: string;
    },
  ) =>
    request<{
      rule: import('@visual-compare/api/types').AcceptanceRuleRow;
      clusters_accepted: number;
      clusters_skipped_already_accepted: number;
      acceptances_created: number;
      acceptances_preserved: number;
    }>(`/api/sessions/${sessionId}/clusters/category-accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  revokeCategoryRule: (sessionId: string, ruleId: string) =>
    request<{
      rule_id: string;
      acceptances_revoked: number;
      clusters_reopened: number;
    }>(`/api/sessions/${sessionId}/clusters/category-accept/${ruleId}`, {
      method: 'DELETE',
    }),
};

export interface LmStatusDto {
  ok: boolean;
  configured: boolean;
  server_reachable?: boolean;
  model_loaded?: boolean;
  configured_model?: string;
  loaded_models?: string[];
  started_server?: boolean;
  loaded_model?: boolean;
  reason?: string;
  message?: string;
  duration_ms?: number;
}

export interface LmActivityDto {
  /** Oldest-first ring of in-flight `analyze` counts at sample time. */
  samples: number[];
  /** LM Studio's `--parallel` cap — denominator for sample normalization. */
  parallel: number;
  /** Sample cadence in ms. */
  interval_ms: number;
}

export interface WorkerActivityDto {
  /** Oldest-first ring of in-flight capture+comparison counts at sample time. */
  samples: number[];
  /** Observed concurrency ceiling — denominator for sample normalization. */
  capacity: number;
  /** Sample cadence in ms. */
  interval_ms: number;
}

export interface SessionErrorEntry {
  kind: 'capture' | 'comparison';
  id: string;
  url_pair_id: string;
  url_pair_label: string | null;
  url_a: string;
  url_b: string;
  /** Null for comparison errors (no per-side concept). */
  side: 'a' | 'b' | null;
  /** Null for comparison errors (the comparison row doesn't store a specific url). */
  url: string | null;
  viewport_name: string;
  error_message: string;
  /** ISO timestamp. */
  timestamp: string;
}
