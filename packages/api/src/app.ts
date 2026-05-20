import express, { type Express } from 'express';
import { csrfGuard } from './middleware/csrf.js';
import { createRateLimit } from './middleware/rate-limit.js';
import { sessionsRouter } from './routes/sessions.js';
import { captureRunsRouter } from './routes/capture-runs.js';
import { capturesRouter } from './routes/captures.js';
import { comparisonRunsRouter } from './routes/comparison-runs.js';
import { comparisonsRouter } from './routes/comparisons.js';
import { evaluationsRouter } from './routes/evaluations.js';
import { jobsRouter } from './routes/jobs.js';
import { lmPromptsRouter } from './routes/lm-prompts.js';
import { metaRouter } from './routes/meta.js';
import type { Db } from './db/client.js';
import type { JobQueue } from './services/queue.js';
import type { ArtifactStore } from './services/artifact-store.js';
import type { CaptureWorker } from './services/capture.js';
import type { ComparisonImagick } from './services/comparison.js';
import type { LmClient } from './services/lm.js';
import type { LmActivityTracker } from './services/lm-activity.js';
import type { WorkerActivityTracker } from './services/worker-activity.js';
import { Evaluator } from './services/evaluator.js';

export interface AppDeps {
  db: Db;
  queue: JobQueue;
  artifactStore: ArtifactStore;
  captureWorker: CaptureWorker;
  /** Test seam — when omitted, services use the real `magick` CLI. */
  imagick?: ComparisonImagick;
  /** LM Studio client. Required for `semantic` and ambiguity-band paths. */
  lm?: LmClient;
  /** Activity histogram source for /api/meta/lm-activity. */
  lmActivity?: LmActivityTracker;
  /** Activity histogram source for /api/meta/worker-activity (captures + comparisons). */
  workerActivity?: WorkerActivityTracker;
  /** Optional pre-built evaluator. Tests can pass one in to inspect drainAll(). */
  evaluator?: Evaluator;
  /**
   * Enable the per-IP token-bucket rate limiter on /api/*. Off by default so
   * tests aren't throttled. Production should pass `{ refillPerSecond, burst }`.
   * When enabled, Express's `trust proxy` is set to `loopback` so `req.ip`
   * reflects Caddy's `X-Forwarded-For` rather than 127.0.0.1.
   */
  rateLimit?: { refillPerSecond: number; burst: number };
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  if (deps.rateLimit) {
    app.set('trust proxy', 'loopback');
    app.use('/api', createRateLimit(deps.rateLimit));
  }
  app.use('/api', csrfGuard);
  app.use(express.json({ limit: '1mb' }));

  const evaluator =
    deps.evaluator ??
    new Evaluator({
      db: deps.db,
      queue: deps.queue,
      artifactStore: deps.artifactStore,
      worker: deps.captureWorker,
      imagick: deps.imagick,
      lm: deps.lm,
      workerActivity: deps.workerActivity,
    });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.use(
    '/api/sessions',
    sessionsRouter({ db: deps.db, evaluator, lm: deps.lm }),
  );
  app.use(
    '/api/capture-runs',
    captureRunsRouter({
      db: deps.db,
      queue: deps.queue,
      artifactStore: deps.artifactStore,
      worker: deps.captureWorker,
      workerActivity: deps.workerActivity,
    }),
  );
  app.use('/api/captures', capturesRouter(deps.db));
  app.use(
    '/api/comparison-runs',
    comparisonRunsRouter({
      db: deps.db,
      queue: deps.queue,
      artifactStore: deps.artifactStore,
      imagick: deps.imagick,
      lm: deps.lm,
      workerActivity: deps.workerActivity,
    }),
  );
  app.use('/api/comparisons', comparisonsRouter(deps.db));
  app.use('/api/evaluations', evaluationsRouter(deps.db, evaluator));
  app.use('/api/jobs', jobsRouter(deps.db));
  app.use('/api/lm-prompts', lmPromptsRouter(deps.db));
  app.use('/api/meta', metaRouter({ lm: deps.lm, lmActivity: deps.lmActivity, workerActivity: deps.workerActivity }));

  app.use('/images', express.static(deps.artifactStore.rootDir, {
    maxAge: '1y',
    immutable: true,
    fallthrough: false,
  }));

  return app;
}
