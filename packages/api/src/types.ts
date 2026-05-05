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
}

export interface UrlPairRow {
  id: string;
  session_id: string;
  url_a: string;
  url_b: string;
  label: string | null;
  row_index: number;
  raw_row_json: string | null;
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

export interface CsvRowError {
  row_index: number;
  errors: string[];
}

export interface CsvUploadErrorResponse {
  error: 'invalid_csv';
  message: string;
  row_errors?: CsvRowError[];
}
