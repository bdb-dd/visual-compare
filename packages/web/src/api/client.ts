import type {
  CaptureDto,
  CaptureRunRow,
  ComparisonDetailDto,
  ComparisonDto,
  ComparisonRunRow,
  EquivalenceLevelId,
  EvaluationStatusDto,
  JobAcceptedResponse,
  JobRow,
  SessionConfig,
  SessionDto,
  SessionResultsDto,
  SessionRow,
  UrlPairRow,
  ViewportDef,
} from '@visual-compare/api/types';
import type { EquivalenceLevelDef } from '@visual-compare/api/constants/equivalence';

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
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

  getResults: (id: string, configOverride?: Partial<SessionConfig>) => {
    const qs =
      configOverride && Object.keys(configOverride).length > 0
        ? `?config=${encodeURIComponent(JSON.stringify(configOverride))}`
        : '';
    return request<SessionResultsDto>(`/api/sessions/${id}/results${qs}`);
  },

  evaluate: (id: string, configInput?: Partial<SessionConfig>) =>
    request<{ evaluation_id: string; coalesced: boolean }>(
      `/api/sessions/${id}/evaluate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: configInput ?? {} }),
      },
    ),

  listEvaluations: (id: string) =>
    request<{ evaluations: EvaluationStatusDto[] }>(`/api/sessions/${id}/evaluations`),
  getEvaluation: (id: string) =>
    request<{ evaluation: EvaluationStatusDto }>(`/api/evaluations/${id}`),

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

  startComparisonRun: (sessionId: string, captureRunId: string, level: EquivalenceLevelId) =>
    request<JobAcceptedResponse>('/api/comparison-runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        capture_run_id: captureRunId,
        options: { equivalenceLevel: level },
      }),
    }),
  getComparisonRun: (id: string) =>
    request<{ comparison_run: { id: string; session_id: string; capture_run_id: string; equivalence_level: EquivalenceLevelId; job_id: string }; comparisons: ComparisonDto[] }>(
      `/api/comparison-runs/${id}`,
    ),
  getComparisonDetail: (id: string) =>
    request<ComparisonDetailDto>(`/api/comparisons/${id}`),

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

  getLmStatus: (force = false) =>
    request<LmStatusDto>(`/api/meta/lm-status${force ? '?force=1' : ''}`),
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
