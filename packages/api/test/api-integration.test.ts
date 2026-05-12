import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import { applySchema } from '../src/db/schema.js';
import { JobQueue } from '../src/services/queue.js';
import { createArtifactStore } from '../src/services/artifact-store.js';
import type { CaptureWorker } from '../src/services/capture.js';
import type { ComparisonImagick } from '../src/services/comparison.js';
import type { LmClient } from '../src/services/lm.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeStubCaptureWorker(): CaptureWorker {
  let counter = 0;
  return {
    capture: async (args) => {
      const tempDir = join(tmpdir(), 'vc-stub-captures');
      await mkdtemp(join(tmpdir(), 'vc-tmp-'));
      const path = join(tempDir, `cap-${counter++}.png`);
      // Write a unique-but-deterministic byte payload per (url, viewport, side).
      const { mkdir } = await import('node:fs/promises');
      await mkdir(tempDir, { recursive: true });
      const payload = Buffer.from(
        `STUB-CAPTURE\nurl=${args.url}\nvw=${args.viewport.name}\n`,
      );
      await writeFile(path, payload);
      return { tempPath: path, durationMs: 1, metadata: { stub: true } };
    },
    shutdown: async () => {},
  };
}

function makeStubImagick(diffBytes: Buffer): ComparisonImagick {
  return {
    compareAe: async (a, b, diffPath) => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(dirname(diffPath), { recursive: true });
      await writeFile(diffPath, diffBytes);
      // Use buffer hashes to derive a stable changed-pixel count for tests.
      const aBuf = readFileSync(a);
      const bBuf = readFileSync(b);
      const same = aBuf.equals(bBuf);
      return {
        aePixels: same ? 0 : 100,
        totalPixels: 10_000,
        changedPixelPercentage: same ? 0 : 1,
        diffImagePath: diffPath,
        width: 100,
        height: 100,
      };
    },
    compareSsim: async (a, b) => (readFileSync(a).equals(readFileSync(b)) ? 1 : 0.97),
    extractConnectedComponents: async () => ({
      format: 'json',
      raw: JSON.stringify([
        { id: 1, area: 80, geometry: '40x20+10+20', color: 'srgba(255,0,0,1)' },
      ]),
    }),
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  queue: JobQueue;
  storeDir: string;
  cleanup(): Promise<void>;
}

function makeStubLmClient(): LmClient {
  return {
    config: {
      baseURL: 'http://stub',
      apiKey: 'stub',
      model: 'stub-model',
      promptVersion: 'test',
      autoStart: false,
      autoLoad: false,
      preflightCacheSeconds: 0,
    },
    preflight: async () => ({
      ok: true,
      serverReachable: true,
      modelLoaded: true,
      configuredModel: 'stub-model',
      loadedModels: ['stub-model'],
      startedServer: false,
      loadedModel: false,
      durationMs: 0,
    }),
    invalidatePreflight: () => undefined,
    analyze: async () => ({
      parsed: {
        equivalent: false,
        confidence: 0.7,
        summary: 'stub LM verdict',
        differences: [],
      },
      rawText: '{}',
      path: 'json_schema',
      promptVersion: 'test',
      model: 'stub-model',
    }),
  };
}

async function makeHarness(): Promise<Harness> {
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-itest-'));
  const db = openDatabase({ path: ':memory:' });
  applySchema(db);
  const queue = new JobQueue(db);
  const artifactStore = createArtifactStore(storeDir);
  const captureWorker = makeStubCaptureWorker();
  const imagick = makeStubImagick(Buffer.from('STUB-DIFF-BYTES'));
  const lm = makeStubLmClient();
  const app = createApp({ db, queue, artifactStore, captureWorker, imagick, lm });
  return {
    app,
    queue,
    storeDir,
    cleanup: async () => {
      await rm(storeDir, { recursive: true, force: true });
      db.close();
    },
  };
}

describe('API integration', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('CSV upload → capture run → comparison run → detail', async () => {
    const csv = [
      'url_a,url_b,label',
      'https://a1.example.com,https://b1.example.com,Pair 1',
      'https://a2.example.com,https://b2.example.com,Pair 2',
    ].join('\n');

    const upload = await request(h.app)
      .post('/api/sessions')
      .field('name', 'integration')
      .attach('csv', Buffer.from(csv), 'pairs.csv');
    expect(upload.status).toBe(201);
    const sessionId = upload.body.session.id as string;
    expect(upload.body.url_pairs).toHaveLength(2);

    const captureStart = await request(h.app)
      .post('/api/capture-runs')
      .send({
        session_id: sessionId,
        options: {
          viewports: [
            { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, orientation: 'landscape' },
          ],
        },
      });
    expect(captureStart.status).toBe(202);
    const captureRunId = captureStart.body.capture_run_id as string;
    const captureJobId = captureStart.body.job_id as string;

    await h.queue.drain();

    const captureJob = await request(h.app).get(`/api/jobs/${captureJobId}`);
    expect(captureJob.body.job.status).toBe('complete');
    expect(captureJob.body.job.progress_current).toBe(captureJob.body.job.progress_total);

    const captureRun = await request(h.app).get(`/api/capture-runs/${captureRunId}`);
    expect(captureRun.body.captures).toHaveLength(4); // 2 pairs * 1 viewport * 2 sides
    for (const c of captureRun.body.captures) {
      expect(c.status).toBe('complete');
      expect(c.screenshot_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(c.screenshot_url).toMatch(/^\/images\/sha256\//);
    }

    const compStart = await request(h.app)
      .post('/api/comparison-runs')
      .send({
        session_id: sessionId,
        capture_run_id: captureRunId,
        options: { targetLevel: 'tolerant' },
      });
    expect(compStart.status).toBe(202);
    const compRunId = compStart.body.comparison_run_id as string;

    await h.queue.drain();

    const compRun = await request(h.app).get(`/api/comparison-runs/${compRunId}`);
    expect(compRun.body.comparisons).toHaveLength(2);
    for (const c of compRun.body.comparisons) {
      expect(c.status).toBe('complete');
      expect(c.changed_pixel_percentage).toBe(1);
      expect(c.ssim).toBe(0.97);
      expect(c.connected_component_count).toBe(1);
      // 1% pct + 0.97 SSIM → tolerant matches by pixel.
      expect(c.matched_at_level).toBe('tolerant');
      expect(c.matched_decided_by).toBe('pixel');
    }

    // Detail endpoint
    const firstId = compRun.body.comparisons[0].id as string;
    const detail = await request(h.app).get(`/api/comparisons/${firstId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.differences).toHaveLength(1);
    const box = detail.body.differences[0].bounding_box;
    expect(box).toMatchObject({ x: 10, y: 20, width: 40, height: 20 });

    // /images route serves the diff bytes by hash
    const diffHash = detail.body.comparison.im_diff_sha256 as string;
    const diffUrl = detail.body.comparison.im_diff_url as string;
    const expectedHash = createHash('sha256').update(Buffer.from('STUB-DIFF-BYTES')).digest('hex');
    expect(diffHash).toBe(expectedHash);
    const fetched = await request(h.app).get(diffUrl).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(fetched.status).toBe(200);
    expect((fetched.body as Buffer).equals(Buffer.from('STUB-DIFF-BYTES'))).toBe(true);

    // File should physically exist in the content-addressed tree.
    const dest = join(h.storeDir, 'sha256', diffHash.slice(0, 2), `${diffHash}.png`);
    await expect(stat(dest)).resolves.toBeTruthy();
  });

  it('rejects CSV upload when any row is invalid', async () => {
    const csv = 'url_a,url_b\nhttps://ok.example.com,not-a-url\n';
    const upload = await request(h.app)
      .post('/api/sessions')
      .attach('csv', Buffer.from(csv), 'bad.csv');
    expect(upload.status).toBe(400);
    expect(upload.body.error).toBe('invalid_csv');
    expect(upload.body.row_errors).toBeDefined();

    const list = await request(h.app).get('/api/sessions');
    expect(list.body.sessions).toHaveLength(0);
  });

  it('meta endpoints return viewports and equivalence levels', async () => {
    const vp = await request(h.app).get('/api/meta/viewports');
    expect(vp.status).toBe(200);
    expect(vp.body.viewports.length).toBeGreaterThan(0);
    const lv = await request(h.app).get('/api/meta/equivalence-levels');
    expect(lv.body.levels.find((l: { id: string }) => l.id === 'tolerant')).toBeTruthy();

    const si = await request(h.app).get('/api/meta/system-info');
    expect(si.status).toBe(200);
    expect(si.body.max_capture_concurrency).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(si.body.max_capture_concurrency)).toBe(true);
    expect(si.body.cpu_count).toBeGreaterThanOrEqual(1);
  });
});
