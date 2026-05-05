import type {
  CaptureDto,
  ComparisonDetailDto,
  ComparisonDto,
  EquivalenceLevelId,
  JobAcceptedResponse,
  JobRow,
  SessionDto,
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
  listSessions: () => request<{ sessions: SessionDto[] }>('/api/sessions'),
  getSession: (id: string) =>
    request<{ session: SessionRow; url_pairs: UrlPairRow[] }>(`/api/sessions/${id}`),
  uploadCsv: async (csvFile: File, name?: string): Promise<{ session: SessionRow; url_pairs: UrlPairRow[] }> => {
    const fd = new FormData();
    fd.append('csv', csvFile);
    if (name) fd.append('name', name);
    return request('/api/sessions', { method: 'POST', body: fd });
  },

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
