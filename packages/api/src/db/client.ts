import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

export interface OpenDbOptions {
  /** Path to the SQLite file. Pass `:memory:` for tests. */
  path: string;
  /** Defaults to `true` for file-backed DBs, `false` for `:memory:`. */
  enableWal?: boolean;
}

export function openDatabase(options: OpenDbOptions): Db {
  const { path } = options;
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  const enableWal = options.enableWal ?? path !== ':memory:';
  db.pragma('foreign_keys = ON');
  if (enableWal) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('synchronous = NORMAL');
  return db;
}
