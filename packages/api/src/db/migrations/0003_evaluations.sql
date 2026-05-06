-- An evaluation is the act of turning a session's current configuration into
-- verdicts. Most rows here are bookkeeping for the history panel and for
-- diffing config changes over time; only the run id columns and
-- completed_at have load-bearing logic (coalescing checks for incomplete
-- evaluations of the same session).

CREATE TABLE evaluations (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  config_snapshot_json TEXT NOT NULL,
  enabled_pair_count   INTEGER NOT NULL,
  capture_run_id       TEXT REFERENCES capture_runs(id) ON DELETE SET NULL,
  comparison_run_ids   TEXT NOT NULL DEFAULT '[]',
  cache_hits           TEXT NOT NULL DEFAULT '{}',
  status               TEXT NOT NULL CHECK(status IN ('pending', 'running', 'complete', 'error')),
  error_message        TEXT,
  started_at           TEXT NOT NULL,
  completed_at         TEXT
);

CREATE INDEX idx_evaluations_session ON evaluations(session_id);
CREATE INDEX idx_evaluations_status ON evaluations(status);
