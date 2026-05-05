import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Db } from './client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const MIGRATIONS_DIR = join(__dirname, 'migrations');

interface MigrationFile {
  version: number;
  filename: string;
  sql: string;
}

function loadMigrationFiles(dir: string): MigrationFile[] {
  const entries = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  return entries.map((filename) => {
    const match = /^(\d+)_/.exec(filename);
    if (!match) {
      throw new Error(`Migration file does not start with a numeric prefix: ${filename}`);
    }
    const version = Number(match[1]);
    if (!Number.isInteger(version)) {
      throw new Error(`Migration file has invalid version: ${filename}`);
    }
    return {
      version,
      filename,
      sql: readFileSync(join(dir, filename), 'utf8'),
    };
  });
}

function ensureSchemaMigrationsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      filename TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function appliedVersions(db: Db): Set<number> {
  const rows = db
    .prepare<unknown[], { version: number }>('SELECT version FROM schema_migrations')
    .all();
  return new Set(rows.map((r) => r.version));
}

export function runMigrations(db: Db, dir: string = MIGRATIONS_DIR): { applied: number[] } {
  ensureSchemaMigrationsTable(db);
  const applied = appliedVersions(db);
  const files = loadMigrationFiles(dir);

  // Detect duplicate versions and unknown previously-applied versions.
  const seen = new Set<number>();
  for (const f of files) {
    if (seen.has(f.version)) {
      throw new Error(`Duplicate migration version: ${f.version}`);
    }
    seen.add(f.version);
  }
  for (const v of applied) {
    if (!seen.has(v)) {
      throw new Error(
        `Database has migration ${v} applied, but no matching file exists in ${dir}.`,
      );
    }
  }

  const pending = files.filter((f) => !applied.has(f.version));
  if (pending.length === 0) return { applied: [] };

  const insertApplied = db.prepare(
    'INSERT INTO schema_migrations (version, filename, applied_at) VALUES (?, ?, ?)',
  );

  const applyAll = db.transaction(() => {
    for (const f of pending) {
      db.exec(f.sql);
      insertApplied.run(f.version, f.filename, new Date().toISOString());
    }
  });
  applyAll();

  return { applied: pending.map((f) => f.version) };
}
