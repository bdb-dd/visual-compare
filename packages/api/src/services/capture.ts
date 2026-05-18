import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { chromium, type Browser, type Page, type Response } from 'playwright';
import type { Db } from '../db/client.js';
import { createLimit } from './concurrency.js';
import type { WorkerActivityTracker } from './worker-activity.js';
import type { ArtifactStore } from './artifact-store.js';
import type { JobQueue } from './queue.js';
import { listUrlPairs } from './sessions.js';
import type {
  CaptureRow,
  CaptureRunOptions,
  CaptureRunRow,
  CaptureSide,
  PlannedCapture,
  ViewportDef,
} from '../types.js';
import { DEFAULT_VIEWPORTS } from '../constants/viewports.js';
import { captureOptsHashFor } from './capture-opts-hash.js';
import { assertSafeCaptureUrl } from './url-guard.js';

const viewportSchema = z.object({
  name: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive(),
  orientation: z.enum(['portrait', 'landscape']),
});

export const captureRunOptionsSchema = z.object({
  viewports: z.array(viewportSchema).min(1).default(DEFAULT_VIEWPORTS),
  userAgent: z.string().optional(),
  locale: z.string().optional(),
  timezoneId: z.string().optional(),
  reducedMotion: z.enum(['reduce', 'no-preference']).default('reduce'),
  waitForSelector: z.string().optional(),
  hideSelectors: z.array(z.string()).optional(),
  settleDelayMs: z.number().int().nonnegative().default(250),
  useNetworkIdle: z.boolean().default(false),
  // Upper bound is a guard rail, not the per-host cap. The UI further
  // narrows this to `availableParallelism()` via /api/meta/system-info so
  // users on smaller machines don't oversubscribe. 32 is comfortably above
  // any laptop core count we run on and well under any chromium-pool ceiling.
  concurrency: z.number().int().min(1).max(32).default(8),
  urlPairIds: z.array(z.string()).optional(),
  /**
   * Restrict the run to specific sides. Used by the evaluator after a
   * side-scoped invalidation so we recapture only what's missing instead
   * of both sides. Defaults to both.
   */
  sides: z.array(z.enum(['a', 'b'])).min(1).optional(),
});

export type CaptureRunOptionsInput = z.input<typeof captureRunOptionsSchema>;
export type CaptureRunOptionsParsed = z.output<typeof captureRunOptionsSchema>;

export interface CaptureWorker {
  capture(args: CaptureWorkerArgs): Promise<CaptureWorkerResult>;
  shutdown(): Promise<void>;
}

export interface CaptureWorkerArgs {
  url: string;
  viewport: ViewportDef;
  options: CaptureRunOptionsParsed;
}

export interface CaptureWorkerResult {
  /** Filesystem path of the captured PNG (caller takes ownership). */
  tempPath: string;
  /** Optional metadata to persist on the captures row. */
  metadata?: Record<string, unknown>;
  /** Wall time of the capture in ms. */
  durationMs: number;
  /** HTTP response status from the navigation, or null when unavailable. */
  httpStatus?: number | null;
  /**
   * True when the rendered page is treated as a missing-page (HTTP 4xx/5xx
   * or the title matches the soft-404 regex). Stubs that don't care can omit
   * this; the orchestrator treats `undefined` as `false`.
   */
  isMissing?: boolean;
}

/**
 * Hardcoded soft-404 marker. Matches the most common English/Norwegian
 * "page not found" page titles. Intentionally not session-configurable yet
 * — bump to a session field if a target site has a quirky 404 page.
 */
const MISSING_PAGE_TITLE_RE = /(page not found|not found|404|finner ikke)/i;

/**
 * Wallclock cap for a single capture. Bounds the long tail: page.goto has a
 * 30s timeout but later stages (fonts.ready, title, screenshot) had none, so
 * a stuck page could park a concurrency slot for minutes. On timeout we
 * close the context, which forcibly aborts any in-flight nav/screenshot.
 */
const CAPTURE_WALLCLOCK_MS = 30_000;

/** A real Playwright-backed capture worker. One persistent browser, many contexts. */
export function createPlaywrightCaptureWorker(): CaptureWorker {
  let browserPromise: Promise<Browser> | null = null;

  const getBrowser = async (): Promise<Browser> => {
    if (!browserPromise) {
      browserPromise = chromium.launch({ headless: true });
    }
    return browserPromise;
  };

  const capture = async (args: CaptureWorkerArgs): Promise<CaptureWorkerResult> => {
    const startedAt = Date.now();
    await assertSafeCaptureUrl(args.url);
    const browser = await getBrowser();
    const { url, viewport, options } = args;
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      isMobile: viewport.orientation === 'portrait' && viewport.width < 768,
      userAgent: options.userAgent,
      locale: options.locale,
      timezoneId: options.timezoneId,
      reducedMotion: options.reducedMotion,
    });
    const page = await context.newPage();

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`capture exceeded ${CAPTURE_WALLCLOCK_MS}ms wallclock`)),
        CAPTURE_WALLCLOCK_MS,
      );
    });

    const body = async (): Promise<CaptureWorkerResult> => {
      const navResponse = await applyReadinessSequence(page, url, options);
      const tempDir = join(tmpdir(), 'visual-compare-captures');
      await mkdir(tempDir, { recursive: true });
      const tempPath = join(tempDir, `${randomUUID()}.png`);
      await page.screenshot({ path: tempPath, fullPage: false, type: 'png' });

      const httpStatus = navResponse?.status() ?? null;
      const title = await page.title().catch(() => '');
      const isMissing =
        (httpStatus !== null && httpStatus >= 400) ||
        MISSING_PAGE_TITLE_RE.test(title);

      return {
        tempPath,
        durationMs: Date.now() - startedAt,
        httpStatus,
        isMissing,
        metadata: {
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.deviceScaleFactor,
          finalUrl: page.url(),
          pageTitle: title || null,
          httpStatus,
        },
      };
    };

    try {
      return await Promise.race([body(), timeout]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  };

  const shutdown = async (): Promise<void> => {
    if (!browserPromise) return;
    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    if (browser) await browser.close().catch(() => {});
  };

  return { capture, shutdown };
}

/**
 * Default readiness sequence per the plan. `networkidle` is opt-in.
 *
 * Returns the navigation response so the caller can inspect HTTP status for
 * missing-page classification. Playwright returns `null` when no main-frame
 * navigation actually happened (e.g. about:blank). Errors during goto bubble
 * up to the worker's catch block as before.
 */
async function applyReadinessSequence(
  page: Page,
  url: string,
  options: CaptureRunOptionsParsed,
): Promise<Response | null> {
  const response = await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  await page.evaluate(() => document.fonts?.ready ?? Promise.resolve()).catch(() => {});

  if (options.waitForSelector) {
    await page.waitForSelector(options.waitForSelector, { timeout: 10_000 });
  }

  // Trigger lazy-loaded assets.
  await page
    .evaluate(async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const max = document.documentElement.scrollHeight;
      window.scrollTo({ top: max, behavior: 'instant' as ScrollBehavior });
      await sleep(50);
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      await sleep(50);
    })
    .catch(() => {});

  // Disable animations and hide configured selectors.
  const hideSelectors = options.hideSelectors ?? [];
  const css = `
    *, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      caret-color: transparent !important;
    }
    ${hideSelectors.map((s) => `${s} { visibility: hidden !important; }`).join('\n')}
  `;
  await page.addStyleTag({ content: css }).catch(() => {});

  if (options.settleDelayMs > 0) {
    await page.waitForTimeout(options.settleDelayMs);
  }

  if (options.useNetworkIdle) {
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  }

  return response;
}

// ---------------------------------------------------------------------------
// Capture-run orchestration
// ---------------------------------------------------------------------------

export interface StartCaptureRunInput {
  sessionId: string;
  options: CaptureRunOptionsParsed;
  /**
   * Optional signal for cooperative cancellation. When set, the bounded
   * limit-loop checks `aborted` before pulling each next capture. In-flight
   * captures finish naturally — Playwright `page.goto` is not interrupted.
   */
  signal?: AbortSignal;
  /**
   * When provided, inserts exactly one `captures` row per entry instead of
   * the (selected_pairs × viewports × sides) cartesian product. The
   * orchestrator uses this to skip already-cached (pair, viewport, side)
   * tuples — otherwise a single missing capture in a pair forces re-capture
   * of every side+viewport for that pair, and a Recapture-all-then-restart
   * cycle leaves the rest as orphan `pending` rows.
   *
   * Tuples are de-duped on `(url_pair_id, viewport_name, side)` to satisfy
   * the captures UNIQUE constraint. `options.urlPairIds` and `options.sides`
   * are ignored when this is set; `options.viewports` is still consulted at
   * the worker level (each entry's `viewport_name` must resolve there).
   *
   * An empty array is treated as "no work" and throws.
   */
  explicitCaptures?: PlannedCapture[];
}

export interface StartCaptureRunResult {
  capture_run_id: string;
  job_id: string;
  capture_count: number;
}

export interface CaptureRunDeps {
  db: Db;
  queue: JobQueue;
  artifactStore: ArtifactStore;
  worker: CaptureWorker;
  /** Optional in-flight tracker for the CPU usage indicator. */
  workerActivity?: WorkerActivityTracker;
}

const SIDES: CaptureSide[] = ['a', 'b'];

export function startCaptureRun(
  deps: CaptureRunDeps,
  input: StartCaptureRunInput,
): StartCaptureRunResult {
  const { db, queue, artifactStore, worker } = deps;
  const { sessionId, options, signal, explicitCaptures } = input;

  const allPairs = listUrlPairs(db, sessionId);
  if (allPairs.length === 0) {
    throw new Error(`Session ${sessionId} has no url_pairs`);
  }

  // Two shapes:
  //   1. explicitCaptures provided  → one captures row per entry (the
  //      orchestrator's narrow path; skips already-cached tuples).
  //   2. fallback (HTTP /capture-runs, tests)  → selected_pairs × viewports
  //      × sides cartesian product.
  let plannedRows: { pair_id: string; viewport_name: string; side: CaptureSide; url: string }[];

  if (explicitCaptures !== undefined) {
    if (explicitCaptures.length === 0) {
      throw new Error('explicitCaptures is empty — nothing to capture');
    }
    const knownPairIds = new Set(allPairs.map((p) => p.id));
    const seen = new Set<string>();
    plannedRows = [];
    for (const c of explicitCaptures) {
      if (!knownPairIds.has(c.url_pair_id)) {
        throw new Error(
          `explicitCaptures entry references url_pair_id ${c.url_pair_id} not in session ${sessionId}`,
        );
      }
      const key = `${c.url_pair_id}::${c.viewport_name}::${c.side}`;
      if (seen.has(key)) continue;
      seen.add(key);
      plannedRows.push({
        pair_id: c.url_pair_id,
        viewport_name: c.viewport_name,
        side: c.side,
        url: c.url,
      });
    }
  } else {
    const selected = options.urlPairIds && options.urlPairIds.length > 0
      ? allPairs.filter((p) => options.urlPairIds!.includes(p.id))
      : allPairs;
    if (selected.length === 0) {
      throw new Error('No url_pairs match the supplied urlPairIds');
    }
    const sides = options.sides ?? SIDES;
    plannedRows = [];
    for (const pair of selected) {
      for (const viewport of options.viewports) {
        for (const side of sides) {
          plannedRows.push({
            pair_id: pair.id,
            viewport_name: viewport.name,
            side,
            url: side === 'a' ? pair.url_a : pair.url_b,
          });
        }
      }
    }
  }

  const captureCount = plannedRows.length;
  const jobId = queue.createJob({ type: 'capture', progress_total: captureCount });
  const captureRunId = randomUUID();
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO capture_runs (id, session_id, job_id, options_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(captureRunId, sessionId, jobId, JSON.stringify(options), now);

    const insertCapture = db.prepare(
      `INSERT INTO captures
         (id, capture_run_id, url_pair_id, side, url, status, viewport_name, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    );

    for (const row of plannedRows) {
      insertCapture.run(
        randomUUID(),
        captureRunId,
        row.pair_id,
        row.side,
        row.url,
        row.viewport_name,
        now,
      );
    }
  });
  tx();

  queue.enqueue(jobId, async (ctx) => {
    const captures = db
      .prepare<[string], CaptureRow>(
        `SELECT * FROM captures WHERE capture_run_id = ? ORDER BY created_at`,
      )
      .all(captureRunId);

    deps.workerActivity?.observeCapacity(options.concurrency);
    const limit = createLimit(options.concurrency);
    await Promise.all(
      captures.map((capture) =>
        limit(async () => {
          // Cooperative cancel: skip captures that haven't been picked up yet
          // when the evaluation was cancelled. Already-started captures finish
          // (Playwright doesn't honor an external AbortSignal mid-navigation),
          // so worst-case wait is one capture's wall-time per active slot.
          if (signal?.aborted) {
            db.prepare(
              `UPDATE captures SET status = 'error', error_message = 'cancelled'
                 WHERE id = ? AND status = 'pending'`,
            ).run(capture.id);
            ctx.incrementProgress();
            return;
          }
          const release = deps.workerActivity?.trackCall();
          try {
            await runOneCapture({ db, artifactStore, worker, options }, capture, ctx);
          } finally {
            release?.();
          }
        }),
      ),
    );
  });

  return { capture_run_id: captureRunId, job_id: jobId, capture_count: captureCount };
}

async function runOneCapture(
  deps: { db: Db; artifactStore: ArtifactStore; worker: CaptureWorker; options: CaptureRunOptionsParsed },
  capture: CaptureRow,
  ctx: { incrementProgress(): void },
): Promise<void> {
  const { db, artifactStore, worker, options } = deps;
  const viewport = options.viewports.find((v) => v.name === capture.viewport_name);
  if (!viewport) {
    db.prepare(
      `UPDATE captures
         SET status = 'error', error_message = ?
         WHERE id = ?`,
    ).run(`Unknown viewport_name '${capture.viewport_name}'`, capture.id);
    ctx.incrementProgress();
    return;
  }

  db.prepare(`UPDATE captures SET status = 'processing' WHERE id = ?`).run(capture.id);

  let tempPath: string | null = null;
  try {
    const result = await worker.capture({ url: capture.url, viewport, options });
    tempPath = result.tempPath;
    const { sha256, byteSize } = await artifactStore.writeImage(tempPath);
    tempPath = null; // ownership handed to artifact store
    const capturedAt = new Date().toISOString();
    const optsHash = captureOptsHashFor(viewport, options);
    db.transaction(() => {
      db.prepare(
        `UPDATE captures
           SET status = 'complete',
               screenshot_sha256 = ?,
               screenshot_byte_size = ?,
               metadata_json = ?,
               duration_ms = ?,
               captured_at = ?,
               http_status = ?,
               is_missing = ?
         WHERE id = ?`,
      ).run(
        sha256,
        byteSize,
        result.metadata ? JSON.stringify(result.metadata) : null,
        result.durationMs,
        capturedAt,
        result.httpStatus ?? null,
        result.isMissing ? 1 : 0,
        capture.id,
      );
      db.prepare(
        `INSERT INTO capture_cache
           (url, viewport_name, capture_opts_hash, screenshot_sha256, capture_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (url, viewport_name, capture_opts_hash) DO UPDATE SET
           screenshot_sha256 = excluded.screenshot_sha256,
           capture_id        = excluded.capture_id,
           created_at        = excluded.created_at`,
      ).run(capture.url, capture.viewport_name, optsHash, sha256, capture.id, capturedAt);
    })();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE captures
         SET status = 'error', error_message = ?
       WHERE id = ?`,
    ).run(message, capture.id);
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => {});
    ctx.incrementProgress();
  }
}

export function getCaptureRun(db: Db, id: string): CaptureRunRow | null {
  const row = db
    .prepare<[string], CaptureRunRow>('SELECT * FROM capture_runs WHERE id = ?')
    .get(id);
  return row ?? null;
}

export function listCaptureRuns(db: Db, sessionId?: string): CaptureRunRow[] {
  if (sessionId) {
    return db
      .prepare<[string], CaptureRunRow>(
        `SELECT * FROM capture_runs WHERE session_id = ? ORDER BY created_at DESC`,
      )
      .all(sessionId);
  }
  return db
    .prepare<unknown[], CaptureRunRow>(
      'SELECT * FROM capture_runs ORDER BY created_at DESC',
    )
    .all();
}

export interface CapturesQuery {
  capture_run_id?: string;
  session_id?: string;
  url_pair_id?: string;
}

export function listCaptures(db: Db, q: CapturesQuery): CaptureRow[] {
  const where: string[] = [];
  const params: string[] = [];
  if (q.capture_run_id) {
    where.push('c.capture_run_id = ?');
    params.push(q.capture_run_id);
  }
  if (q.url_pair_id) {
    where.push('c.url_pair_id = ?');
    params.push(q.url_pair_id);
  }
  if (q.session_id) {
    where.push(
      'c.capture_run_id IN (SELECT id FROM capture_runs WHERE session_id = ?)',
    );
    params.push(q.session_id);
  }
  const sql = `SELECT c.* FROM captures c${
    where.length ? ' WHERE ' + where.join(' AND ') : ''
  } ORDER BY c.created_at`;
  return db.prepare<string[], CaptureRow>(sql).all(...params);
}

export function getCapture(db: Db, id: string): CaptureRow | null {
  const row = db
    .prepare<[string], CaptureRow>('SELECT * FROM captures WHERE id = ?')
    .get(id);
  return row ?? null;
}

/** Helper to write a placeholder PNG file, used by tests. */
export async function writePngPlaceholder(path: string, bytes: Buffer): Promise<void> {
  await writeFile(path, bytes);
}
