-- Promote sessions from one-shot CSV uploads into long-lived projects with a
-- persistent configuration. Empty JSON defaults mean "no override" and the
-- evaluator falls back to system defaults; non-empty values represent the
-- user's tuned configuration.

ALTER TABLE sessions ADD COLUMN default_viewports TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sessions ADD COLUMN default_capture_options TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN default_equivalence_levels TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sessions ADD COLUMN filter_query TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN allow_list TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sessions ADD COLUMN archived_at TEXT;

-- Promote known metadata out of url_pairs.raw_row_json so the filter DSL can
-- query them with indexes. Phase 7 will start using `disabled` for the
-- soft-remove gesture; it's added now to avoid a second migration.
ALTER TABLE url_pairs ADD COLUMN language TEXT;
ALTER TABLE url_pairs ADD COLUMN category TEXT;
ALTER TABLE url_pairs ADD COLUMN subcategory TEXT;
ALTER TABLE url_pairs ADD COLUMN path TEXT;
ALTER TABLE url_pairs ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_url_pairs_language ON url_pairs(language);
CREATE INDEX idx_url_pairs_category ON url_pairs(category);
CREATE INDEX idx_url_pairs_subcategory ON url_pairs(subcategory);
CREATE INDEX idx_url_pairs_path ON url_pairs(path);
CREATE INDEX idx_url_pairs_disabled ON url_pairs(disabled);
