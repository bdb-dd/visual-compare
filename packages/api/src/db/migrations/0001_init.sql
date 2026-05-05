CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  csv_filename TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE url_pairs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  url_a TEXT NOT NULL,
  url_b TEXT NOT NULL,
  label TEXT,
  row_index INTEGER NOT NULL,
  raw_row_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, row_index)
);

CREATE INDEX idx_url_pairs_session ON url_pairs(session_id);

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
  UNIQUE(capture_run_id, url_pair_id, side, viewport_name)
);

CREATE INDEX idx_captures_run ON captures(capture_run_id);
CREATE INDEX idx_captures_pair ON captures(url_pair_id);
CREATE INDEX idx_captures_status ON captures(status);

CREATE TABLE comparison_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  capture_run_id TEXT NOT NULL REFERENCES capture_runs(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  equivalence_level TEXT NOT NULL,
  options_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_comparison_runs_session ON comparison_runs(session_id);
CREATE INDEX idx_comparison_runs_capture_run ON comparison_runs(capture_run_id);

CREATE TABLE comparisons (
  id TEXT PRIMARY KEY,
  comparison_run_id TEXT NOT NULL REFERENCES comparison_runs(id) ON DELETE CASCADE,
  url_pair_id TEXT NOT NULL REFERENCES url_pairs(id) ON DELETE CASCADE,
  capture_a_id TEXT NOT NULL REFERENCES captures(id),
  capture_b_id TEXT NOT NULL REFERENCES captures(id),
  viewport_name TEXT NOT NULL,
  equivalence_level TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'complete', 'error')),
  changed_pixel_percentage REAL,
  rmse REAL,
  ssim REAL,
  bounding_box_area_percentage REAL,
  connected_component_count INTEGER,
  im_diff_sha256 TEXT,
  im_diff_byte_size INTEGER,
  im_determined_equivalent INTEGER,
  lm_invocation_reason TEXT CHECK(lm_invocation_reason IN ('semantic_mode', 'ambiguous_pixel_result', 'manual_retry')),
  lm_model TEXT,
  lm_prompt_version TEXT,
  lm_summary TEXT,
  lm_confidence REAL,
  lm_response_json TEXT,
  lm_determined_equivalent INTEGER,
  is_equivalent INTEGER,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(comparison_run_id, url_pair_id, viewport_name)
);

CREATE INDEX idx_comparisons_run ON comparisons(comparison_run_id);
CREATE INDEX idx_comparisons_pair ON comparisons(url_pair_id);
CREATE INDEX idx_comparisons_status ON comparisons(status);

CREATE TABLE differences (
  id TEXT PRIMARY KEY,
  comparison_id TEXT NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('imagick', 'lm')),
  description TEXT NOT NULL,
  severity TEXT CHECK(severity IN ('low', 'medium', 'high')),
  bounding_box_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_differences_comparison ON differences(comparison_id);
