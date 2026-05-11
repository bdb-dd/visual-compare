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
];

export interface MigrationResult {
  columns_added: number;
}

export function runColumnMigrations(db: Db): MigrationResult {
  let added = 0;
  for (const m of COLUMN_ADDITIONS) {
    if (!tableExists(db, m.table)) continue;
    if (columnExists(db, m.table, m.column)) continue;
    db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.ddl}`);
    added += 1;
  }
  return { columns_added: added };
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
