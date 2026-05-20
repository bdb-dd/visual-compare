import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import request from 'supertest';
import { openDatabase } from '../src/db/client.js';
import type { Db } from '../src/db/client.js';
import { applySchema } from '../src/db/schema.js';
import { JobQueue } from '../src/services/queue.js';
import { createArtifactStore } from '../src/services/artifact-store.js';
import type { CaptureWorker } from '../src/services/capture.js';
import type { ComparisonImagick } from '../src/services/comparison.js';
import type { LmClient } from '../src/services/lm.js';
import { createApp } from '../src/app.js';
import { Evaluator } from '../src/services/evaluator.js';
import {
  computeAcceptanceStatus,
  upsertAcceptance,
  getAcceptance,
  listAcceptances,
  deleteAcceptance,
} from '../src/services/acceptances.js';
import type {
  AcceptanceRow,
  BoundingBoxPercent,
  RegionMatchConfig,
  UrlPairRow,
  ViewportDef,
} from '../src/types.js';

const desktop: ViewportDef = {
  name: 'desktop',
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  orientation: 'landscape',
};

const knobs: RegionMatchConfig = {
  growth_margin_pct: 0.5,
  displacement_tolerance_pct: 1,
  pixel_pct_delta: 0.5,
};

const region = (
  x: number,
  y: number,
  width: number,
  height: number,
): BoundingBoxPercent => ({ x, y, width, height });

function stubCaptureWorker(): CaptureWorker {
  let counter = 0;
  return {
    capture: async (args) => {
      const dir = join(tmpdir(), 'vc-acc-test-captures');
      await mkdir(dir, { recursive: true });
      const path = join(dir, `cap-${counter++}.png`);
      await writeFile(path, Buffer.from(`STUB-${counter}\nurl=${args.url}\n`));
      return { tempPath: path, durationMs: 1, metadata: { stub: true } };
    },
    shutdown: async () => {},
  };
}

interface ImagickStubControl {
  changedPct: number;
  ssim: number;
  /** Connected-components geometry the imagick stub should report. */
  geometry: string;
}

function stubImagick(ctl: ImagickStubControl): ComparisonImagick {
  return {
    compareAe: async (_a, _b, diffPath) => {
      await mkdir(dirname(diffPath), { recursive: true });
      await writeFile(diffPath, Buffer.from(`STUB-DIFF-${ctl.changedPct}-${ctl.ssim}`));
      return {
        aePixels: Math.round(ctl.changedPct * 100),
        totalPixels: 10_000,
        changedPixelPercentage: ctl.changedPct,
        diffImagePath: diffPath,
        width: 100,
        height: 100,
      };
    },
    compareSsim: async () => ctl.ssim,
    extractConnectedComponents: async () => ({
      format: 'json',
      raw: JSON.stringify([
        { id: 1, area: 80, geometry: ctl.geometry, color: 'srgba(255,0,0,1)' },
      ]),
    }),
  };
}

function stubLm(): LmClient {
  return {
    config: {
      baseURL: 'http://stub',
      apiKey: 'stub',
      model: 'stub-model',
      promptVersion: 'env-fallback',
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
      parsed: { equivalent: false, confidence: 0.7, summary: 'stub', differences: [] },
      rawText: '{}',
      path: 'json_schema',
      promptVersion: 'env-fallback',
      model: 'stub-model',
    }),
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  db: Db;
  queue: JobQueue;
  evaluator: Evaluator;
  ctl: ImagickStubControl;
  cleanup: () => Promise<void>;
}

async function makeHarness(initial?: Partial<ImagickStubControl>): Promise<Harness> {
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-acc-itest-'));
  const db = openDatabase({ path: ':memory:' });
  applySchema(db);
  const queue = new JobQueue(db);
  const artifactStore = createArtifactStore(storeDir);
  const captureWorker = stubCaptureWorker();
  const ctl: ImagickStubControl = {
    changedPct: 1,
    ssim: 0.97,
    geometry: '40x20+10+20',
    ...initial,
  };
  const imagick = stubImagick(ctl);
  const lm = stubLm();
  const evaluator = new Evaluator({
    db,
    queue,
    artifactStore,
    worker: captureWorker,
    imagick,
    lm,
    pollIntervalMs: 10,
  });
  const app = createApp({ db, queue, artifactStore, captureWorker, imagick, lm, evaluator });
  return {
    app,
    db,
    queue,
    evaluator,
    ctl,
    cleanup: async () => {
      await rm(storeDir, { recursive: true, force: true });
      db.close();
    },
  };
}

const csv = ['url_a,url_b,label', 'https://a.test,https://b.test,P1'].join('\n');

async function uploadOnePair(h: Harness): Promise<{ sessionId: string; pair: UrlPairRow }> {
  const upload = await request(h.app)
    .post('/api/sessions')
    .field('name', 'acc-test')
    .attach('csv', Buffer.from(csv), 'p.csv');
  expect(upload.status).toBe(201);
  return {
    sessionId: upload.body.session.id as string,
    pair: upload.body.url_pairs[0] as UrlPairRow,
  };
}

async function settle(h: Harness): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await h.evaluator.drainAll();
    await h.queue.drain();
  }
}

// ---------------------------------------------------------------------------
// computeAcceptanceStatus (pure function)
// ---------------------------------------------------------------------------

describe('computeAcceptanceStatus', () => {
  const baseAcceptance: AcceptanceRow = {
    id: 'a1',
    session_id: 's1',
    url_pair_id: 'p1',
    viewport_name: 'desktop',
    accepted_level: 'tolerant',
    accepted_pixel_pct: 1.5,
    accepted_ssim: 0.97,
    accepted_diff_regions_json: JSON.stringify([region(10, 10, 20, 5)]),
    accepted_capture_a_sha: 'a',
    accepted_capture_b_sha: 'b',
    accept_any: 0,
    label: null,
    notes: null,
    created_at: '2026-05-06T00:00:00Z',
    updated_at: '2026-05-06T00:00:00Z',
  };

  it("'unaccepted' when no acceptance row exists", () => {
    const r = computeAcceptanceStatus({
      acceptance: null,
      current: { matched_at_level: 'tolerant', pixel_pct: 1, regions: [] },
      config: knobs,
    });
    expect(r).toBe('unaccepted');
  });

  it("'accepted' when accept_any=1 even if metrics regressed", () => {
    const r = computeAcceptanceStatus({
      acceptance: { ...baseAcceptance, accept_any: 1 },
      current: { matched_at_level: 'none', pixel_pct: 99, regions: [region(0, 0, 100, 100)] },
      config: knobs,
    });
    expect(r).toBe('accepted');
  });

  it("'regressed' when current matched_at_level is weaker than accepted_level", () => {
    const r = computeAcceptanceStatus({
      acceptance: baseAcceptance,
      current: { matched_at_level: 'loose', pixel_pct: 1, regions: [region(10, 10, 20, 5)] },
      config: knobs,
    });
    expect(r).toBe('regressed');
  });

  it("'accepted' when matched_at_level is stricter than accepted (improvement)", () => {
    const r = computeAcceptanceStatus({
      acceptance: baseAcceptance,
      current: { matched_at_level: 'strict', pixel_pct: 0.3, regions: [region(10, 10, 20, 5)] },
      config: knobs,
    });
    expect(r).toBe('accepted');
  });

  it("'expanded_diff' when pixel_pct exceeds the delta knob", () => {
    const r = computeAcceptanceStatus({
      acceptance: baseAcceptance,
      current: {
        matched_at_level: 'tolerant',
        pixel_pct: 2.5, // 1.5 + 0.5 = 2.0 boundary; 2.5 > 2.0 → expanded
        regions: [region(10, 10, 20, 5)],
      },
      config: knobs,
    });
    expect(r).toBe('expanded_diff');
  });

  it("'expanded_diff' when a new diff region appears outside accepted set", () => {
    const r = computeAcceptanceStatus({
      acceptance: baseAcceptance,
      current: {
        matched_at_level: 'tolerant',
        pixel_pct: 1,
        regions: [region(10, 10, 20, 5), region(60, 60, 5, 5)],
      },
      config: knobs,
    });
    expect(r).toBe('expanded_diff');
  });

  it("'accepted' when within all knobs", () => {
    const r = computeAcceptanceStatus({
      acceptance: baseAcceptance,
      current: {
        matched_at_level: 'tolerant',
        pixel_pct: 1.6, // within 0.5 of 1.5
        regions: [region(10.2, 10.1, 20.3, 5.1)], // within margin + tolerance
      },
      config: knobs,
    });
    expect(r).toBe('accepted');
  });
});

// ---------------------------------------------------------------------------
// CRUD service
// ---------------------------------------------------------------------------

describe('acceptances CRUD', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('upsert creates a new acceptance and returns it', async () => {
    const { sessionId, pair } = await uploadOnePair(h);
    const acc = upsertAcceptance(h.db, sessionId, {
      url_pair_id: pair.id,
      viewport_name: 'desktop',
      accepted_level: 'tolerant',
      accepted_pixel_pct: 1,
      accepted_ssim: 0.97,
      accepted_diff_regions: [region(10, 10, 20, 5)],
      accepted_capture_a_sha: 'sha-a',
      accepted_capture_b_sha: 'sha-b',
      accept_any: false,
      label: 'cookie-banner',
      notes: null,
    });
    expect(acc.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(acc.label).toBe('cookie-banner');
    expect(getAcceptance(h.db, sessionId, pair.id, 'desktop')!.id).toBe(acc.id);
  });

  it('upsert with same (session, pair, viewport) updates in place', async () => {
    const { sessionId, pair } = await uploadOnePair(h);
    const first = upsertAcceptance(h.db, sessionId, {
      url_pair_id: pair.id,
      viewport_name: 'desktop',
      accepted_level: 'tolerant',
      accepted_diff_regions: [],
      accepted_capture_a_sha: 'a',
      accepted_capture_b_sha: 'b',
      accept_any: false,
    });
    const second = upsertAcceptance(h.db, sessionId, {
      url_pair_id: pair.id,
      viewport_name: 'desktop',
      accepted_level: 'strict',
      accepted_diff_regions: [],
      accepted_capture_a_sha: 'a',
      accepted_capture_b_sha: 'b',
      accept_any: false,
      label: 'updated',
    });
    expect(second.id).toBe(first.id); // same row
    expect(second.accepted_level).toBe('strict');
    expect(second.label).toBe('updated');
    expect(listAcceptances(h.db, sessionId)).toHaveLength(1);
  });

  it('list returns rows in stable order; delete removes by id', async () => {
    const { sessionId, pair } = await uploadOnePair(h);
    const acc = upsertAcceptance(h.db, sessionId, {
      url_pair_id: pair.id,
      viewport_name: 'desktop',
      accepted_level: 'tolerant',
      accepted_diff_regions: [],
      accepted_capture_a_sha: 'a',
      accepted_capture_b_sha: 'b',
      accept_any: false,
    });
    expect(listAcceptances(h.db, sessionId)).toHaveLength(1);
    expect(deleteAcceptance(h.db, sessionId, acc.id)).toBe(true);
    expect(listAcceptances(h.db, sessionId)).toHaveLength(0);
    // Deleting again is a no-op (returns false).
    expect(deleteAcceptance(h.db, sessionId, acc.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

describe('acceptance routes', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('GET /api/sessions/:id/acceptances returns []', async () => {
    const { sessionId } = await uploadOnePair(h);
    const res = await request(h.app).get(`/api/sessions/${sessionId}/acceptances`);
    expect(res.status).toBe(200);
    expect(res.body.acceptances).toEqual([]);
  });

  it('POST creates and 201s; second POST upserts', async () => {
    const { sessionId, pair } = await uploadOnePair(h);
    const body = {
      url_pair_id: pair.id,
      viewport_name: 'desktop',
      accepted_level: 'tolerant',
      accepted_diff_regions: [region(10, 10, 20, 5)],
      accepted_capture_a_sha: 'a',
      accepted_capture_b_sha: 'b',
    };
    const first = await request(h.app)
      .post(`/api/sessions/${sessionId}/acceptances`)
      .send(body);
    expect(first.status).toBe(201);
    expect(first.body.acceptance.accepted_level).toBe('tolerant');

    const second = await request(h.app)
      .post(`/api/sessions/${sessionId}/acceptances`)
      .send({ ...body, accepted_level: 'strict' });
    expect(second.status).toBe(201);
    expect(second.body.acceptance.id).toBe(first.body.acceptance.id);
    expect(second.body.acceptance.accepted_level).toBe('strict');
  });

  it('POST 400s on malformed body', async () => {
    const { sessionId } = await uploadOnePair(h);
    const res = await request(h.app)
      .post(`/api/sessions/${sessionId}/acceptances`)
      .send({ accepted_level: 'nonsense' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_acceptance');
  });

  it('DELETE removes; second DELETE 404s', async () => {
    const { sessionId, pair } = await uploadOnePair(h);
    const created = await request(h.app)
      .post(`/api/sessions/${sessionId}/acceptances`)
      .send({
        url_pair_id: pair.id,
        viewport_name: 'desktop',
        accepted_level: 'tolerant',
        accepted_diff_regions: [],
        accepted_capture_a_sha: 'a',
        accepted_capture_b_sha: 'b',
      });
    const id = created.body.acceptance.id as string;
    const del1 = await request(h.app).delete(
      `/api/sessions/${sessionId}/acceptances/${id}`,
    );
    expect(del1.status).toBe(204);
    const del2 = await request(h.app).delete(
      `/api/sessions/${sessionId}/acceptances/${id}`,
    );
    expect(del2.status).toBe(404);
  });

  it('returns 404 for unknown session', async () => {
    const res = await request(h.app).get('/api/sessions/missing/acceptances');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Integration: acceptance_status reflected in /results
// ---------------------------------------------------------------------------

describe('acceptance_status in /results', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.cleanup();
  });

  it('moves a row from accepted → expanded_diff when the diff grows', async () => {
    h = await makeHarness();
    const { sessionId, pair } = await uploadOnePair(h);

    // 1. Run an evaluation so pixel cache and differences populate.
    h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'tolerant',
    });
    await settle(h);

    // 2. Snapshot the current state and accept it.
    const results1 = await request(h.app).get(`/api/sessions/${sessionId}/results`);
    const r1 = results1.body.results[0];
    expect(r1.matched_at_level).toBe('tolerant');
    expect(r1.acceptance_status).toBe('unaccepted');

    const region1 = r1.pixel.bbox_area_pct;
    expect(region1).toBeGreaterThan(0);

    await request(h.app)
      .post(`/api/sessions/${sessionId}/acceptances`)
      .send({
        url_pair_id: pair.id,
        viewport_name: 'desktop',
        accepted_level: r1.matched_at_level,
        accepted_pixel_pct: r1.pixel.changed_pct,
        accepted_ssim: r1.pixel.ssim,
        // Pull the actual region geometry by querying differences.
        accepted_diff_regions: imagickRegionsFor(h.db, r1.comparison_id),
        accepted_capture_a_sha: r1.capture_a_sha,
        accepted_capture_b_sha: r1.capture_b_sha,
      });

    const results2 = await request(h.app).get(`/api/sessions/${sessionId}/results`);
    expect(results2.body.results[0].acceptance_status).toBe('accepted');

    // 3. Force a re-evaluation with bigger pixel change. Bump the imagick
    //    stub's reported pct beyond the pixel_pct_delta knob and invalidate
    //    captures so a fresh comparison is produced.
    h.ctl.changedPct = 4; // accepted was 1; delta knob is 0.5 → expanded
    await request(h.app)
      .post(`/api/sessions/${sessionId}/recapture`)
      .send({});
    await settle(h);
    h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'tolerant',
    });
    await settle(h);

    const results3 = await request(h.app).get(`/api/sessions/${sessionId}/results`);
    expect(results3.body.results[0].acceptance_status).toBe('expanded_diff');
  });

  it("accept_any keeps status='accepted' even when the diff explodes", async () => {
    h = await makeHarness();
    const { sessionId, pair } = await uploadOnePair(h);
    h.evaluator.start(sessionId, { viewports: [desktop], target_level: 'tolerant' });
    await settle(h);

    await request(h.app)
      .post(`/api/sessions/${sessionId}/acceptances`)
      .send({
        url_pair_id: pair.id,
        viewport_name: 'desktop',
        accepted_level: 'tolerant',
        accepted_diff_regions: [],
        accepted_capture_a_sha: 'a',
        accepted_capture_b_sha: 'b',
        accept_any: true,
      });

    // Force a regression: pct way up, level drops to none.
    h.ctl.changedPct = 90;
    h.ctl.ssim = 0.1;
    await request(h.app)
      .post(`/api/sessions/${sessionId}/recapture`)
      .send({});
    await settle(h);
    h.evaluator.start(sessionId, { viewports: [desktop], target_level: 'tolerant' });
    await settle(h);

    const results = await request(h.app).get(`/api/sessions/${sessionId}/results`);
    expect(results.body.results[0].matched_at_level).toBe('none');
    expect(results.body.results[0].acceptance_status).toBe('accepted');
  });
});

function imagickRegionsFor(db: Db, comparisonId: string): BoundingBoxPercent[] {
  const rows = db
    .prepare<[string], { bounding_box_json: string }>(
      `SELECT bounding_box_json FROM differences
        WHERE comparison_id = ? AND source = 'imagick' AND bounding_box_json IS NOT NULL`,
    )
    .all(comparisonId);
  return rows.map((r) => JSON.parse(r.bounding_box_json) as BoundingBoxPercent);
}
