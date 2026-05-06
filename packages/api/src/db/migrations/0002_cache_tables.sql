-- Cache substrate for the project model. The runs tables remain the ledger;
-- these tables are denormalized read-side indexes keyed by stable hashes so
-- the cache survives schema/UI changes.

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

CREATE TABLE lm_verdict_cache (
  capture_a_sha     TEXT NOT NULL,
  capture_b_sha     TEXT NOT NULL,
  prompt_id         TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  invocation_reason TEXT NOT NULL,
  pipeline_version  TEXT NOT NULL,
  verdict           INTEGER,
  summary           TEXT,
  confidence        REAL,
  comparison_id     TEXT NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (capture_a_sha, capture_b_sha, prompt_id, model_id, invocation_reason, pipeline_version)
);

CREATE INDEX idx_lm_verdict_cache_comparison ON lm_verdict_cache(comparison_id);
