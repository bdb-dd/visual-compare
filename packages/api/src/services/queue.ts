import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { JobRow, JobStatus, JobType } from '../types.js';

export interface CreateJobInput {
  type: JobType;
  progress_total: number;
}

/**
 * Chain key used to gate sequential vs parallel execution. Jobs share a
 * chain key iff they should serialize against each other. Capture jobs
 * (CPU/network-bound on the API VM) and comparison jobs (LM-bound on the
 * GPU) live on different chains so they can run concurrently — the
 * evaluator's streaming orchestrator depends on this.
 *
 * Two comparison jobs still serialize against each other within the
 * `comparison` chain — that's fine because each comparison job already
 * runs its pairs concurrently up to `options.concurrency` internally.
 */
type ChainKey = JobType;

export interface JobContext {
  jobId: string;
  /** Increment progress_current. Safe to call from inside the handler. */
  incrementProgress(by?: number): void;
  /** Replace progress_current with an absolute value. */
  setProgress(current: number): void;
  /** Replace progress_total. */
  setTotal(total: number): void;
}

export type JobHandler = (ctx: JobContext) => Promise<void> | void;

/**
 * Tiny in-process job queue. Jobs of the same `type` run sequentially on a
 * shared promise chain; different types run concurrently on independent
 * chains. This lets the evaluator stream comparisons in parallel with an
 * ongoing capture run (capture and comparison loads land on different
 * machines anyway — API VM vs the on-demand GPU).
 *
 * The capture pipeline does its own bounded Playwright concurrency *inside*
 * its handler — one queue slot is one capture run or comparison run, not
 * one screenshot.
 */
export class JobQueue {
  #db: Db;
  #chains: Map<ChainKey, Promise<void>> = new Map();
  #stopped = false;
  #waitForJob = new Map<string, Promise<void>>();

  constructor(db: Db) {
    this.#db = db;
  }

  /** Create a `pending` jobs row and return its id. */
  createJob(input: CreateJobInput): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO jobs (id, type, status, progress_current, progress_total, created_at)
         VALUES (?, ?, 'pending', 0, ?, ?)`,
      )
      .run(id, input.type, input.progress_total, now);
    return id;
  }

  /**
   * Enqueue a handler. Returns immediately (HTTP route should already have
   * created the job and returned 202). The handler is invoked later on the
   * per-type chain — so a `comparison` handler may run concurrently with a
   * `capture` handler, but two `comparison` handlers serialize.
   */
  enqueue(jobId: string, handler: JobHandler): void {
    if (this.#stopped) {
      throw new Error('Queue is stopped');
    }
    const row = this.#db
      .prepare<[string], { type: JobType }>('SELECT type FROM jobs WHERE id = ?')
      .get(jobId);
    if (!row) {
      throw new Error(`enqueue: job ${jobId} has no row (createJob first)`);
    }
    const chainKey: ChainKey = row.type;
    const prev = this.#chains.get(chainKey) ?? Promise.resolve();
    const next = prev.then(() => this.#run(jobId, handler));
    this.#chains.set(chainKey, next);
    // Track the chain segment that resolves once `jobId` finishes — await
    // this when the orchestrator needs to coordinate around a specific job.
    this.#waitForJob.set(jobId, next);
    next.finally(() => this.#waitForJob.delete(jobId));
  }

  /** Returns a promise that resolves when the given job's handler finishes. */
  waitForJob(jobId: string): Promise<void> | undefined {
    return this.#waitForJob.get(jobId);
  }

  /** Wait for all enqueued work to drain. Used by tests. */
  async drain(): Promise<void> {
    // Snapshot the chains and await them. New jobs enqueued during drain
    // chain onto the per-type promise we already captured here, so awaiting
    // the snapshot is enough to wait for everything queued so far.
    await Promise.all([...this.#chains.values()]);
  }

  /** Stop accepting new work. Existing chain is allowed to finish. */
  stop(): void {
    this.#stopped = true;
  }

  async #run(jobId: string, handler: JobHandler): Promise<void> {
    const startedAt = new Date().toISOString();
    this.#db
      .prepare(`UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?`)
      .run(startedAt, jobId);

    const ctx: JobContext = {
      jobId,
      incrementProgress: (by = 1) => {
        this.#db
          .prepare(`UPDATE jobs SET progress_current = progress_current + ? WHERE id = ?`)
          .run(by, jobId);
      },
      setProgress: (current) => {
        this.#db
          .prepare(`UPDATE jobs SET progress_current = ? WHERE id = ?`)
          .run(current, jobId);
      },
      setTotal: (total) => {
        this.#db
          .prepare(`UPDATE jobs SET progress_total = ? WHERE id = ?`)
          .run(total, jobId);
      },
    };

    try {
      await handler(ctx);
      const completedAt = new Date().toISOString();
      this.#db
        .prepare(
          `UPDATE jobs SET status = 'complete', completed_at = ? WHERE id = ?`,
        )
        .run(completedAt, jobId);
    } catch (err) {
      const completedAt = new Date().toISOString();
      const message = err instanceof Error ? err.message : String(err);
      this.#db
        .prepare(
          `UPDATE jobs
           SET status = 'error', error_message = ?, completed_at = ?
           WHERE id = ?`,
        )
        .run(message, completedAt, jobId);
      // Rethrow so consumers can observe via tests if they want; the chain's
      // .then() will swallow it for the next job.
      // Actually we DO want the chain to keep going, so just log.
      // eslint-disable-next-line no-console
      console.error(`[queue] job ${jobId} failed:`, err);
    }
  }
}

export function getJob(db: Db, id: string): JobRow | null {
  const row = db
    .prepare<[string], JobRow>('SELECT * FROM jobs WHERE id = ?')
    .get(id);
  return row ?? null;
}

export function listJobsByStatus(db: Db, status: JobStatus): JobRow[] {
  return db
    .prepare<[string], JobRow>('SELECT * FROM jobs WHERE status = ? ORDER BY created_at')
    .all(status);
}
