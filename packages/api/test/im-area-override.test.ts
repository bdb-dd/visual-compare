import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import type { ViewportDef } from '../src/types.js';

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
    capture: async () => {
      const dir = join(tmpdir(), 'vc-area-override-captures');
      await mkdir(dir, { recursive: true });
      const path = join(dir, `cap-${counter++}.png`);
      await writeFile(path, Buffer.from(`STUB-${counter}`));
      return { tempPath: path, durationMs: 1, httpStatus: 200, isMissing: false };
    },
    shutdown: async () => {},
  };
}

/**
 * Imagick stub where the caller picks the regions' bbox-area %. The
 * connected-components raw JSON is shaped so `parseConnectedComponents`
 * yields the requested coverage when computed against a 100×100 surface.
 */
function imagickWithBboxArea(bboxAreaPercent: number): ComparisonImagick {
  // Width × height = bboxAreaPercent of 100×100 = bboxAreaPercent × 100 px².
  // Choose a square: side = round(sqrt(percent * 100)).
  const side = Math.max(1, Math.round(Math.sqrt(bboxAreaPercent * 100)));
  const region = {
    id: 1,
    area: side * side,
    geometry: `${side}x${side}+0+0`,
    color: 'srgba(255,0,0,1)',
  };
  return {
    compareAe: async (_a, _b, diffPath) => {
      await mkdir(dirname(diffPath), { recursive: true });
      await writeFile(diffPath, Buffer.from('DIFF'));
      // Pick metrics that miss strict (>0.5%) but stay in the tolerant
      // band so LM invocation fires for 'target_level_failure' OR
      // 'ambiguous_pixel_result' depending on the test's invokeLm flag.
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
      format: 'json' as const,
      raw: JSON.stringify([region]),
    }),
  };
}

function lmAlwaysEquivalent(): LmClient {
  return {
    config: {
      baseURL: 'http://stub',
      apiKey: 'stub',
      model: 'stub-model',
      promptVersion: 'stub-prompt',
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
    }),
    analyze: async () => ({
      parsed: {
        equivalent: true,
        confidence: 0.9,
        summary: 'effectively equivalent in content and purpose',
        differences: [],
      },
      rawText: '{"equivalent":true}',
      path: 'json_schema',
      promptVersion: 'stub-prompt',
      model: 'stub-model',
    }),
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  db: Db;
  queue: JobQueue;
  cleanup: () => Promise<void>;
}

async function makeHarness(imagick: ComparisonImagick): Promise<Harness> {
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-area-override-'));
  const db = openDatabase({ path: ':memory:' });
  applySchema(db);
  const queue = new JobQueue(db);
  const artifactStore = createArtifactStore(storeDir);
  const app = createApp({
    db,
    queue,
    artifactStore,
    captureWorker: stubCaptureWorker(),
    imagick,
    lm: lmAlwaysEquivalent(),
  });
  return {
    app,
    db,
    queue,
    cleanup: async () => {
      await rm(storeDir, { recursive: true, force: true });
      db.close();
    },
  };
}

async function uploadSession(app: Harness['app']): Promise<string> {
  const csv = ['url_a,url_b,label', 'https://a.example.com/1,https://b.example.com/1,pair-1'].join('\n');
  const upload = await request(app)
    .post('/api/sessions')
    .field('name', 'area-override')
    .attach('csv', Buffer.from(csv), 'pairs.csv');
  expect(upload.status).toBe(201);
  return upload.body.session.id as string;
}

async function captureAndCompare(
  h: Harness,
  sessionId: string,
  opts: { targetLevel: 'strict' | 'tolerant' | 'loose' | 'pixel-perfect'; invokeLm: boolean },
): Promise<void> {
  const cap = await request(h.app)
    .post('/api/capture-runs')
    .send({ session_id: sessionId, options: { viewports: [desktop] } });
  await h.queue.drain();
  await request(h.app)
    .post('/api/comparison-runs')
    .send({
      session_id: sessionId,
      capture_run_id: cap.body.capture_run_id,
      options: opts,
    })
    .expect(202);
  await h.queue.drain();
}

describe('IM-area override on LM "equivalent" verdict', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.cleanup();
  });

  it("trusts LM 'equivalent' when bbox_area_pct is below the threshold", async () => {
    // 10% bbox area — well under the 20% guardrail. LM equivalent should
    // be honored: matched_at_level promoted to target, decided_by='lm'.
    h = await makeHarness(imagickWithBboxArea(10));
    const sessionId = await uploadSession(h.app);
    await captureAndCompare(h, sessionId, { targetLevel: 'strict', invokeLm: true });

    const row = h.db
      .prepare<
        unknown[],
        {
          matched_at_level: string | null;
          matched_decided_by: string | null;
          lm_determined_equivalent: number | null;
          bounding_box_area_percentage: number | null;
          lm_diff_summary: string | null;
        }
      >(
        `SELECT matched_at_level, matched_decided_by, lm_determined_equivalent,
                bounding_box_area_percentage, lm_diff_summary
           FROM comparisons ORDER BY created_at DESC LIMIT 1`,
      )
      .get();
    expect(row?.matched_at_level).toBe('strict');
    expect(row?.matched_decided_by).toBe('lm');
    expect(row?.lm_determined_equivalent).toBe(1);
    expect(row?.lm_diff_summary).not.toMatch(/im_area_override/);
    // Sanity: bbox area is actually below threshold so the override path
    // wasn't reached for the right reason.
    expect(row?.bounding_box_area_percentage).toBeLessThan(20);
  });

  it("downgrades LM 'equivalent' when bbox_area_pct exceeds the threshold", async () => {
    // 40% bbox area — well above the 20% guardrail. The LM still says
    // equivalent, but the row should NOT be promoted: matched_at_level
    // stays at the pixel walk's level, matched_decided_by flips to
    // 'pixel', and the summary records the override.
    h = await makeHarness(imagickWithBboxArea(40));
    const sessionId = await uploadSession(h.app);
    await captureAndCompare(h, sessionId, { targetLevel: 'strict', invokeLm: true });

    const row = h.db
      .prepare<
        unknown[],
        {
          matched_at_level: string | null;
          matched_decided_by: string | null;
          lm_determined_equivalent: number | null;
          bounding_box_area_percentage: number | null;
          lm_diff_summary: string | null;
        }
      >(
        `SELECT matched_at_level, matched_decided_by, lm_determined_equivalent,
                bounding_box_area_percentage, lm_diff_summary
           FROM comparisons ORDER BY created_at DESC LIMIT 1`,
      )
      .get();
    // Stub metrics (1% changed, ssim 0.97) put the pixel walk at
    // 'tolerant'. Strict target → pixel walk is weaker than target, so
    // without the override matched_at_level would have been promoted
    // to 'strict' by the LM verdict. The override keeps it at
    // 'tolerant'.
    expect(row?.matched_at_level).toBe('tolerant');
    expect(row?.matched_decided_by).toBe('pixel');
    // Raw LM verdict is preserved for diagnostics.
    expect(row?.lm_determined_equivalent).toBe(1);
    expect(row?.bounding_box_area_percentage).toBeGreaterThan(20);
    expect(row?.lm_diff_summary).toMatch(/^\[im_area_override [\d.]+%>20%\]/);
  });

  it("doesn't affect LM 'different' verdicts (override only fires on equivalent)", async () => {
    // Even with huge bbox area, an LM "different" verdict isn't an
    // override candidate — the override only fires when LM tried to
    // promote and the area is too large to trust.
    const lmDifferent: LmClient = {
      ...lmAlwaysEquivalent(),
      analyze: async () => ({
        parsed: {
          equivalent: false,
          confidence: 0.8,
          summary: 'pages differ in mid-page content',
          differences: [],
        },
        rawText: '{"equivalent":false}',
        path: 'json_schema',
        promptVersion: 'stub-prompt',
        model: 'stub-model',
      }),
    };
    const storeDir = await mkdtemp(join(tmpdir(), 'vc-area-override-'));
    const db = openDatabase({ path: ':memory:' });
    applySchema(db);
    const queue = new JobQueue(db);
    const artifactStore = createArtifactStore(storeDir);
    const app = createApp({
      db,
      queue,
      artifactStore,
      captureWorker: stubCaptureWorker(),
      imagick: imagickWithBboxArea(40),
      lm: lmDifferent,
    });
    h = { app, db, queue, cleanup: async () => { await rm(storeDir, { recursive: true, force: true }); db.close(); } };

    const sessionId = await uploadSession(h.app);
    await captureAndCompare(h, sessionId, { targetLevel: 'strict', invokeLm: true });

    const row = h.db
      .prepare<
        unknown[],
        { matched_decided_by: string | null; lm_determined_equivalent: number | null; lm_diff_summary: string | null }
      >(
        `SELECT matched_decided_by, lm_determined_equivalent, lm_diff_summary
           FROM comparisons ORDER BY created_at DESC LIMIT 1`,
      )
      .get();
    // LM said different; LM is still the decider; no override prefix.
    expect(row?.matched_decided_by).toBe('lm');
    expect(row?.lm_determined_equivalent).toBe(0);
    expect(row?.lm_diff_summary).not.toMatch(/im_area_override/);
  });
});
