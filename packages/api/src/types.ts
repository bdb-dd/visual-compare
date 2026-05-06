// Cross-package types. The web package imports these via the
// `@visual-compare/api/*` path alias declared in tsconfig.base.json.
//
// Keep this file dependency-free (no Node-only imports) so the web
// package can pull it in safely.

export type EquivalenceLevelId =
  | 'pixel-perfect'
  | 'strict'
  | 'tolerant'
  | 'loose'
  | 'semantic';

export type CaptureSide = 'a' | 'b';

export type JobType = 'capture' | 'comparison';

export type JobStatus = 'pending' | 'running' | 'complete' | 'error';

export type RowProcessingStatus =
  | 'pending'
  | 'processing'
  | 'complete'
  | 'error';

export type DifferenceSource = 'imagick' | 'lm';

export type DifferenceSeverity = 'low' | 'medium' | 'high';

export type LmInvocationReason =
  | 'semantic_mode'
  | 'ambiguous_pixel_result'
  | 'manual_retry';

export type ScreenOrientation = 'portrait' | 'landscape';

export interface ViewportDef {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  orientation: ScreenOrientation;
}

export interface CaptureRunOptions {
  viewports: ViewportDef[];
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  reducedMotion?: 'reduce' | 'no-preference';
  waitForSelector?: string;
  hideSelectors?: string[];
  settleDelayMs?: number;
  useNetworkIdle?: boolean;
  concurrency?: number;
  urlPairIds?: string[]; // optional explicit subset; null/undefined = all in session
}

export interface ComparisonRunOptions {
  equivalenceLevel: EquivalenceLevelId;
  urlPairIds?: string[];
  viewports?: string[]; // viewport names; undefined = all viewports captured in the run
}

export interface BoundingBoxPercent {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SessionRow {
  id: string;
  name: string;
  csv_filename: string;
  created_at: string;
  default_viewports: string;             // JSON: ViewportDef[]
  default_capture_options: string;       // JSON: Partial<CaptureRunOptions>
  default_equivalence_levels: string;    // JSON: EquivalenceLevelId[]
  filter_query: string;                  // JSON: FilterQuery
  allow_list: string;                    // JSON: AllowListEntry[]
  archived_at: string | null;
}

export interface FilterQuery {
  language?: string[];
  category?: string[];
  subcategory?: string[];
  path_prefix?: string;
}

export interface AllowListEntry {
  url_pair_id: string;
  level: EquivalenceLevelId;
  viewport_name: string;
}

export interface SessionConfig {
  default_viewports: ViewportDef[];
  default_capture_options: Partial<CaptureRunOptions>;
  default_equivalence_levels: EquivalenceLevelId[];
  filter_query: FilterQuery;
  allow_list: AllowListEntry[];
}

export interface UrlPairRow {
  id: string;
  session_id: string;
  url_a: string;
  url_b: string;
  label: string | null;
  row_index: number;
  raw_row_json: string | null;
  language: string | null;
  category: string | null;
  subcategory: string | null;
  path: string | null;
  /** SQLite stores the boolean as 0/1. */
  disabled: number;
  created_at: string;
}

export interface JobRow {
  id: string;
  type: JobType;
  status: JobStatus;
  progress_current: number;
  progress_total: number;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface CaptureRunRow {
  id: string;
  session_id: string;
  job_id: string;
  options_json: string;
  created_at: string;
}

export interface CaptureRow {
  id: string;
  capture_run_id: string;
  url_pair_id: string;
  side: CaptureSide;
  url: string;
  status: RowProcessingStatus;
  screenshot_sha256: string | null;
  screenshot_byte_size: number | null;
  viewport_name: string;
  metadata_json: string | null;
  error_message: string | null;
  duration_ms: number | null;
  captured_at: string | null;
  created_at: string;
}

export interface ComparisonRunRow {
  id: string;
  session_id: string;
  capture_run_id: string;
  job_id: string;
  equivalence_level: EquivalenceLevelId;
  options_json: string;
  created_at: string;
}

export interface ComparisonRow {
  id: string;
  comparison_run_id: string;
  url_pair_id: string;
  capture_a_id: string;
  capture_b_id: string;
  viewport_name: string;
  equivalence_level: EquivalenceLevelId;
  status: RowProcessingStatus;
  changed_pixel_percentage: number | null;
  rmse: number | null;
  ssim: number | null;
  bounding_box_area_percentage: number | null;
  connected_component_count: number | null;
  im_diff_sha256: string | null;
  im_diff_byte_size: number | null;
  im_determined_equivalent: number | null;
  lm_invocation_reason: LmInvocationReason | null;
  lm_model: string | null;
  lm_prompt_version: string | null;
  lm_summary: string | null;
  lm_confidence: number | null;
  lm_response_json: string | null;
  lm_determined_equivalent: number | null;
  is_equivalent: number | null;
  error_message: string | null;
  duration_ms: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface DifferenceRow {
  id: string;
  comparison_id: string;
  source: DifferenceSource;
  description: string;
  severity: DifferenceSeverity | null;
  bounding_box_json: string | null; // JSON-encoded BoundingBoxPercent
  created_at: string;
}

// API response shapes (what web sees)

export interface SessionDto extends SessionRow {
  url_pair_count: number;
}

export interface CaptureDto extends Omit<CaptureRow, 'screenshot_sha256'> {
  screenshot_sha256: string | null;
  screenshot_url: string | null;
}

export interface ComparisonDto
  extends Omit<ComparisonRow, 'im_diff_sha256'> {
  im_diff_sha256: string | null;
  im_diff_url: string | null;
}

export interface DifferenceDto extends Omit<DifferenceRow, 'bounding_box_json'> {
  bounding_box: BoundingBoxPercent | null;
}

export interface ComparisonDetailDto {
  comparison: ComparisonDto;
  capture_a: CaptureDto;
  capture_b: CaptureDto;
  differences: DifferenceDto[];
  url_pair: UrlPairRow;
}

export interface JobAcceptedResponse {
  job_id: string;
  capture_run_id?: string;
  comparison_run_id?: string;
}

export interface SessionResultRow {
  url_pair_id: string;
  url_a: string;
  url_b: string;
  label: string | null;
  viewport_name: string;
  level: EquivalenceLevelId;
  capture_a_sha: string | null;
  capture_b_sha: string | null;
  /** Most recent comparison row this verdict came from. Lets the UI deep-link. */
  comparison_id: string | null;
  pixel: {
    changed_pct: number | null;
    ssim: number | null;
    bbox_area_pct: number | null;
    component_count: number | null;
    im_diff_sha256: string | null;
  } | null;
  lm: {
    invocation_reason: LmInvocationReason;
    verdict: number | null;
    summary: string | null;
    confidence: number | null;
  } | null;
  is_equivalent: number | null;
  is_allowed: boolean;
  status: 'pending' | 'cached';
}

export interface EvaluationCacheHits {
  captures: number;
  pixel: number;
  lm: number;
}

export interface EvaluationStatusDto {
  id: string;
  session_id: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  capture_run_id: string | null;
  comparison_run_ids: string[];
  cache_hits: EvaluationCacheHits;
  config: unknown;
  enabled_pair_count: number;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

/**
 * Resolved config the evaluator/results endpoints echo back. It's the
 * fully-defaulted version of `SessionConfig`'s editable fields plus the
 * scalar planning inputs (`url_pair_ids`, `lm_*`) — everything the
 * planner needs to make a deterministic plan.
 */
export interface ResolvedEvaluationConfig {
  viewports: ViewportDef[];
  equivalence_levels: EquivalenceLevelId[];
  capture_options: CaptureRunOptions;
  url_pair_ids: string[] | null;
  filter_query: FilterQuery;
  allow_list: AllowListEntry[];
  lm_prompt_ids: Partial<Record<'semantic_mode' | 'ambiguous_pixel_result', string>>;
  lm_model_id: string;
}

export interface SessionResultsDto {
  session_id: string;
  config: ResolvedEvaluationConfig;
  plan: {
    enabled_pair_count: number;
    capture_misses: number;
    comparison_misses: number;
    cache_hits: EvaluationCacheHits;
  };
  results: SessionResultRow[];
}

export interface CsvRowError {
  row_index: number;
  errors: string[];
}

export interface CsvUploadErrorResponse {
  error: 'invalid_csv';
  message: string;
  row_errors?: CsvRowError[];
}
