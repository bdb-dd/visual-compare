import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Db } from './client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const SCHEMA_PATH = join(__dirname, 'schema.sql');

/**
 * Apply the canonical schema to a database. Idempotent on fresh DBs (sets
 * `user_version` from the schema); on existing DBs, runs in-place migrations
 * bumping `user_version` to the latest.
 *
 * When the schema changes, edit `schema.sql` AND add a step to
 * `migrateExistingDb`. Wiping the dev DB is still always a valid escape
 * hatch, but no longer the only option.
 */
export function applySchema(db: Db, schemaPath: string = SCHEMA_PATH): { applied: boolean } {
  const existing = db
    .prepare<unknown[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1`,
    )
    .get();
  if (!existing) {
    const sql = readFileSync(schemaPath, 'utf8');
    db.transaction(() => {
      db.exec(sql);
    })();
    return { applied: true };
  }

  migrateExistingDb(db);
  return { applied: false };
}

function getUserVersion(db: Db): number {
  const row = db.prepare<unknown[], { user_version: number }>('PRAGMA user_version').get();
  return row?.user_version ?? 0;
}

/**
 * Sequential migrations for existing DBs. Each step bumps `user_version`
 * after its DDL so re-running is a no-op. Keep migrations idempotent and
 * additive — destructive changes are reserved for "wipe the DB."
 */
function migrateExistingDb(db: Db): void {
  if (getUserVersion(db) < 1) {
    // v1: allow `cancelled` in evaluations.status. SQLite can't relax a CHECK
    // constraint with ALTER, so recreate the table preserving its rows and
    // indexes.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE evaluations_new (
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
        INSERT INTO evaluations_new
          SELECT id, session_id, config_snapshot_json, enabled_pair_count,
                 capture_run_id, comparison_run_id, cache_hits, status,
                 error_message, started_at, completed_at
            FROM evaluations;
        DROP TABLE evaluations;
        ALTER TABLE evaluations_new RENAME TO evaluations;
        CREATE INDEX idx_evaluations_session ON evaluations(session_id);
        CREATE INDEX idx_evaluations_status ON evaluations(status);
        PRAGMA user_version = 1;
      `);
    })();
  }
}
