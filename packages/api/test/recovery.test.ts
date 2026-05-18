import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { applySchema } from '../src/db/schema.js';
import { recoverInterruptedRuns, INTERRUPTED_BY_RESTART } from '../src/db/recovery.js';
import { randomUUID } from 'node:crypto';

function setup() {
  const db = openDatabase({ path: ':memory:' });
  applySchema(db);
  return db;
}

describe('recoverInterruptedRuns', () => {
  it('flips both processing/running and pending rows to error', () => {
    const db = setup();
    const sessionId = randomUUID();
    const captureRunId = randomUUID();
    const compRunId = randomUUID();
    const runningJobId = randomUUID();
    const pendingJobId = randomUUID();
    const compJobId = randomUUID();
    const completeJobId = randomUUID();
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
    insertJob.run(completeJobId, 'capture', 'complete', now);

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
    const completeCapId = randomUUID();
    insertCapture.run(processingCapId, captureRunId, pairId, 'a', 'https://a.com', 'processing', 'desktop', now);
    insertCapture.run(pendingCapId, captureRunId, pairId, 'b', 'https://b.com', 'pending', 'desktop', now);
    insertCapture.run(completeCapId, captureRunId, pairId, 'a', 'https://a.com', 'complete', 'mobile', now);

    db.prepare(
      `INSERT INTO comparison_runs (id, session_id, capture_run_id, job_id, options_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(compRunId, sessionId, captureRunId, compJobId, '{}', now);

    const procCompId = randomUUID();
    const pendingCompId = randomUUID();
    db.prepare(
      `INSERT INTO comparisons
        (id, comparison_run_id, url_pair_id, capture_a_id, capture_b_id, viewport_name, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'processing', ?)`,
    ).run(procCompId, compRunId, pairId, processingCapId, pendingCapId, 'desktop', now);
    db.prepare(
      `INSERT INTO comparisons
        (id, comparison_run_id, url_pair_id, capture_a_id, capture_b_id, viewport_name, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(pendingCompId, compRunId, pairId, processingCapId, pendingCapId, 'mobile', now);

    const insertEval = db.prepare(
      `INSERT INTO evaluations
        (id, session_id, config_snapshot_json, enabled_pair_count, status, started_at)
        VALUES (?, ?, '{}', 1, ?, ?)`,
    );
    const runningEvalId = randomUUID();
    const pendingEvalId = randomUUID();
    const completeEvalId = randomUUID();
    insertEval.run(runningEvalId, sessionId, 'running', now);
    insertEval.run(pendingEvalId, sessionId, 'pending', now);
    insertEval.run(completeEvalId, sessionId, 'complete', now);

    const result = recoverInterruptedRuns(db);
    // running+pending jobs (3), processing+pending captures (2),
    // processing+pending comparisons (2), running+pending evaluations (2).
    expect(result).toEqual({ jobs: 3, captures: 2, comparisons: 2, evaluations: 2 });

    const statusOf = (table: string, id: string) =>
      db.prepare<[string], { status: string; error_message: string | null }>(
        `SELECT status, error_message FROM ${table} WHERE id = ?`,
      ).get(id);

    expect(statusOf('jobs', runningJobId)).toEqual({ status: 'error', error_message: INTERRUPTED_BY_RESTART });
    expect(statusOf('jobs', pendingJobId)).toEqual({ status: 'error', error_message: INTERRUPTED_BY_RESTART });
    expect(statusOf('jobs', completeJobId)?.status).toBe('complete');

    expect(statusOf('captures', processingCapId)).toEqual({
      status: 'error',
      error_message: INTERRUPTED_BY_RESTART,
    });
    expect(statusOf('captures', pendingCapId)).toEqual({
      status: 'error',
      error_message: INTERRUPTED_BY_RESTART,
    });
    expect(statusOf('captures', completeCapId)?.status).toBe('complete');

    expect(statusOf('comparisons', procCompId)).toEqual({
      status: 'error',
      error_message: INTERRUPTED_BY_RESTART,
    });
    expect(statusOf('comparisons', pendingCompId)).toEqual({
      status: 'error',
      error_message: INTERRUPTED_BY_RESTART,
    });

    const evalAfter = db.prepare<
      [string],
      { status: string; error_message: string | null; completed_at: string | null }
    >('SELECT status, error_message, completed_at FROM evaluations WHERE id = ?');
    expect(evalAfter.get(runningEvalId)?.status).toBe('error');
    expect(evalAfter.get(runningEvalId)?.completed_at).not.toBeNull();
    expect(evalAfter.get(pendingEvalId)?.status).toBe('error');
    expect(evalAfter.get(pendingEvalId)?.completed_at).not.toBeNull();
    expect(evalAfter.get(completeEvalId)?.status).toBe('complete');
  });
});
