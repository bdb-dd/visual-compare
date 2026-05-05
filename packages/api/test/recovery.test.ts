import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';
import { recoverInterruptedRuns, INTERRUPTED_BY_RESTART } from '../src/db/recovery.js';
import { randomUUID } from 'node:crypto';

function setup() {
  const db = openDatabase({ path: ':memory:' });
  runMigrations(db);
  return db;
}

describe('recoverInterruptedRuns', () => {
  it('flips running jobs and processing rows to error, leaves pending alone', () => {
    const db = setup();
    const sessionId = randomUUID();
    const captureRunId = randomUUID();
    const compRunId = randomUUID();
    const runningJobId = randomUUID();
    const pendingJobId = randomUUID();
    const compJobId = randomUUID();
    const now = new Date().toISOString();

    db.prepare('INSERT INTO sessions (id, name, csv_filename, created_at) VALUES (?, ?, ?, ?)').run(
      sessionId,
      'test',
      'test.csv',
      now,
    );

    const insertJob = db.prepare(
      `INSERT INTO jobs (id, type, status, progress_current, progress_total, created_at)
       VALUES (?, ?, ?, 0, 1, ?)`,
    );
    insertJob.run(runningJobId, 'capture', 'running', now);
    insertJob.run(pendingJobId, 'capture', 'pending', now);
    insertJob.run(compJobId, 'comparison', 'running', now);

    db.prepare(
      `INSERT INTO capture_runs (id, session_id, job_id, options_json, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(captureRunId, sessionId, runningJobId, '{}', now);

    const pairId = randomUUID();
    db.prepare(
      `INSERT INTO url_pairs (id, session_id, url_a, url_b, label, row_index, raw_row_json, created_at)
       VALUES (?, ?, ?, ?, NULL, 0, '{}', ?)`,
    ).run(pairId, sessionId, 'https://a.com', 'https://b.com', now);

    const insertCapture = db.prepare(
      `INSERT INTO captures
        (id, capture_run_id, url_pair_id, side, url, status, viewport_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const processingCapId = randomUUID();
    const pendingCapId = randomUUID();
    insertCapture.run(processingCapId, captureRunId, pairId, 'a', 'https://a.com', 'processing', 'desktop', now);
    insertCapture.run(pendingCapId, captureRunId, pairId, 'b', 'https://b.com', 'pending', 'desktop', now);

    db.prepare(
      `INSERT INTO comparison_runs (id, session_id, capture_run_id, job_id, equivalence_level, options_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(compRunId, sessionId, captureRunId, compJobId, 'strict', '{}', now);

    const procCompId = randomUUID();
    db.prepare(
      `INSERT INTO comparisons
        (id, comparison_run_id, url_pair_id, capture_a_id, capture_b_id, viewport_name, equivalence_level, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?)`,
    ).run(procCompId, compRunId, pairId, processingCapId, pendingCapId, 'desktop', 'strict', now);

    const result = recoverInterruptedRuns(db);
    expect(result).toEqual({ jobs: 2, captures: 1, comparisons: 1 });

    const runningJobAfter = db.prepare<[string], { status: string; error_message: string | null }>(
      'SELECT status, error_message FROM jobs WHERE id = ?',
    ).get(runningJobId);
    expect(runningJobAfter).toEqual({ status: 'error', error_message: INTERRUPTED_BY_RESTART });

    const pendingJobAfter = db.prepare<[string], { status: string }>(
      'SELECT status FROM jobs WHERE id = ?',
    ).get(pendingJobId);
    expect(pendingJobAfter?.status).toBe('pending');

    const procCapAfter = db.prepare<[string], { status: string; error_message: string | null }>(
      'SELECT status, error_message FROM captures WHERE id = ?',
    ).get(processingCapId);
    expect(procCapAfter).toEqual({ status: 'error', error_message: INTERRUPTED_BY_RESTART });

    const pendingCapAfter = db.prepare<[string], { status: string }>(
      'SELECT status FROM captures WHERE id = ?',
    ).get(pendingCapId);
    expect(pendingCapAfter?.status).toBe('pending');

    const procCompAfter = db.prepare<[string], { status: string; error_message: string | null }>(
      'SELECT status, error_message FROM comparisons WHERE id = ?',
    ).get(procCompId);
    expect(procCompAfter).toEqual({ status: 'error', error_message: INTERRUPTED_BY_RESTART });
  });
});
