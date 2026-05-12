-- Canonical database schema for visual-compare.
--
-- This file is the single source of truth for the schema. There is no
-- migration history: when the schema changes, edit this file and wipe the
-- dev DB. If/when this tool gets shipped somewhere with persistent data
-- worth preserving, snapshot this file as the first migration and start
-- versioning from there.
--
-- Schema is loaded by `applySchema()` (db/schema.ts) on a fresh database.

-- ---------------------------------------------------------------------------
-- Sessions and URL pairs
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  csv_filename TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Persistent project config. Empty JSON defaults mean "no override" and
  -- the evaluator falls back to system defaults.
  default_viewports TEXT NOT NULL DEFAULT '[]',
  default_capture_options TEXT NOT NULL DEFAULT '{}',
  -- Session-wide target level — the level the user has decided is "good
  -- enough" for this session. The single-pass pipeline computes
  -- `matched_at_level` per comparison; the target governs which results
  -- surface as "needs review" and which level the LM second pass tries to
  -- confirm.
  default_equivalence_level TEXT NOT NULL DEFAULT 'tolerant',
  -- Geometry knobs for the acceptance regression check (RegionMatchConfig).
  -- Per-pair overrides live in url_pair_config_overrides.
  region_match_config_json TEXT NOT NULL DEFAULT '{"growth_margin_pct":0.5,"displacement_tolerance_pct":1,"pixel_pct_delta":0.5}',
  filter_query TEXT NOT NULL DEFAULT '{}',
  archived_at TEXT
);

CREATE TABLE url_pairs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  url_a TEXT NOT NULL,
  url_b TEXT NOT NULL,
  label TEXT,
  row_index INTEGER NOT NULL,
  raw_row_json TEXT,
  -- Promoted metadata so the filter DSL can query with indexes.
  language TEXT,
  category TEXT,
  subcategory TEXT,
  path TEXT,
  -- Soft-remove gesture (1 = pair disabled).
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, row_index)
);

CREATE INDEX idx_url_pairs_session ON url_pairs(session_id);
CREATE INDEX idx_url_pairs_language ON url_pairs(language);
CREATE INDEX idx_url_pairs_category ON url_pairs(category);
CREATE INDEX idx_url_pairs_subcategory ON url_pairs(subcategory);
CREATE INDEX idx_url_pairs_path ON url_pairs(path);
CREATE INDEX idx_url_pairs_disabled ON url_pairs(disabled);

-- Per-pair config overrides. Null columns mean "inherit from session".
-- region_match_config_json is a *partial* override merged over the session's
-- region_match_config_json at read time.
CREATE TABLE url_pair_config_overrides (
  url_pair_id              TEXT PRIMARY KEY REFERENCES url_pairs(id) ON DELETE CASCADE,
  equivalence_level        TEXT,
  region_match_config_json TEXT,
  updated_at               TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Jobs and runs
-- ---------------------------------------------------------------------------

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('capture', 'comparison')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'complete', 'error')),
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX idx_jobs_status ON jobs(status);

CREATE TABLE capture_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  options_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_capture_runs_session ON capture_runs(session_id);

CREATE TABLE captures (
  id TEXT PRIMARY KEY,
  capture_run_id TEXT NOT NULL REFERENCES capture_runs(id) ON DELETE CASCADE,
  url_pair_id TEXT NOT NULL REFERENCES url_pairs(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK(side IN ('a', 'b')),
  url TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'complete', 'error')),
  screenshot_sha256 TEXT,
  screenshot_byte_size INTEGER,
  viewport_name TEXT NOT NULL,
  metadata_json TEXT,
  error_message TEXT,
  duration_ms INTEGER,
  captured_at TEXT,
  created_at TEXT NOT NULL,
  -- HTTP response status from page.goto(). Null for legacy rows or when the
  -- response wasn't surfaced (e.g. about:blank, data:, navigation aborted).
  http_status INTEGER,
  -- 1 when this capture is treated as a "missing page": http_status >= 400
  -- OR the rendered title matches the hardcoded soft-404 regex. Used to
  -- short-circuit visual comparison for pairs where one side doesn't exist.
  is_missing INTEGER NOT NULL DEFAULT 0 CHECK(is_missing IN (0, 1)),
  UNIQUE(capture_run_id, url_pair_id, side, viewport_name)
);

CREATE INDEX idx_captures_run ON captures(capture_run_id);
CREATE INDEX idx_captures_pair ON captures(url_pair_id);
CREATE INDEX idx_captures_status ON captures(status);
-- Supports the diagnostic lookup in readSessionResults that finds the most
-- recent capture for a (session, url, viewport_name) when the capture_cache
-- entry is missing. Without it, the joined query plan scans every capture in
-- the session under idx_captures_run, which becomes O(captures × pairs) right
-- after a "Recapture all" flushes the whole capture_cache.
CREATE INDEX idx_captures_url_vp ON captures(url, viewport_name);

CREATE TABLE comparison_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  capture_run_id TEXT NOT NULL REFERENCES capture_runs(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  options_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_comparison_runs_session ON comparison_runs(session_id);
CREATE INDEX idx_comparison_runs_capture_run ON comparison_runs(capture_run_id);

-- One row per (comparison_run, url_pair, viewport). `matched_at_level`
-- records the strictest equivalence level at which the comparison passes —
-- pixel-perfect through loose, or `none` when no level matches.
-- `matched_decided_by` records whether that verdict came from pixel metrics
-- or an LM tiebreaker.
CREATE TABLE comparisons (
  id TEXT PRIMARY KEY,
  comparison_run_id TEXT NOT NULL REFERENCES comparison_runs(id) ON DELETE CASCADE,
  url_pair_id TEXT NOT NULL REFERENCES url_pairs(id) ON DELETE CASCADE,
  capture_a_id TEXT NOT NULL REFERENCES captures(id),
  capture_b_id TEXT NOT NULL REFERENCES captures(id),
  viewport_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'complete', 'error')),
  changed_pixel_percentage REAL,
  rmse REAL,
  ssim REAL,
  bounding_box_area_percentage REAL,
  connected_component_count INTEGER,
  im_diff_sha256 TEXT,
  im_diff_byte_size INTEGER,
  im_determined_equivalent INTEGER,
  matched_at_level TEXT CHECK(matched_at_level IN ('pixel-perfect', 'strict', 'tolerant', 'loose', 'none')),
  matched_decided_by TEXT CHECK(matched_decided_by IN ('pixel', 'lm')),
  -- Coarse classification surfacing whether one side is a missing page.
  -- 'both_present' rows run the full visual diff; the others short-circuit
  -- and leave changed_pct/ssim/etc. null. Defaults to 'both_present' so
  -- legacy rows behave as before.
  pair_outcome TEXT NOT NULL DEFAULT 'both_present'
    CHECK(pair_outcome IN ('both_present', 'a_missing', 'b_missing', 'both_missing')),
  lm_invocation_reason TEXT CHECK(lm_invocation_reason IN ('ambiguous_pixel_result', 'target_level_failure', 'manual_retry')),
  lm_model TEXT,
  lm_prompt_version TEXT,
  lm_diff_summary TEXT,
  lm_confidence REAL,
  lm_response_json TEXT,
  lm_determined_equivalent INTEGER,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(comparison_run_id, url_pair_id, viewport_name)
);

CREATE INDEX idx_comparisons_run ON comparisons(comparison_run_id);
CREATE INDEX idx_comparisons_pair ON comparisons(url_pair_id);
CREATE INDEX idx_comparisons_status ON comparisons(status);
CREATE INDEX idx_comparisons_matched_at_level ON comparisons(matched_at_level);

-- Per-difference rows produced by either the imagick (pixel) or the LM
-- (semantic) pass. Cluster-related columns (signature, signature_version,
-- change_type, region_role, element_label) populate the v1 cluster review
-- substrate. NULL on legacy rows; backfilled by scripts/backfill-cluster-
-- signatures.ts. Imagick rows always get a v0 signature; LM rows under the
-- v3 prompt get a v1 signature derived from the three tag fields.
CREATE TABLE differences (
  id TEXT PRIMARY KEY,
  comparison_id TEXT NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('imagick', 'lm')),
  description TEXT NOT NULL,
  severity TEXT CHECK(severity IN ('low', 'medium', 'high')),
  bounding_box_json TEXT,
  -- v3-prompt taxonomy fields (LM-sourced rows only).
  change_type   TEXT,
  region_role   TEXT,
  element_label TEXT,
  -- Cluster-signature index. signature_version is the scheme ('v0' geometric,
  -- 'v1' structured-LM) under which `signature` was computed. Decoupled from
  -- the v3 prompt label so the same DB can carry both v0 fallback and v1
  -- primary signatures during the cutover.
  signature         TEXT,
  signature_version TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_differences_comparison ON differences(comparison_id);
CREATE INDEX idx_differences_signature ON differences(signature, signature_version);

-- ---------------------------------------------------------------------------
-- Cache substrate. Runs tables are the ledger; these are denormalized
-- read-side indexes keyed by stable hashes so the cache survives schema/UI
-- changes.
-- ---------------------------------------------------------------------------

CREATE TABLE capture_cache (
  url               TEXT NOT NULL,
  viewport_name     TEXT NOT NULL,
  capture_opts_hash TEXT NOT NULL,
  screenshot_sha256 TEXT NOT NULL,
  capture_id        TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (url, viewport_name, capture_opts_hash)
);

CREATE INDEX idx_capture_cache_capture ON capture_cache(capture_id);

CREATE TABLE pixel_compare_cache (
  capture_a_sha     TEXT NOT NULL,
  capture_b_sha     TEXT NOT NULL,
  pipeline_version  TEXT NOT NULL,
  changed_pct       REAL,
  ssim              REAL,
  bbox_area_pct     REAL,
  component_count   INTEGER,
  im_diff_sha256    TEXT,
  comparison_id     TEXT NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (capture_a_sha, capture_b_sha, pipeline_version)
);

CREATE INDEX idx_pixel_compare_cache_comparison ON pixel_compare_cache(comparison_id);

-- user_instruction_id is sha256 of the per-call user instruction template
-- (with sentinel inputs that strip out per-call values like pixel metrics).
-- It's part of the cache key so that edits to buildPromptUserInstruction
-- auto-invalidate verdicts derived under the old wording — without
-- requiring a PIPELINE_VERSION bump that would also invalidate pixel cache.
CREATE TABLE lm_verdict_cache (
  capture_a_sha       TEXT NOT NULL,
  capture_b_sha       TEXT NOT NULL,
  prompt_id           TEXT NOT NULL,
  user_instruction_id TEXT NOT NULL DEFAULT '',
  model_id            TEXT NOT NULL,
  invocation_reason   TEXT NOT NULL,
  pipeline_version    TEXT NOT NULL,
  verdict             INTEGER,
  summary             TEXT,
  confidence          REAL,
  comparison_id       TEXT NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (capture_a_sha, capture_b_sha, prompt_id, user_instruction_id, model_id, invocation_reason, pipeline_version)
);

CREATE INDEX idx_lm_verdict_cache_comparison ON lm_verdict_cache(comparison_id);

-- ---------------------------------------------------------------------------
-- Evaluations: the act of turning a session's current configuration into
-- verdicts. Mostly bookkeeping for the history panel; only the run id
-- columns and completed_at have load-bearing logic.
-- ---------------------------------------------------------------------------

CREATE TABLE evaluations (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  config_snapshot_json TEXT NOT NULL,
  enabled_pair_count   INTEGER NOT NULL,
  capture_run_id       TEXT REFERENCES capture_runs(id) ON DELETE SET NULL,
  comparison_run_id    TEXT REFERENCES comparison_runs(id) ON DELETE SET NULL,
  cache_hits           TEXT NOT NULL DEFAULT '{}',
  status               TEXT NOT NULL CHECK(status IN ('pending', 'running', 'complete', 'error', 'cancelled')),
  error_message        TEXT,
  started_at           TEXT NOT NULL,
  completed_at         TEXT
);

CREATE INDEX idx_evaluations_session ON evaluations(session_id);
CREATE INDEX idx_evaluations_status ON evaluations(status);

-- Schema version. Bumped when in-place migrations are needed; see schema.ts.
PRAGMA user_version = 1;

-- ---------------------------------------------------------------------------
-- Acceptances: user marks a (session, url_pair, viewport) as "reviewed and
-- OK at this state", with snapshot data so later evaluations can detect
-- regressions. One row per (session, pair, viewport); re-accepting overwrites.
-- ---------------------------------------------------------------------------

CREATE TABLE acceptances (
  id                          TEXT PRIMARY KEY,
  session_id                  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  url_pair_id                 TEXT NOT NULL REFERENCES url_pairs(id) ON DELETE CASCADE,
  viewport_name               TEXT NOT NULL,
  accepted_level              TEXT NOT NULL CHECK(accepted_level IN ('pixel-perfect', 'strict', 'tolerant', 'loose', 'none')),
  accepted_pixel_pct          REAL,
  accepted_ssim               REAL,
  accepted_diff_regions_json  TEXT NOT NULL DEFAULT '[]',
  accepted_capture_a_sha      TEXT NOT NULL,
  accepted_capture_b_sha      TEXT NOT NULL,
  -- 1 = ignore regardless of diff growth (replaces the old allow_list).
  accept_any                  INTEGER NOT NULL DEFAULT 0,
  label                       TEXT,
  notes                       TEXT,
  -- Phase D: when this acceptance was created by a cluster-level rule
  -- fan-out, the originating rule id. NULL for manually-created
  -- acceptances. Cluster revoke deletes only rows it owns (this column
  -- matches the revoking rule); per-row acceptances created by the user
  -- are preserved.
  acceptance_rule_id          TEXT REFERENCES acceptance_rules(id) ON DELETE SET NULL,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  UNIQUE(session_id, url_pair_id, viewport_name)
);

CREATE INDEX idx_acceptances_session ON acceptances(session_id);
CREATE INDEX idx_acceptances_url_pair ON acceptances(url_pair_id);
CREATE INDEX idx_acceptances_label ON acceptances(label);
CREATE INDEX idx_acceptances_rule ON acceptances(acceptance_rule_id);

-- ---------------------------------------------------------------------------
-- Cluster review (Phase A). Materialised aggregates over `differences` rows
-- that share a signature within a session. Rebuilt from scratch by
-- recomputeClusters() in services/clusters.ts; the UNIQUE constraint guards
-- against double-insertion on concurrent rebuilds. Facet columns
-- (viewport_name, region_role, change_type, element_label) are denormalised
-- copies of fields on the representative difference for query convenience.
-- ---------------------------------------------------------------------------

CREATE TABLE difference_clusters (
  id                           TEXT PRIMARY KEY,
  session_id                   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  signature                    TEXT NOT NULL,
  signature_version            TEXT NOT NULL,
  viewport_name                TEXT,
  region_role                  TEXT,
  change_type                  TEXT,
  element_label                TEXT,
  representative_difference_id TEXT REFERENCES differences(id) ON DELETE SET NULL,
  member_count                 INTEGER NOT NULL DEFAULT 0,
  pair_count                   INTEGER NOT NULL DEFAULT 0,
  review_state                 TEXT NOT NULL DEFAULT 'open'
                                CHECK(review_state IN ('open', 'accepted', 'rejected', 'split', 'anomaly')),
  review_notes                 TEXT,
  reviewed_at                  TEXT,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL,
  UNIQUE(session_id, signature, signature_version)
);

CREATE INDEX idx_clusters_session_state ON difference_clusters(session_id, review_state);
CREATE INDEX idx_clusters_session_region ON difference_clusters(session_id, region_role);
CREATE INDEX idx_clusters_pair_count ON difference_clusters(session_id, pair_count DESC);

-- ---------------------------------------------------------------------------
-- Acceptance rules (Phase A: schema only; fan-out wires up in Phase D).
-- A rule is "everything matching this signature is accepted". When created,
-- a service worker fans out into per-row `acceptances` so the existing
-- regression-detection machinery works unchanged. scope='cluster' matches
-- one signature exactly; scope='category' matches any cluster sharing
-- (region_role, change_type) at the same signature_version.
-- ---------------------------------------------------------------------------

CREATE TABLE acceptance_rules (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  signature            TEXT NOT NULL,
  signature_version    TEXT NOT NULL,
  scope                TEXT NOT NULL CHECK(scope IN ('cluster', 'category')),
  category_region_role TEXT,
  category_change_type TEXT,
  label                TEXT,
  notes                TEXT,
  created_by           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX idx_acceptance_rules_session ON acceptance_rules(session_id);
CREATE INDEX idx_acceptance_rules_signature ON acceptance_rules(signature, signature_version);

-- ---------------------------------------------------------------------------
-- LM prompts. The constants file (constants/lm-prompts.ts) is the source of
-- truth for "what does a fresh checkout do?" — it seeds lm_prompt_defaults
-- on startup. New sessions copy defaults into lm_prompts so each session
-- can be tuned without affecting others.
--
-- prompt_id is sha256(prompt_text), giving a stable cache key.
-- ---------------------------------------------------------------------------

-- prompt_text is the assembled, send-ready system prompt that's hashed into
-- prompt_id and used as a cache key. guidance_json holds the structured
-- inputs (toggles + freeform house rules) that were assembled into
-- prompt_text; non-null = "structured" mode and the UI's editor knows how to
-- round-trip; null = "advanced" mode, prompt_text is verbatim user-authored.
CREATE TABLE lm_prompt_defaults (
  invocation_reason TEXT PRIMARY KEY,
  prompt_text       TEXT NOT NULL,
  prompt_id         TEXT NOT NULL,
  source            TEXT NOT NULL CHECK(source IN ('seed', 'override')),
  guidance_json     TEXT,
  updated_at        TEXT NOT NULL
);

CREATE TABLE lm_prompts (
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  invocation_reason TEXT NOT NULL,
  prompt_text       TEXT NOT NULL,
  prompt_id         TEXT NOT NULL,
  guidance_json     TEXT,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (session_id, invocation_reason)
);

CREATE INDEX idx_lm_prompts_session ON lm_prompts(session_id);
