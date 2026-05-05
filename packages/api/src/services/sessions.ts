import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { ParsedCsvRow } from './csv.js';
import type { SessionRow, UrlPairRow } from '../types.js';

export interface CreateSessionInput {
  name: string;
  csv_filename: string;
  rows: ParsedCsvRow[];
}

export interface CreateSessionOutput {
  session: SessionRow;
  url_pairs: UrlPairRow[];
}

export function createSession(db: Db, input: CreateSessionInput): CreateSessionOutput {
  const { name, csv_filename, rows } = input;
  if (rows.length === 0) {
    throw new Error('createSession requires at least one row');
  }

  const sessionId = randomUUID();
  const now = new Date().toISOString();

  const insertSession = db.prepare(
    'INSERT INTO sessions (id, name, csv_filename, created_at) VALUES (?, ?, ?, ?)',
  );
  const insertPair = db.prepare(
    `INSERT INTO url_pairs
       (id, session_id, url_a, url_b, label, row_index, raw_row_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const created: UrlPairRow[] = [];
  const tx = db.transaction(() => {
    insertSession.run(sessionId, name, csv_filename, now);
    rows.forEach((row, idx) => {
      const id = randomUUID();
      const label = row.label ?? null;
      const rawJson = JSON.stringify(row.raw_row);
      insertPair.run(id, sessionId, row.url_a, row.url_b, label, idx, rawJson, now);
      created.push({
        id,
        session_id: sessionId,
        url_a: row.url_a,
        url_b: row.url_b,
        label,
        row_index: idx,
        raw_row_json: rawJson,
        created_at: now,
      });
    });
  });
  tx();

  return {
    session: { id: sessionId, name, csv_filename, created_at: now },
    url_pairs: created,
  };
}

export function getSession(db: Db, id: string): SessionRow | null {
  const row = db
    .prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?')
    .get(id);
  return row ?? null;
}

export function listSessions(db: Db): Array<SessionRow & { url_pair_count: number }> {
  return db
    .prepare<unknown[], SessionRow & { url_pair_count: number }>(
      `SELECT s.id, s.name, s.csv_filename, s.created_at,
              (SELECT COUNT(*) FROM url_pairs p WHERE p.session_id = s.id) AS url_pair_count
       FROM sessions s
       ORDER BY s.created_at DESC`,
    )
    .all();
}

export function listUrlPairs(db: Db, sessionId: string): UrlPairRow[] {
  return db
    .prepare<[string], UrlPairRow>(
      'SELECT * FROM url_pairs WHERE session_id = ? ORDER BY row_index',
    )
    .all(sessionId);
}

export function deleteSession(db: Db, id: string): boolean {
  const info = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return info.changes > 0;
}
