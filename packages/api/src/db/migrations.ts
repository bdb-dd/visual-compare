import type { Db } from './client.js';

/**
 * Lightweight column-level migrations. The project's convention is "edit
 * schema.sql, wipe the dev DB" (see `applySchema`), but the dev DB carries
 * real captured data we don't want to discard between schema bumps. Each
 * migration here checks whether a column exists via `PRAGMA table_info` and
 * issues an ALTER TABLE if not. Idempotent — safe to run on every startup.
 *
 * Add new entries at the bottom; do not reorder. Each entry is a
 * `(table, column, ddl)` triple where `ddl` is the column definition that
 * matches `schema.sql` for the canonical (fresh-DB) case.
 */

interface ColumnAddition {
  table: string;
  column: string;
  /** DDL for the column (everything after the column name in `ADD COLUMN`). */
  ddl: string;
}

const COLUMN_ADDITIONS: ColumnAddition[] = [
  { table: 'captures', column: 'http_status', ddl: 'INTEGER' },
  {
    table: 'captures',
    column: 'is_missing',
    ddl: "INTEGER NOT NULL DEFAULT 0 CHECK(is_missing IN (0, 1))",
  },
  {
    table: 'comparisons',
    column: 'pair_outcome',
    ddl:
      "TEXT NOT NULL DEFAULT 'both_present' " +
      "CHECK(pair_outcome IN ('both_present', 'a_missing', 'b_missing', 'both_missing'))",
  },
  // Cluster review (Phase A): v1 taxonomy fields and signature index columns
  // on `differences`. NULL on legacy rows; backfilled by
  // scripts/backfill-cluster-signatures.ts.
  { table: 'differences', column: 'change_type',       ddl: 'TEXT' },
  { table: 'differences', column: 'region_role',       ddl: 'TEXT' },
  { table: 'differences', column: 'element_label',     ddl: 'TEXT' },
  { table: 'differences', column: 'signature',         ddl: 'TEXT' },
  { table: 'differences', column: 'signature_version', ddl: 'TEXT' },
  // Phase D: cluster-rule provenance on per-row acceptances.
  { table: 'acceptances',  column: 'acceptance_rule_id', ddl: 'TEXT REFERENCES acceptance_rules(id) ON DELETE SET NULL' },
  // Persisted UI default for the LM-second-pass toggle.
  {
    table: 'sessions',
    column: 'default_invoke_lm',
    ddl: 'INTEGER NOT NULL DEFAULT 0 CHECK(default_invoke_lm IN (0, 1))',
  },
];

/**
 * Tables we may need to create on an existing DB that pre-dates a feature.
 * `schema.sql` is the canonical source for these — the DDL here mirrors
 * the CREATE TABLE statements there. Adding a new table is a two-step
 * change: edit `schema.sql` and add an entry here.
 *
 * Indices on the new tables are listed separately below so we can add
 * them piecemeal without bundling them with the table DDL.
 */
interface TableCreation {
  table: string;
  ddl: string;
}

const TABLE_CREATIONS: TableCreation[] = [
  {
    table: 'difference_clusters',
    ddl: `CREATE TABLE difference_clusters (
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
    )`,
  },
  {
    table: 'acceptance_rules',
    ddl: `CREATE TABLE acceptance_rules (
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
    )`,
  },
];

interface IndexCreation {
  name: string;
  ddl: string;
}

const INDEX_CREATIONS: IndexCreation[] = [
  { name: 'idx_differences_signature', ddl: 'CREATE INDEX idx_differences_signature ON differences(signature, signature_version)' },
  { name: 'idx_clusters_session_state', ddl: 'CREATE INDEX idx_clusters_session_state ON difference_clusters(session_id, review_state)' },
  { name: 'idx_clusters_session_region', ddl: 'CREATE INDEX idx_clusters_session_region ON difference_clusters(session_id, region_role)' },
  { name: 'idx_clusters_pair_count', ddl: 'CREATE INDEX idx_clusters_pair_count ON difference_clusters(session_id, pair_count DESC)' },
  { name: 'idx_acceptance_rules_session', ddl: 'CREATE INDEX idx_acceptance_rules_session ON acceptance_rules(session_id)' },
  { name: 'idx_acceptance_rules_signature', ddl: 'CREATE INDEX idx_acceptance_rules_signature ON acceptance_rules(signature, signature_version)' },
  { name: 'idx_acceptances_rule', ddl: 'CREATE INDEX idx_acceptances_rule ON acceptances(acceptance_rule_id)' },
  { name: 'idx_captures_url_vp', ddl: 'CREATE INDEX idx_captures_url_vp ON captures(url, viewport_name)' },
];

export interface MigrationResult {
  columns_added: number;
  tables_created: number;
  indices_created: number;
}

export function runColumnMigrations(db: Db): MigrationResult {
  let columns_added = 0;
  for (const m of COLUMN_ADDITIONS) {
    if (!tableExists(db, m.table)) continue;
    if (columnExists(db, m.table, m.column)) continue;
    db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.ddl}`);
    columns_added += 1;
  }
  let tables_created = 0;
  for (const t of TABLE_CREATIONS) {
    if (tableExists(db, t.table)) continue;
    db.exec(t.ddl);
    tables_created += 1;
  }
  let indices_created = 0;
  for (const i of INDEX_CREATIONS) {
    if (indexExists(db, i.name)) continue;
    db.exec(i.ddl);
    indices_created += 1;
  }
  return { columns_added, tables_created, indices_created };
}

function tableExists(db: Db, table: string): boolean {
  const row = db
    .prepare<[string], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(table);
  return !!row;
}

function columnExists(db: Db, table: string, column: string): boolean {
  const rows = db
    .prepare<unknown[], { name: string }>(`PRAGMA table_info(${table})`)
    .all();
  return rows.some((r) => r.name === column);
}

function indexExists(db: Db, name: string): boolean {
  const row = db
    .prepare<[string], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`,
    )
    .get(name);
  return !!row;
}
