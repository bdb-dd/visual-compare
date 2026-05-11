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

/**
 * Region-matching geometry knobs. All values are *percent of image dimension*
 * since regions (BoundingBoxPercent) are stored in percent units.
 */
export interface RegionMatchConfig {
  /** How much an accepted region's bbox can grow (in percentage points of image dim) before counted as expanded. */
  growth_margin_pct: number;
  /** How far a region can shift (in percentage points of image dim) and still match an accepted region. */
  displacement_tolerance_pct: number;
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
  /** HTTP response status from page.goto(); null when unavailable. */
  http_status: number | null;
  /** SQLite 0/1: 1 when the rendered page is treated as a "missing page". */
  is_missing: number;
}

export type PairOutcome =
  | 'both_present'
  | 'a_missing'
  | 'b_missing'
  | 'both_missing';

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
  /**
   * Coarse classification of the pair's availability. `both_present` means
   * the visual diff fields above are populated normally; the other values
   * indicate one or both sides rendered as a missing page and the diff was
   * skipped.
   */
  pair_outcome: PairOutcome;
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
  /**
   * `both_present` when a real visual diff was performed; the other values
   * indicate one or both sides rendered as a missing page (HTTP 4xx/5xx or
   * soft-404 title match) and the diff was skipped. Defaults to
   * `both_present` for legacy rows captured before this field existed.
   */
  pair_outcome: PairOutcome;
}

export interface EvaluationCacheHits {
  captures: number;
  pixel: number;
  lm: number;
}

/**
 * Progress for the in-flight phase of a running evaluation. `phase` reflects
 * which underlying job is currently running (capture happens before
 * comparison). Null when the evaluation isn't running, or when neither
 * underlying job is in flight.
 */
export interface EvaluationProgress {
  phase: 'capture' | 'comparison';
  current: number;
  total: number;
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
  progress: EvaluationProgress | null;
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

/**
 * Aggregated counts derived from `SessionResultRow[]`. The Review UI's
 * histogram strip and filter chips read directly from these numbers — every
 * `count` field is a non-negative integer summing to `total`.
 */
export interface SessionResultsSummary {
  total: number;
  /**
   * One bucket per matched_at_level, plus `pending` for rows still awaiting
   * a visual-diff verdict, plus `missing` for rows whose pair_outcome
   * indicates one or both sides rendered as a missing page (no visual diff
   * was attempted; tracking these as `pending` would falsely imply work
   * still to do).
   */
  by_level: Record<MatchedAtLevel | 'pending' | 'missing', number>;
  by_acceptance_status: Record<AcceptanceStatus, number>;
  /**
   * `pixel` / `lm` / `none` (none = no verdict yet). Useful for the UI to
   * show how many comparisons relied on the LM second pass.
   */
  by_decided_by: Record<MatchedDecidedBy | 'none', number>;
  /**
   * Coarser bucket for the "needs review" filter: did the comparison reach
   * the session target, miss it, or is it still pending?
   */
  by_target_status: Record<'reached_target' | 'weaker_than_target' | 'pending', number>;
  /**
   * Counts per pair_outcome bucket. Drives the missing-page filter chips on
   * the results page; reviewers can sweep "Missing on B" independently of
   * the visual-diff stream.
   */
  by_pair_outcome: Record<PairOutcome, number>;
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
  /**
   * Result rows. Empty array when the request used `?since=...` (delta poll
   * mode) — callers in that mode read `changed_pair_keys` instead and follow
   * up with `?keys=...` for the actual row payloads.
   */
  results: SessionResultRow[];
  summary: SessionResultsSummary;
  /**
   * Compound `<url_pair_id>::<viewport_name>` keys for rows whose verdict
   * changed since the `since` cursor passed in the request. Present iff the
   * client passed `?since=<iso>`. Empty array when nothing changed.
   */
  changed_pair_keys?: string[];
  /**
   * Server-computed timestamp marking when this response was assembled. The
   * client should pass this back as the next `?since=` so subsequent polls
   * see strictly-newer changes. Present iff the client passed `?since=<iso>`.
   */
  cursor?: string;
  /**
   * Convenience: the most recent evaluation for this session (running or
   * complete). Present iff the client passed `?since=<iso>`. Lets the
   * polling client refresh the running-eval indicator without a second
   * round-trip to /evaluations.
   */
  latest_evaluation?: EvaluationStatusDto | null;
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

/**
 * DTOs for the LM prompt editor. The shape mirrors the service-layer
 * `LmPromptView` so the UI can edit, save, and reset session prompts.
 * `mode === 'structured'` ⇔ `guidance !== null`; the editor uses one or the
 * other depending on which affordance the user chose. `base_prompt_text`
 * is the resolved default text used as the assembly base in structured
 * mode — included so the UI can show "what the default looks like" without
 * a second round-trip.
 */
export type LmPromptInvocationReasonDto = 'target_level_failure' | 'ambiguous_pixel_result';
export type LmPromptModeDto = 'structured' | 'advanced';

export interface PromptGuidanceTogglesDto {
  language_must_match?: boolean;
  ignore_chrome_only_diffs?: boolean;
  flag_added_removed_content?: boolean;
}

export interface PromptGuidanceDto {
  toggles: PromptGuidanceTogglesDto;
  /** Two-stage rule layout: scope filters regions, trigger flips equivalence. */
  house_rules: { scope: string[]; trigger: string[] };
}

export interface LmPromptDto {
  invocation_reason: LmPromptInvocationReasonDto;
  prompt_text: string;
  prompt_id: string;
  guidance: PromptGuidanceDto | null;
  mode: LmPromptModeDto;
  base_prompt_text: string;
  updated_at: string;
}

export type LmPromptUpdateBodyDto =
  | { mode: 'structured'; guidance: PromptGuidanceDto }
  | { mode: 'advanced'; prompt_text: string };
