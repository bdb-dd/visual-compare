import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { JobRow, JobStatus, JobType } from '../types.js';

export interface CreateJobInput {
  type: JobType;
  progress_total: number;
}

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
 * Tiny in-process job queue. Each enqueued job runs sequentially in a single
 * promise chain. The capture pipeline does its own bounded Playwright
 * concurrency *inside* its handler — one queue slot is one capture or
 * comparison run, not one screenshot.
 */
export class JobQueue {
  #db: Db;
  #chain: Promise<void> = Promise.resolve();
  #stopped = false;

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
   * internal chain.
   */
  enqueue(jobId: string, handler: JobHandler): void {
    if (this.#stopped) {
      throw new Error('Queue is stopped');
    }
    this.#chain = this.#chain.then(() => this.#run(jobId, handler));
  }

  /** Wait for all enqueued work to drain. Used by tests. */
  async drain(): Promise<void> {
    await this.#chain;
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
