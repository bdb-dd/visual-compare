import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createApp } from './app.js';
import { openDatabase } from './db/client.js';
import { applySchema } from './db/schema.js';
import { runColumnMigrations } from './db/migrations.js';
import { recoverInterruptedRuns } from './db/recovery.js';
import { runCacheBackfill } from './services/cache-backfill.js';
import {
  backfillSessionPrompts,
  seedLmPromptDefaults,
} from './services/lm-prompts.js';
import { JobQueue } from './services/queue.js';
import { createArtifactStore } from './services/artifact-store.js';
import { createPlaywrightCaptureWorker } from './services/capture.js';
import { createLmClient, readLmConfigFromEnv } from './services/lm.js';
import { createLmServerControllerFromEnv } from './services/lm-server-factory.js';
import { createLmUsageTracker } from './services/lm-usage.js';

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = resolve(dirname(__filename), '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

const PORT = Number(process.env.PORT ?? 3001);
const LISTEN_HOST = process.env.LISTEN_HOST;
const DB_PATH = process.env.DB_PATH ?? resolve(REPO_ROOT, 'data', 'visual-compare.sqlite');
const IMAGES_DIR = process.env.IMAGES_DIR ?? resolve(REPO_ROOT, 'data', 'images');
const LM_LAST_USE_PATH =
  process.env.LM_LAST_USE_PATH ?? resolve(REPO_ROOT, 'data', 'lm-last-use');

mkdirSync(IMAGES_DIR, { recursive: true });

const db = openDatabase({ path: DB_PATH });
applySchema(db);
const migrationResult = runColumnMigrations(db);
if (migrationResult.columns_added > 0) {
  // eslint-disable-next-line no-console
  console.log(`[migrations] columns_added=${migrationResult.columns_added}`);
}

const recovery = recoverInterruptedRuns(db);
if (recovery.jobs + recovery.captures + recovery.comparisons + recovery.evaluations > 0) {
  // eslint-disable-next-line no-console
  console.log(
    `[recovery] flipped to error: jobs=${recovery.jobs} captures=${recovery.captures} comparisons=${recovery.comparisons} evaluations=${recovery.evaluations}`,
  );
}

const backfill = runCacheBackfill(db);
if (
  backfill.capture_cache_inserted +
    backfill.pixel_compare_cache_inserted +
    backfill.lm_verdict_cache_inserted >
  0
) {
  // eslint-disable-next-line no-console
  console.log(
    `[cache] backfilled: captures=${backfill.capture_cache_inserted} pixel=${backfill.pixel_compare_cache_inserted} lm=${backfill.lm_verdict_cache_inserted} skipped_runs=${backfill.capture_runs_skipped}`,
  );
}

const seededDefaults = seedLmPromptDefaults(db);
const backfilledSessions = backfillSessionPrompts(db);
if (seededDefaults > 0 || backfilledSessions > 0) {
  // eslint-disable-next-line no-console
  console.log(
    `[lm-prompts] seeded_defaults=${seededDefaults} backfilled_sessions=${backfilledSessions}`,
  );
}

const queue = new JobQueue(db);
const artifactStore = createArtifactStore(IMAGES_DIR);
const captureWorker = createPlaywrightCaptureWorker();

const lmConfig = readLmConfigFromEnv();
const lmServer = createLmServerControllerFromEnv();
const lmUsage = createLmUsageTracker({ path: LM_LAST_USE_PATH });
const lm = createLmClient(lmConfig, lmServer.cli, { onLmUsage: () => lmUsage.record() });
// eslint-disable-next-line no-console
console.log(
  `[lm] base=${lmConfig.baseURL} model=${lmConfig.model} prompt=${lmConfig.promptVersion} backend=${lmServer.backend} (${lmServer.description})`,
);

const app = createApp({ db, queue, artifactStore, captureWorker, lm });

// Liveness probe for the reverse proxy / Scaleway healthcheck. Intentionally
// cheap — no DB or LM round-trip; readiness is implied by the process being up.
app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

const onListening = () => {
  const host = LISTEN_HOST ?? 'localhost';
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://${host}:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[api] data dir: ${IMAGES_DIR}`);
  // eslint-disable-next-line no-console
  console.log(`[api] sqlite:  ${DB_PATH}`);
  // eslint-disable-next-line no-console
  console.log(`[api] lm last-use: ${LM_LAST_USE_PATH}`);
};
const server = LISTEN_HOST
  ? app.listen(PORT, LISTEN_HOST, onListening)
  : app.listen(PORT, onListening);

const shutdown = async (signal: string) => {
  // eslint-disable-next-line no-console
  console.log(`[api] received ${signal}, shutting down`);
  queue.stop();
  server.close();
  await captureWorker.shutdown();
  db.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
