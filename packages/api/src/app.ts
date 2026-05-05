import express, { type Express } from 'express';
import { sessionsRouter } from './routes/sessions.js';
import { captureRunsRouter } from './routes/capture-runs.js';
import { capturesRouter } from './routes/captures.js';
import { comparisonRunsRouter } from './routes/comparison-runs.js';
import { comparisonsRouter } from './routes/comparisons.js';
import { jobsRouter } from './routes/jobs.js';
import { metaRouter } from './routes/meta.js';
import type { Db } from './db/client.js';
import type { JobQueue } from './services/queue.js';
import type { ArtifactStore } from './services/artifact-store.js';
import type { CaptureWorker } from './services/capture.js';
import type { ComparisonImagick } from './services/comparison.js';
import type { LmClient } from './services/lm.js';

export interface AppDeps {
  db: Db;
  queue: JobQueue;
  artifactStore: ArtifactStore;
  captureWorker: CaptureWorker;
  /** Test seam — when omitted, services use the real `magick` CLI. */
  imagick?: ComparisonImagick;
  /** LM Studio client. Required for `semantic` and ambiguity-band paths. */
  lm?: LmClient;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.use('/api/sessions', sessionsRouter(deps.db));
  app.use(
    '/api/capture-runs',
    captureRunsRouter({
      db: deps.db,
      queue: deps.queue,
      artifactStore: deps.artifactStore,
      worker: deps.captureWorker,
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
    }),
  );
  app.use('/api/comparisons', comparisonsRouter(deps.db));
  app.use('/api/jobs', jobsRouter(deps.db));
  app.use('/api/meta', metaRouter({ lm: deps.lm }));

  app.use('/images', express.static(deps.artifactStore.rootDir, {
    maxAge: '1y',
    immutable: true,
    fallthrough: false,
  }));

  return app;
}
