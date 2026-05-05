import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createApp } from './app.js';
import { openDatabase } from './db/client.js';
import { runMigrations } from './db/migrations.js';
import { recoverInterruptedRuns } from './db/recovery.js';
import { JobQueue } from './services/queue.js';
import { createArtifactStore } from './services/artifact-store.js';
import { createPlaywrightCaptureWorker } from './services/capture.js';

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = resolve(dirname(__filename), '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

const PORT = Number(process.env.PORT ?? 3001);
const DB_PATH = process.env.DB_PATH ?? resolve(REPO_ROOT, 'data', 'visual-compare.sqlite');
const IMAGES_DIR = process.env.IMAGES_DIR ?? resolve(REPO_ROOT, 'data', 'images');

mkdirSync(IMAGES_DIR, { recursive: true });

const db = openDatabase({ path: DB_PATH });
runMigrations(db);

const recovery = recoverInterruptedRuns(db);
if (recovery.jobs + recovery.captures + recovery.comparisons > 0) {
  // eslint-disable-next-line no-console
  console.log(
    `[recovery] flipped to error: jobs=${recovery.jobs} captures=${recovery.captures} comparisons=${recovery.comparisons}`,
  );
}

const queue = new JobQueue(db);
const artifactStore = createArtifactStore(IMAGES_DIR);
const captureWorker = createPlaywrightCaptureWorker();

const app = createApp({ db, queue, artifactStore, captureWorker });

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[api] data dir: ${IMAGES_DIR}`);
  // eslint-disable-next-line no-console
  console.log(`[api] sqlite:  ${DB_PATH}`);
});

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
