import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Db } from './client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const SCHEMA_PATH = join(__dirname, 'schema.sql');

/**
 * Apply the canonical schema to a database. Idempotent: if the schema
 * appears to be already loaded (any user table present), this is a no-op.
 *
 * There is no migration history. When the schema changes, edit
 * `schema.sql` and wipe the dev DB.
 */
export function applySchema(db: Db, schemaPath: string = SCHEMA_PATH): { applied: boolean } {
  const existing = db
    .prepare<unknown[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1`,
    )
    .get();
  if (existing) return { applied: false };

  const sql = readFileSync(schemaPath, 'utf8');
  db.transaction(() => {
    db.exec(sql);
  })();
  return { applied: true };
}
