// Cross-package types. The web package imports these via the
// `@visual-compare/api/*` path alias declared in tsconfig.base.json.
//
// Keep this file dependency-free (no Node-only imports) so the web
// package can pull it in safely.

export type EquivalenceLevelId =
  | 'pixel-perfect'
  | 'strict'
  | 'tolerant'
  | 'loose';

/**
 * The strictest level a comparison passed at, or `none` when no level matched.
 * `none` is sentinel for "different at every threshold"; it's treated as
 * weaker than `loose` for sorting/regression-detection purposes.
 */
export type MatchedAtLevel = EquivalenceLevelId | 'none';

export type MatchedDecidedBy = 'pixel' | 'lm';

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
  | 'ambiguous_pixel_result'
  | 'target_level_failure'
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
  /**
   * Target equivalence level for this run. The pipeline computes
   * `matched_at_level` for every comparison; this value governs which
   * comparisons surface as "needs review" and which trigger LM second-pass.
   */
  targetLevel: EquivalenceLevelId;
  /** When true, run LM second-pass on comparisons that don't match at the target. */
  invokeLm?: boolean;
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
  default_equivalence_level: EquivalenceLevelId;
  region_match_config_json: string;      // JSON: RegionMatchConfig
  filter_query: string;                  // JSON: FilterQuery
  archived_at: string | null;
}

export interface FilterQuery {
  language?: string[];
  category?: string[];
  subcategory?: string[];
  path_prefix?: string;
}

export interface RegionMatchConfig {
  /** How much an accepted region's bbox can grow before counted as expanded (px). */
  growth_margin_px: number;
  /** How far a region can shift and still match an accepted region (px). */
  displacement_tolerance_px: number;
  /** Percentage-point allowance over `accepted_pixel_pct` before flagging. */
  pixel_pct_delta: number;
}

export interface SessionConfig {
  default_viewports: ViewportDef[];
  default_capture_options: Partial<CaptureRunOptions>;
  default_equivalence_level: EquivalenceLevelId;
  region_match_config: RegionMatchConfig;
  filter_query: FilterQuery;
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
  status: RowProcessingStatus;
  changed_pixel_percentage: number | null;
  rmse: number | null;
  ssim: number | null;
  bounding_box_area_percentage: number | null;
  connected_component_count: number | null;
  im_diff_sha256: string | null;
  im_diff_byte_size: number | null;
  im_determined_equivalent: number | null;
  /** Strictest level at which this comparison is equivalent, or 'none'. */
  matched_at_level: MatchedAtLevel | null;
  /** Whether the level assignment was made by pixel metrics or LM tiebreaker. */
  matched_decided_by: MatchedDecidedBy | null;
  lm_invocation_reason: LmInvocationReason | null;
  lm_model: string | null;
  lm_prompt_version: string | null;
  /** LM-generated description of the diff; used for UI and label suggestions. */
  lm_diff_summary: string | null;
  lm_confidence: number | null;
  lm_response_json: string | null;
  lm_determined_equivalent: number | null;
  error_message: string | null;
  duration_ms: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface AcceptanceRow {
  id: string;
  session_id: string;
  url_pair_id: string;
  viewport_name: string;
  accepted_level: MatchedAtLevel;
  accepted_pixel_pct: number | null;
  accepted_ssim: number | null;
  /** JSON-encoded BoundingBoxPercent[] — regions detected at acceptance. */
  accepted_diff_regions_json: string;
  accepted_capture_a_sha: string;
  accepted_capture_b_sha: string;
  /** SQLite stores boolean as 0/1. 1 = ignore regardless of diff growth. */
  accept_any: number;
  label: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface UrlPairConfigOverrideRow {
  url_pair_id: string;
  /** null = inherit session default. */
  equivalence_level: EquivalenceLevelId | null;
  /** null = inherit; otherwise partial RegionMatchConfig JSON merged over session. */
  region_match_config_json: string | null;
  updated_at: string;
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

export type CaptureStatusKind = 'complete' | 'in_progress' | 'error' | 'missing';

export interface CaptureStatusInfo {
  /**
   * - `complete`     – capture succeeded; sha is cached.
   * - `in_progress`  – a capture row exists but hasn't reached `complete`.
   * - `error`        – the most recent capture for this URL+viewport in
   *                    this session is in `error` status.
   * - `missing`      – no capture has been attempted yet.
   */
  status: CaptureStatusKind;
  error_message: string | null;
}

/**
 * Status of a comparison relative to its persisted acceptance, computed at
 * read time. `unaccepted` = no acceptance row exists. `accepted` = current
 * state is within the accepted snapshot. `regressed` = matched_at_level is
 * weaker than accepted_level. `expanded_diff` = level held but pixel pct or
 * regions grew beyond knob tolerances.
 */
export type AcceptanceStatus =
  | 'unaccepted'
  | 'accepted'
  | 'regressed'
  | 'expanded_diff';

export interface SessionResultRow {
  url_pair_id: string;
  url_a: string;
  url_b: string;
  label: string | null;
  viewport_name: string;
  /** Strictest level at which this comparison passed, or 'none'. */
  matched_at_level: MatchedAtLevel | null;
  /** Whether the level assignment was made by pixel or LM tiebreaker. */
  matched_decided_by: MatchedDecidedBy | null;
  capture_a_sha: string | null;
  capture_b_sha: string | null;
  /** Most recent comparison row this verdict came from. Lets the UI deep-link. */
  comparison_id: string | null;
  /** Diagnostic per side, so the UI can show *why* a row is pending. */
  capture_a_status: CaptureStatusInfo;
  capture_b_status: CaptureStatusInfo;
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
    diff_summary: string | null;
    confidence: number | null;
  } | null;
  /** Acceptance state relative to the persisted acceptance, if any. */
  acceptance_status: AcceptanceStatus;
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
  comparison_run_id: string | null;
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
  /** Session-wide target level. Single value, not a list. */
  target_level: EquivalenceLevelId;
  /** Whether the LM second pass runs on comparisons that miss the target. */
  invoke_lm: boolean;
  region_match_config: RegionMatchConfig;
  capture_options: CaptureRunOptions;
  url_pair_ids: string[] | null;
  filter_query: FilterQuery;
  lm_prompt_ids: Partial<Record<'target_level_failure' | 'ambiguous_pixel_result', string>>;
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
