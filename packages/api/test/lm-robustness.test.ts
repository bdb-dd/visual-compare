import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import { applySchema } from '../src/db/schema.js';
import { JobQueue } from '../src/services/queue.js';
import { createArtifactStore } from '../src/services/artifact-store.js';
import { createLmClient, type LmClient, type LmConfig } from '../src/services/lm.js';
import { createLmsCli, type LmsCli, type LmsCliResult, type Spawner } from '../src/services/lms-cli.js';
import type { CaptureWorker } from '../src/services/capture.js';
import type { ComparisonImagick } from '../src/services/comparison.js';
import request from 'supertest';

// ---------------------------------------------------------------------------
// lms-cli wrapper (Spawner abstraction)
// ---------------------------------------------------------------------------

function recordingSpawner(scripts: Record<string, () => Promise<LmsCliResult>>): {
  spawner: Spawner;
  calls: { args: string[] }[];
} {
  const calls: { args: string[] }[] = [];
  const spawner: Spawner = async (_bin, args) => {
    calls.push({ args: [...args] });
    const key = args.join(' ');
    const fn = scripts[key];
    if (!fn) {
      return { ok: false, exitCode: 127, stdout: '', stderr: `unscripted: ${key}`, durationMs: 0 };
    }
    return fn();
  };
  return { spawner, calls };
}

const okResult = (stdout = ''): LmsCliResult => ({ ok: true, exitCode: 0, stdout, stderr: '', durationMs: 1 });
const failResult = (msg = 'boom'): LmsCliResult => ({
  ok: false,
  exitCode: 1,
  stdout: '',
  stderr: msg,
  durationMs: 1,
});

describe('lms-cli', () => {
  it('routes serverStart, load, and ps to the spawner', async () => {
    const { spawner, calls } = recordingSpawner({
      'server start': async () => okResult('Success'),
      'load some/model': async () => okResult('Loaded'),
      ps: async () => okResult('No models loaded'),
    });
    const cli = createLmsCli({ bin: 'lms', timeoutMs: 1000 }, spawner);
    expect((await cli.serverStart()).ok).toBe(true);
    expect((await cli.load('some/model')).ok).toBe(true);
    expect((await cli.ps()).ok).toBe(true);
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      'server start',
      'load some/model',
      'ps',
    ]);
  });

  it('surfaces non-zero exit codes as ok=false but does not throw', async () => {
    const { spawner } = recordingSpawner({
      'server start': async () => failResult('cannot bind port'),
    });
    const cli = createLmsCli({ bin: 'lms', timeoutMs: 1000 }, spawner);
    const result = await cli.serverStart();
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/cannot bind port/);
  });
});

// ---------------------------------------------------------------------------
// Preflight + auto-recovery
// ---------------------------------------------------------------------------

interface FakeLmServerOptions {
  reachable?: boolean;
  loadedModels?: string[];
}

function fakeFetch(state: FakeLmServerOptions): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.endsWith('/v1/models')) throw new Error(`unexpected fetch: ${url}`);
    if (state.reachable === false) {
      throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    }
    return new Response(
      JSON.stringify({ data: (state.loadedModels ?? []).map((id) => ({ id })) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

function withFetch<T>(fakeF: typeof fetch, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fakeF;
  return body().finally(() => {
    globalThis.fetch = original;
  });
}

function makeConfig(overrides: Partial<LmConfig> = {}): LmConfig {
  return {
    baseURL: 'http://localhost:1234/v1',
    apiKey: 'lm-studio',
    model: 'test-model',
    promptVersion: 'v1',
    maxTokens: 256,
    temperature: 0.1,
    timeoutSeconds: 5,
    autoStart: true,
    autoLoad: true,
    preflightCacheSeconds: 30,
    ...overrides,
  };
}

function fakeCli(scripts: { serverStart?: () => Promise<LmsCliResult>; load?: () => Promise<LmsCliResult> } = {}): LmsCli {
  return {
    serverStart: scripts.serverStart ?? (async () => okResult()),
    load: scripts.load ?? (async () => okResult()),
    ps: async () => okResult(),
  };
}

describe('LmClient preflight', () => {
  it('returns ok when server is up and model is loaded (no recovery)', async () => {
    const fakeF = fakeFetch({ reachable: true, loadedModels: ['test-model'] });
    let serverStartCalls = 0;
    let loadCalls = 0;
    const cli = fakeCli({
      serverStart: async () => { serverStartCalls++; return okResult(); },
      load: async () => { loadCalls++; return okResult(); },
    });
    const client = createLmClient(makeConfig(), cli);
    await withFetch(fakeF, async () => {
      const pf = await client.preflight();
      expect(pf.ok).toBe(true);
      if (pf.ok) {
        expect(pf.startedServer).toBe(false);
        expect(pf.loadedModel).toBe(false);
      }
    });
    expect(serverStartCalls).toBe(0);
    expect(loadCalls).toBe(0);
  });

  it('auto-starts the server when /v1/models is unreachable, then succeeds', async () => {
    const state: FakeLmServerOptions = { reachable: false, loadedModels: [] };
    const fakeF = fakeFetch(state);
    let serverStartCalls = 0;
    const cli = fakeCli({
      serverStart: async () => {
        serverStartCalls++;
        // On first call, "boot" the fake server.
        state.reachable = true;
        state.loadedModels = ['test-model'];
        return okResult();
      },
    });
    const client = createLmClient(makeConfig(), cli);
    await withFetch(fakeF, async () => {
      const pf = await client.preflight();
      expect(pf.ok).toBe(true);
      if (pf.ok) {
        expect(pf.startedServer).toBe(true);
        expect(pf.loadedModel).toBe(false);
      }
    });
    expect(serverStartCalls).toBe(1);
  });

  it('reports auto_start_failed when lms server start returns non-zero', async () => {
    const fakeF = fakeFetch({ reachable: false });
    const cli = fakeCli({
      serverStart: async () => failResult('Address already in use'),
    });
    const client = createLmClient(makeConfig(), cli);
    await withFetch(fakeF, async () => {
      const pf = await client.preflight();
      expect(pf.ok).toBe(false);
      if (!pf.ok) {
        expect(pf.reason).toBe('auto_start_failed');
        expect(pf.message).toMatch(/Address already in use/);
      }
    });
  });

  it('auto-loads the configured model when missing, then succeeds', async () => {
    const state: FakeLmServerOptions = { reachable: true, loadedModels: ['other-model'] };
    const fakeF = fakeFetch(state);
    let loadCalls = 0;
    const cli = fakeCli({
      load: async () => {
        loadCalls++;
        state.loadedModels = ['other-model', 'test-model'];
        return okResult();
      },
    });
    const client = createLmClient(makeConfig(), cli);
    await withFetch(fakeF, async () => {
      const pf = await client.preflight();
      expect(pf.ok).toBe(true);
      if (pf.ok) {
        expect(pf.startedServer).toBe(false);
        expect(pf.loadedModel).toBe(true);
        expect(pf.loadedModels).toContain('test-model');
      }
    });
    expect(loadCalls).toBe(1);
  });

  it('reports model_not_loaded when autoLoad is disabled and the model is missing', async () => {
    const fakeF = fakeFetch({ reachable: true, loadedModels: [] });
    const client = createLmClient(makeConfig({ autoLoad: false }), fakeCli());
    await withFetch(fakeF, async () => {
      const pf = await client.preflight();
      expect(pf.ok).toBe(false);
      if (!pf.ok) {
        expect(pf.reason).toBe('model_not_loaded');
      }
    });
  });

  it('caches successful preflight results until force or invalidation', async () => {
    let pings = 0;
    const fakeF: typeof fetch = (async (url: string | URL | Request) => {
      void url;
      pings++;
      return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = createLmClient(makeConfig({ preflightCacheSeconds: 60 }), fakeCli());
    await withFetch(fakeF, async () => {
      await client.preflight();
      await client.preflight();
      await client.preflight();
      expect(pings).toBe(1);
      // Force bypasses cache.
      await client.preflight({ force: true });
      expect(pings).toBe(2);
      // Invalidation also bypasses.
      client.invalidatePreflight();
      await client.preflight();
      expect(pings).toBe(3);
    });
  });
});

// ---------------------------------------------------------------------------
// Comparison-run start: route gates LM-able levels behind preflight
// ---------------------------------------------------------------------------

describe('comparison-run preflight gate', () => {
  let storeDir: string;
  let db: ReturnType<typeof openDatabase>;
  let activeQueue: JobQueue | null;
  beforeEach(async () => {
    storeDir = await mkdtemp(join(tmpdir(), 'vc-pf-'));
    db = openDatabase({ path: ':memory:' });
    applySchema(db);
    activeQueue = null;
  });
  afterEach(async () => {
    if (activeQueue) await activeQueue.drain();
    db.close();
    await rm(storeDir, { recursive: true, force: true });
  });

  function makeApp(lm: LmClient | undefined) {
    const queue = new JobQueue(db);
    activeQueue = queue;
    const artifactStore = createArtifactStore(storeDir);
    const captureWorker: CaptureWorker = {
      capture: async () => ({ tempPath: '/tmp/never', durationMs: 0 }),
      shutdown: async () => undefined,
    };
    const imagick: ComparisonImagick = {
      compareAe: async () => ({ aePixels: 0, totalPixels: 1, changedPixelPercentage: 0, diffImagePath: '/tmp/x', width: 1, height: 1 }),
      compareSsim: async () => 1,
      extractConnectedComponents: async () => ({ format: 'json', raw: '[]' }),
    };
    return createApp({ db, queue, artifactStore, captureWorker, imagick, lm });
  }

  function seedSessionAndCaptureRun() {
    const sessionId = 's1';
    const pairId = 'p1';
    const captureRunId = 'cr1';
    const jobId = 'j1';
    const aId = 'capA';
    const bId = 'capB';
    const now = new Date().toISOString();
    db.prepare('INSERT INTO sessions (id,name,csv_filename,created_at) VALUES (?,?,?,?)').run(sessionId,'s','s.csv',now);
    db.prepare('INSERT INTO url_pairs (id,session_id,url_a,url_b,label,row_index,raw_row_json,created_at) VALUES (?,?,?,?,NULL,0,?,?)')
      .run(pairId, sessionId, 'https://a','https://b','{}',now);
    db.prepare('INSERT INTO jobs (id,type,status,progress_current,progress_total,created_at) VALUES (?,?,?,0,0,?)')
      .run(jobId,'capture','complete',now);
    db.prepare('INSERT INTO capture_runs (id,session_id,job_id,options_json,created_at) VALUES (?,?,?,?,?)')
      .run(captureRunId, sessionId, jobId, '{}', now);
    const ins = db.prepare(
      `INSERT INTO captures (id,capture_run_id,url_pair_id,side,url,status,screenshot_sha256,screenshot_byte_size,viewport_name,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    ins.run(aId, captureRunId, pairId, 'a','https://a','complete','a'.repeat(64), 1, 'desktop', now);
    ins.run(bId, captureRunId, pairId, 'b','https://b','complete','b'.repeat(64), 1, 'desktop', now);
    return { sessionId, captureRunId };
  }

  it('returns 503 when invokeLm is requested and no lm client is configured', async () => {
    const app = makeApp(undefined);
    const { sessionId, captureRunId } = seedSessionAndCaptureRun();
    const r = await request(app).post('/api/comparison-runs').send({
      session_id: sessionId,
      capture_run_id: captureRunId,
      options: { targetLevel: 'tolerant', invokeLm: true },
    });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('lm_unavailable');
  });

  it('returns 503 when preflight fails (server unreachable, autoStart disabled)', async () => {
    const cli = fakeCli();
    const lm = createLmClient(makeConfig({ autoStart: false }), cli);
    const fakeF = fakeFetch({ reachable: false });
    const app = makeApp(lm);
    const { sessionId, captureRunId } = seedSessionAndCaptureRun();
    await withFetch(fakeF, async () => {
      const r = await request(app).post('/api/comparison-runs').send({
        session_id: sessionId,
        capture_run_id: captureRunId,
        options: { targetLevel: 'tolerant', invokeLm: true },
      });
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('lm_unavailable');
      expect(r.body.reason).toBe('server_unreachable');
    });
  });

  it('accepts pixel-perfect runs without preflight (band=0, no invokeLm)', async () => {
    const app = makeApp(undefined); // no LM at all
    const { sessionId, captureRunId } = seedSessionAndCaptureRun();
    const r = await request(app).post('/api/comparison-runs').send({
      session_id: sessionId,
      capture_run_id: captureRunId,
      options: { targetLevel: 'pixel-perfect' },
    });
    expect(r.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// /api/meta/lm-status endpoint
// ---------------------------------------------------------------------------

describe('GET /api/meta/lm-status', () => {
  it('reports configured=false when no LM client is wired', async () => {
    const storeDir = await mkdtemp(join(tmpdir(), 'vc-st-'));
    const db = openDatabase({ path: ':memory:' });
    applySchema(db);
    try {
      const queue = new JobQueue(db);
      const artifactStore = createArtifactStore(storeDir);
      const captureWorker: CaptureWorker = {
        capture: async () => ({ tempPath: '', durationMs: 0 }),
        shutdown: async () => undefined,
      };
      const app = createApp({ db, queue, artifactStore, captureWorker });
      const r = await request(app).get('/api/meta/lm-status');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: false, configured: false });
    } finally {
      db.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  it('reports ok when preflight succeeds', async () => {
    const fakeF = fakeFetch({ reachable: true, loadedModels: ['test-model'] });
    const lm = createLmClient(makeConfig(), fakeCli());
    const storeDir = await mkdtemp(join(tmpdir(), 'vc-st2-'));
    const db = openDatabase({ path: ':memory:' });
    applySchema(db);
    try {
      const queue = new JobQueue(db);
      const artifactStore = createArtifactStore(storeDir);
      const captureWorker: CaptureWorker = {
        capture: async () => ({ tempPath: '', durationMs: 0 }),
        shutdown: async () => undefined,
      };
      const app = createApp({ db, queue, artifactStore, captureWorker, lm });
      await withFetch(fakeF, async () => {
        const r = await request(app).get('/api/meta/lm-status');
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({
          ok: true,
          configured: true,
          server_reachable: true,
          model_loaded: true,
          configured_model: 'test-model',
        });
      });
    } finally {
      db.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Per-run circuit breaker
// ---------------------------------------------------------------------------

describe('per-run circuit breaker', () => {
  it('short-circuits remaining LM-required comparisons after 2 failures', async () => {
    const storeDir = await mkdtemp(join(tmpdir(), 'vc-cb-'));
    const db = openDatabase({ path: ':memory:' });
    applySchema(db);
    try {
      const queue = new JobQueue(db);
      const artifactStore = createArtifactStore(storeDir);

      // Stub capture worker that writes deterministic bytes.
      let counter = 0;
      const captureWorker: CaptureWorker = {
        capture: async () => {
          const path = join(storeDir, `tmp-${counter++}.png`);
          await writeFile(path, Buffer.from(`STUB-${counter}`));
          return { tempPath: path, durationMs: 0 };
        },
        shutdown: async () => undefined,
      };
      // Imagick stub — make every pair "different enough" that semantic runs work.
      const imagick: ComparisonImagick = {
        compareAe: async (_a, _b, diffPath) => {
          await writeFile(diffPath, Buffer.from('STUB-DIFF'));
          return { aePixels: 100, totalPixels: 10000, changedPixelPercentage: 1, diffImagePath: diffPath, width: 100, height: 100 };
        },
        compareSsim: async () => 0.9,
        extractConnectedComponents: async () => ({ format: 'json', raw: '[]' }),
      };

      // LM client that always fails to analyze.
      let analyzeCalls = 0;
      const lm: LmClient = {
        config: makeConfig(),
        preflight: async () => ({
          ok: true,
          serverReachable: true,
          modelLoaded: true,
          configuredModel: 'stub',
          loadedModels: ['stub'],
          startedServer: false,
          loadedModel: false,
          durationMs: 0,
        }),
        invalidatePreflight: () => undefined,
        analyze: async () => {
          analyzeCalls++;
          return {
            parsed: null,
            rawText: null,
            message: 'simulated LM failure',
            promptVersion: 'test',
            model: 'stub',
          };
        },
      };

      const app = createApp({ db, queue, artifactStore, captureWorker, imagick, lm });

      // 1. Upload CSV with 4 pairs.
      const csv = ['url_a,url_b']
        .concat(Array.from({ length: 4 }, (_, i) => `https://a${i}.com,https://b${i}.com`))
        .join('\n');
      const upload = await request(app).post('/api/sessions').attach('csv', Buffer.from(csv), 'pairs.csv');
      expect(upload.status).toBe(201);
      const sessionId = upload.body.session.id as string;

      // 2. Start a capture run for one viewport.
      const cap = await request(app).post('/api/capture-runs').send({
        session_id: sessionId,
        options: {
          viewports: [{ name: 'desktop', width: 100, height: 100, deviceScaleFactor: 1, orientation: 'landscape' }],
        },
      });
      expect(cap.status).toBe(202);
      await queue.drain();

      // 3. Start a comparison run with invokeLm=true on a strict target —
      //    every comparison should attempt LM (target_level_failure) and fail.
      const comp = await request(app).post('/api/comparison-runs').send({
        session_id: sessionId,
        capture_run_id: cap.body.capture_run_id,
        options: { targetLevel: 'strict', invokeLm: true },
      });
      expect(comp.status).toBe(202);
      await queue.drain();

      const result = await request(app).get(`/api/comparison-runs/${comp.body.comparison_run_id}`);
      const rows = result.body.comparisons as Array<{
        status: string;
        matched_at_level: string | null;
        matched_decided_by: string | null;
        lm_invocation_reason: string | null;
        lm_determined_equivalent: number | null;
        error_message: string | null;
        changed_pixel_percentage: number | null;
        ssim: number | null;
      }>;
      // Per the IM/LM persistence split: LM failures no longer poison the
      // row. All 4 are 'complete' with the IM verdict; lm_determined_
      // equivalent is null because LM never produced a decision. The
      // breaker is still asserted via analyzeCalls (only 2 LM calls fired
      // before the circuit opened and short-circuited the rest).
      expect(rows.filter((c) => c.status === 'complete')).toHaveLength(4);
      expect(rows.filter((c) => c.status === 'error')).toHaveLength(0);
      expect(analyzeCalls).toBe(2);
      // Every row carries the IM verdict (matched_decided_by='pixel'), with
      // lm_invocation_reason recording that an LM call was attempted but
      // produced no verdict.
      for (const r of rows) {
        expect(r.matched_decided_by).toBe('pixel');
        expect(r.lm_invocation_reason).toBe('target_level_failure');
        expect(r.lm_determined_equivalent).toBeNull();
        expect(r.changed_pixel_percentage).not.toBeNull();
        expect(r.ssim).not.toBeNull();
      }
      // The split-persistence contract also requires that pixel_compare_cache
      // got populated for all 4 — otherwise a re-eval after fixing LM would
      // wastefully re-run the IM pipeline. lm_verdict_cache stays empty
      // because no LM verdict was produced.
      const pixelCacheCount = db
        .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM pixel_compare_cache`)
        .get();
      expect(pixelCacheCount?.n).toBe(4);
      const lmCacheCount = db
        .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM lm_verdict_cache`)
        .get();
      expect(lmCacheCount?.n).toBe(0);
    } finally {
      db.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});
