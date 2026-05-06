import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import request from 'supertest';
import { openDatabase } from '../src/db/client.js';
import type { Db } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';
import { JobQueue } from '../src/services/queue.js';
import { createArtifactStore } from '../src/services/artifact-store.js';
import type { CaptureWorker } from '../src/services/capture.js';
import type { ComparisonImagick } from '../src/services/comparison.js';
import type { LmClient } from '../src/services/lm.js';
import { createApp } from '../src/app.js';
import { Evaluator } from '../src/services/evaluator.js';
import {
  applyFilter,
  isAllowListed,
  resolveEvaluationConfig,
} from '../src/services/evaluator.js';
import type { ViewportDef, UrlPairRow } from '../src/types.js';

const desktop: ViewportDef = {
  name: 'desktop',
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  orientation: 'landscape',
};

function stubCaptureWorker(): CaptureWorker {
  let counter = 0;
  return {
    capture: async (args) => {
      const dir = join(tmpdir(), 'vc-cfg-test-captures');
      await mkdir(dir, { recursive: true });
      const path = join(dir, `cap-${counter++}.png`);
      await writeFile(
        path,
        Buffer.from(`STUB\nurl=${args.url}\nvw=${args.viewport.name}\n`),
      );
      return { tempPath: path, durationMs: 1, metadata: { stub: true } };
    },
    shutdown: async () => {},
  };
}

function stubImagick(): ComparisonImagick {
  return {
    compareAe: async (_a, _b, diffPath) => {
      await mkdir(dirname(diffPath), { recursive: true });
      await writeFile(diffPath, Buffer.from('STUB-DIFF'));
      return {
        aePixels: 100,
        totalPixels: 10_000,
        changedPixelPercentage: 1,
        diffImagePath: diffPath,
        width: 100,
        height: 100,
      };
    },
    compareSsim: async () => 0.97,
    extractConnectedComponents: async () => ({
      format: 'json',
      raw: JSON.stringify([
        { id: 1, area: 80, geometry: '40x20+10+20', color: 'srgba(255,0,0,1)' },
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
      promptVersion: 'test-prompt',
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
      promptVersion: 'test-prompt',
      model: 'stub-model',
    }),
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  db: Db;
  queue: JobQueue;
  evaluator: Evaluator;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-cfg-itest-'));
  const db = openDatabase({ path: ':memory:' });
  runMigrations(db);
  const queue = new JobQueue(db);
  const artifactStore = createArtifactStore(storeDir);
  const captureWorker = stubCaptureWorker();
  const imagick = stubImagick();
  const lm = stubLm();
  const evaluator = new Evaluator({
    db,
    queue,
    artifactStore,
    worker: captureWorker,
    imagick,
    lm,
  });
  const app = createApp({ db, queue, artifactStore, captureWorker, imagick, lm, evaluator });
  return {
    app,
    db,
    queue,
    evaluator,
    cleanup: async () => {
      await rm(storeDir, { recursive: true, force: true });
      db.close();
    },
  };
}

const altinnCsv = [
  'url_a,url_b,label,language,category,subcategory,path',
  'https://a1.test,https://b1.test,EN home,en,top,,/en/',
  'https://a2.test,https://b2.test,EN about,en,about-altinn,accessibility,/en/about-altinn/accessibility/',
  'https://a3.test,https://b3.test,NO home,no,starte-og-drive,,/starte-og-drive/',
  'https://a4.test,https://b4.test,NO regnskap,no,starte-og-drive,regnskap,/starte-og-drive/regnskap/',
].join('\n');

async function uploadAltinnSession(app: Harness['app']): Promise<string> {
  const upload = await request(app)
    .post('/api/sessions')
    .field('name', 'altinn-test')
    .attach('csv', Buffer.from(altinnCsv), 'altinn.csv');
  expect(upload.status).toBe(201);
  return upload.body.session.id as string;
}

async function settle(h: Harness): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await h.evaluator.drainAll();
    await h.queue.drain();
  }
}

describe('CSV metadata extraction', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('promotes language/category/subcategory/path from CSV columns', async () => {
    const sessionId = await uploadAltinnSession(h.app);
    const detail = await request(h.app).get(`/api/sessions/${sessionId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.url_pairs).toHaveLength(4);
    const noRegnskap = detail.body.url_pairs.find((p: UrlPairRow) => p.label === 'NO regnskap');
    expect(noRegnskap).toMatchObject({
      language: 'no',
      category: 'starte-og-drive',
      subcategory: 'regnskap',
      path: '/starte-og-drive/regnskap/',
    });
    const enHome = detail.body.url_pairs.find((p: UrlPairRow) => p.label === 'EN home');
    expect(enHome.subcategory).toBeNull();
  });

  it('returns the freshly-loaded SessionConfig (empty defaults) on creation', async () => {
    const sessionId = await uploadAltinnSession(h.app);
    const detail = await request(h.app).get(`/api/sessions/${sessionId}`);
    expect(detail.body.config).toEqual({
      default_viewports: [],
      default_capture_options: {},
      default_equivalence_levels: [],
      filter_query: {},
      allow_list: [],
    });
  });
});

describe('applyFilter', () => {
  const pairs: UrlPairRow[] = [
    {
      id: '1',
      session_id: 's',
      url_a: 'a1',
      url_b: 'b1',
      label: null,
      row_index: 0,
      raw_row_json: null,
      language: 'en',
      category: 'top',
      subcategory: null,
      path: '/en/',
      disabled: 0,
      created_at: '',
    },
    {
      id: '2',
      session_id: 's',
      url_a: 'a2',
      url_b: 'b2',
      label: null,
      row_index: 1,
      raw_row_json: null,
      language: 'no',
      category: 'starte-og-drive',
      subcategory: 'regnskap',
      path: '/starte-og-drive/regnskap/',
      disabled: 0,
      created_at: '',
    },
    {
      id: '3',
      session_id: 's',
      url_a: 'a3',
      url_b: 'b3',
      label: null,
      row_index: 2,
      raw_row_json: null,
      language: 'no',
      category: 'hjelp',
      subcategory: null,
      path: '/hjelp/',
      disabled: 0,
      created_at: '',
    },
  ];

  it('empty filter returns everything', () => {
    expect(applyFilter(pairs, {})).toHaveLength(3);
  });

  it('filters by language', () => {
    expect(applyFilter(pairs, { language: ['no'] }).map((p) => p.id)).toEqual(['2', '3']);
  });

  it('filters by category list', () => {
    expect(
      applyFilter(pairs, { category: ['starte-og-drive', 'hjelp'] }).map((p) => p.id),
    ).toEqual(['2', '3']);
  });

  it('filters by subcategory and excludes nulls', () => {
    expect(applyFilter(pairs, { subcategory: ['regnskap'] }).map((p) => p.id)).toEqual(['2']);
  });

  it('filters by path_prefix', () => {
    expect(applyFilter(pairs, { path_prefix: '/starte-og-drive' }).map((p) => p.id)).toEqual(['2']);
  });

  it('combines multiple facets with AND', () => {
    expect(
      applyFilter(pairs, {
        language: ['no'],
        path_prefix: '/hjelp',
      }).map((p) => p.id),
    ).toEqual(['3']);
  });

  it('falls back to the URL pathname when path column is null', () => {
    // CSVs without an explicit `path` column leave it null; users still
    // expect path_prefix to filter against the URL itself. Mirrors the
    // test-corpus shape (http://host:port/fixtures/<slug>/...).
    const corpus: UrlPairRow[] = [
      { ...pairs[0]!, id: 'cp', url_a: 'http://localhost:5173/fixtures/cp-lazy/a.html', path: null, language: null, category: null },
      { ...pairs[0]!, id: 'fp1', url_a: 'http://localhost:5173/fixtures/fp-anti-aliasing/a.html', path: null, language: null, category: null },
      { ...pairs[0]!, id: 'fp2', url_a: 'http://localhost:5173/fixtures/fp-cookie-banner-hidden/a.html', path: null, language: null, category: null },
      { ...pairs[0]!, id: 'tp', url_a: 'http://localhost:5173/fixtures/tp-something/a.html', path: null, language: null, category: null },
    ];
    expect(
      applyFilter(corpus, { path_prefix: '/fixtures/fp-' }).map((p) => p.id),
    ).toEqual(['fp1', 'fp2']);
  });

  it('explicit path column wins over URL pathname', () => {
    const mixed: UrlPairRow[] = [
      { ...pairs[0]!, id: 'x', url_a: 'http://example.com/foo/bar', path: '/explicit/', language: null, category: null },
    ];
    // url pathname is /foo/bar but explicit path takes precedence.
    expect(applyFilter(mixed, { path_prefix: '/foo' })).toHaveLength(0);
    expect(applyFilter(mixed, { path_prefix: '/explicit' })).toHaveLength(1);
  });
});

describe('isAllowListed', () => {
  it('matches on (pair, level, viewport) triple', () => {
    const allow = [
      { url_pair_id: 'p1', level: 'tolerant' as const, viewport_name: 'desktop' },
    ];
    expect(isAllowListed(allow, 'p1', 'tolerant', 'desktop')).toBe(true);
    expect(isAllowListed(allow, 'p1', 'tolerant', 'mobile')).toBe(false);
    expect(isAllowListed(allow, 'p1', 'strict', 'desktop')).toBe(false);
    expect(isAllowListed(allow, 'p2', 'tolerant', 'desktop')).toBe(false);
  });
});

describe('resolveEvaluationConfig precedence', () => {
  it('input overrides session, session overrides system defaults', () => {
    const session = {
      default_viewports: [desktop],
      default_capture_options: { settleDelayMs: 500 },
      default_equivalence_levels: ['tolerant' as const, 'semantic' as const],
      filter_query: { language: ['no'] },
      allow_list: [],
    };
    const cfg = resolveEvaluationConfig(
      { equivalence_levels: ['strict'] },
      session,
      undefined,
    );
    expect(cfg.equivalence_levels).toEqual(['strict']); // input wins
    expect(cfg.viewports).toEqual([desktop]); // session wins (no input)
    expect(cfg.capture_options.settleDelayMs).toBe(500); // session merged
    expect(cfg.filter_query).toEqual({ language: ['no'] });
  });

  it('falls back to system defaults when session is empty', () => {
    const cfg = resolveEvaluationConfig(undefined, undefined, undefined);
    expect(cfg.viewports).toHaveLength(1); // default desktop
    expect(cfg.equivalence_levels).toEqual(['tolerant']);
    expect(cfg.filter_query).toEqual({});
  });
});

describe('PUT /sessions/:id/config and PATCH /sessions/:id', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('persists default_viewports / equivalence_levels / filter_query', async () => {
    const sessionId = await uploadAltinnSession(h.app);
    const put = await request(h.app)
      .put(`/api/sessions/${sessionId}/config`)
      .send({
        default_viewports: [desktop],
        default_equivalence_levels: ['tolerant', 'semantic'],
        filter_query: { language: ['no'] },
      });
    expect(put.status).toBe(200);
    expect(put.body.config.default_equivalence_levels).toEqual(['tolerant', 'semantic']);
    expect(put.body.config.filter_query).toEqual({ language: ['no'] });

    const get = await request(h.app).get(`/api/sessions/${sessionId}/config`);
    expect(get.body.config.default_viewports).toEqual([desktop]);
  });

  it('rejects malformed config payloads', async () => {
    const sessionId = await uploadAltinnSession(h.app);
    const bad = await request(h.app)
      .put(`/api/sessions/${sessionId}/config`)
      .send({ default_equivalence_levels: ['nonsense'] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_config');
  });

  it('PATCH archives a session and removes it from the default list', async () => {
    const sessionId = await uploadAltinnSession(h.app);

    const patched = await request(h.app)
      .patch(`/api/sessions/${sessionId}`)
      .send({ archived: true });
    expect(patched.status).toBe(200);
    expect(patched.body.session.archived_at).toBeTruthy();

    const list = await request(h.app).get('/api/sessions');
    expect(list.body.sessions).toHaveLength(0);

    const listAll = await request(h.app).get('/api/sessions?include_archived=true');
    expect(listAll.body.sessions).toHaveLength(1);

    const unarchive = await request(h.app)
      .patch(`/api/sessions/${sessionId}`)
      .send({ archived: false });
    expect(unarchive.body.session.archived_at).toBeNull();
  });

  it('PATCH renames a session', async () => {
    const sessionId = await uploadAltinnSession(h.app);
    const renamed = await request(h.app)
      .patch(`/api/sessions/${sessionId}`)
      .send({ name: 'altinn-renamed' });
    expect(renamed.body.session.name).toBe('altinn-renamed');
  });
});

describe('evaluator + results respect session config', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('evaluator filters pairs by session filter_query', async () => {
    const sessionId = await uploadAltinnSession(h.app);
    await request(h.app)
      .put(`/api/sessions/${sessionId}/config`)
      .send({
        default_viewports: [desktop],
        default_equivalence_levels: ['tolerant'],
        filter_query: { language: ['no'], category: ['starte-og-drive'] },
      });

    const start = await request(h.app)
      .post(`/api/sessions/${sessionId}/evaluate`)
      .send({}); // no override → uses session config
    expect(start.status).toBe(202);
    await settle(h);

    const detail = await request(h.app).get(`/api/evaluations/${start.body.evaluation_id}`);
    expect(detail.body.evaluation.enabled_pair_count).toBe(2); // 2 NO + starte-og-drive pairs
    expect(detail.body.evaluation.cache_hits.captures).toBe(4); // 2 pairs × 2 sides
  });

  it('GET /results respects session config and tags allow-listed rows', async () => {
    const sessionId = await uploadAltinnSession(h.app);

    // Find one NO pair to allow-list.
    const detail = await request(h.app).get(`/api/sessions/${sessionId}`);
    const noPair = detail.body.url_pairs.find((p: UrlPairRow) => p.language === 'no');
    expect(noPair).toBeTruthy();

    await request(h.app)
      .put(`/api/sessions/${sessionId}/config`)
      .send({
        default_viewports: [desktop],
        default_equivalence_levels: ['tolerant'],
        filter_query: { language: ['no'] },
        allow_list: [
          { url_pair_id: noPair.id, level: 'tolerant', viewport_name: 'desktop' },
        ],
      });

    const start = h.evaluator.start(sessionId);
    expect(start.coalesced).toBe(false);
    await settle(h);

    const results = await request(h.app).get(`/api/sessions/${sessionId}/results`);
    expect(results.status).toBe(200);
    expect(results.body.plan.enabled_pair_count).toBe(2); // language=no
    expect(results.body.results).toHaveLength(2);
    const allowed = results.body.results.find(
      (r: { url_pair_id: string; is_allowed: boolean }) => r.url_pair_id === noPair.id,
    );
    expect(allowed.is_allowed).toBe(true);
    const other = results.body.results.find(
      (r: { url_pair_id: string; is_allowed: boolean }) => r.url_pair_id !== noPair.id,
    );
    expect(other.is_allowed).toBe(false);
  });

  it('per-call url_pair_ids overrides session filter', async () => {
    const sessionId = await uploadAltinnSession(h.app);
    await request(h.app)
      .put(`/api/sessions/${sessionId}/config`)
      .send({
        default_viewports: [desktop],
        default_equivalence_levels: ['tolerant'],
        filter_query: { language: ['no'] },
      });

    const detail = await request(h.app).get(`/api/sessions/${sessionId}`);
    const enPair = detail.body.url_pairs.find((p: UrlPairRow) => p.language === 'en');

    const start = await request(h.app)
      .post(`/api/sessions/${sessionId}/evaluate`)
      .send({ config: { url_pair_ids: [enPair.id] } });
    expect(start.status).toBe(202);
    await settle(h);

    const evalDetail = await request(h.app).get(`/api/evaluations/${start.body.evaluation_id}`);
    // Filter would have excluded EN pairs, but the explicit override wins.
    expect(evalDetail.body.evaluation.enabled_pair_count).toBe(1);
    expect(evalDetail.body.evaluation.cache_hits.captures).toBe(2); // 1 pair × 2 sides
  });
});
