import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
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
  backfillSessionPrompts,
  hashPrompt,
  seedLmPromptDefaults,
} from '../src/services/lm-prompts.js';
import { userInstructionTemplateId } from '../src/services/lm.js';
import {
  LM_PROMPT_DEFAULTS,
  TARGET_LEVEL_FAILURE_PROMPT,
} from '../src/constants/lm-prompts.js';
import type { ViewportDef } from '../src/types.js';

const desktop: ViewportDef = {
  name: 'desktop',
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  orientation: 'landscape',
};

interface AnalyzeCall {
  prompt?: { id: string; text: string };
  invocationReason: string;
}

function stubCaptureWorker(): CaptureWorker {
  let counter = 0;
  return {
    capture: async (args) => {
      const dir = join(tmpdir(), 'vc-prompts-test-captures');
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

function recordingLm(calls: AnalyzeCall[]): LmClient {
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
    analyze: async (args) => {
      calls.push({ prompt: args.prompt, invocationReason: args.invocationReason });
      return {
        parsed: {
          equivalent: false,
          confidence: 0.7,
          summary: 'stub',
          differences: [],
        },
        rawText: '{}',
        path: 'json_schema',
        promptVersion: args.prompt?.id ?? 'env-fallback',
        model: 'stub-model',
      };
    },
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  db: Db;
  queue: JobQueue;
  evaluator: Evaluator;
  analyzeCalls: AnalyzeCall[];
  cleanup: () => Promise<void>;
}

async function makeHarness(opts: { seed?: boolean } = {}): Promise<Harness> {
  const storeDir = await mkdtemp(join(tmpdir(), 'vc-prompts-itest-'));
  const db = openDatabase({ path: ':memory:' });
  applySchema(db);
  if (opts.seed !== false) {
    seedLmPromptDefaults(db);
    backfillSessionPrompts(db);
  }
  const queue = new JobQueue(db);
  const artifactStore = createArtifactStore(storeDir);
  const captureWorker = stubCaptureWorker();
  const imagick = stubImagick();
  const analyzeCalls: AnalyzeCall[] = [];
  const lm = recordingLm(analyzeCalls);
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
    analyzeCalls,
    cleanup: async () => {
      await rm(storeDir, { recursive: true, force: true });
      db.close();
    },
  };
}

async function uploadOnePair(app: Harness['app']): Promise<string> {
  const csv = ['url_a,url_b,label', 'https://a.test,https://b.test,P1'].join('\n');
  const upload = await request(app)
    .post('/api/sessions')
    .field('name', 'prompt-test')
    .attach('csv', Buffer.from(csv), 'p.csv');
  expect(upload.status).toBe(201);
  return upload.body.session.id as string;
}

async function settle(h: Harness): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await h.evaluator.drainAll();
    await h.queue.drain();
  }
}

describe('hashPrompt', () => {
  it('matches sha256 of the input text', () => {
    const expected = createHash('sha256').update('hello').digest('hex');
    expect(hashPrompt('hello')).toBe(expected);
  });

  it('changes when the text changes', () => {
    expect(hashPrompt('a')).not.toBe(hashPrompt('a ')); // trailing space matters
  });
});

describe('seed + backfill', () => {
  it('seeds defaults from constants on first call, idempotent on second', () => {
    const db = openDatabase({ path: ':memory:' });
    applySchema(db);
    expect(seedLmPromptDefaults(db)).toBe(2);
    expect(seedLmPromptDefaults(db)).toBe(0);

    const rows = db
      .prepare<unknown[], { invocation_reason: string; prompt_id: string; source: string }>(
        'SELECT invocation_reason, prompt_id, source FROM lm_prompt_defaults ORDER BY invocation_reason',
      )
      .all();
    expect(rows.map((r) => r.invocation_reason)).toEqual([
      'ambiguous_pixel_result',
      'target_level_failure',
    ]);
    expect(rows.every((r) => r.source === 'seed')).toBe(true);
    const targetLevelFailure = rows.find((r) => r.invocation_reason === 'target_level_failure')!;
    expect(targetLevelFailure.prompt_id).toBe(hashPrompt(LM_PROMPT_DEFAULTS.target_level_failure));
    db.close();
  });

  it('upgrades seed-sourced defaults when the constants change (simulated)', () => {
    const db = openDatabase({ path: ':memory:' });
    applySchema(db);
    // Plant an old "seed" default with a stale prompt_id, mimicking the
    // pre-v3 state of an existing dev DB.
    const stalePromptId = 'a'.repeat(64);
    db.prepare(
      `INSERT INTO lm_prompt_defaults
         (invocation_reason, prompt_text, prompt_id, source, guidance_json, updated_at)
       VALUES ('target_level_failure', 'OLD V2 PROMPT', ?, 'seed', '{}', ?)`,
    ).run(stalePromptId, new Date().toISOString());

    // Re-running seed should overwrite the seed-sourced row with the
    // current constants.
    const changed = seedLmPromptDefaults(db);
    expect(changed).toBeGreaterThanOrEqual(1);

    const row = db
      .prepare<[], { prompt_text: string; prompt_id: string; source: string }>(
        `SELECT prompt_text, prompt_id, source FROM lm_prompt_defaults
          WHERE invocation_reason = 'target_level_failure'`,
      )
      .get()!;
    expect(row.prompt_id).toBe(hashPrompt(LM_PROMPT_DEFAULTS.target_level_failure));
    expect(row.prompt_text).toBe(LM_PROMPT_DEFAULTS.target_level_failure);
    expect(row.source).toBe('seed');
    db.close();
  });

  it('preserves admin-overridden defaults across re-seed', () => {
    const db = openDatabase({ path: ':memory:' });
    applySchema(db);
    const adminPromptText = 'ADMIN-EDITED PROMPT — must survive constants changes';
    db.prepare(
      `INSERT INTO lm_prompt_defaults
         (invocation_reason, prompt_text, prompt_id, source, guidance_json, updated_at)
       VALUES ('target_level_failure', ?, ?, 'override', '{}', ?)`,
    ).run(adminPromptText, hashPrompt(adminPromptText), new Date().toISOString());

    seedLmPromptDefaults(db);

    const row = db
      .prepare<[], { prompt_text: string; source: string }>(
        `SELECT prompt_text, source FROM lm_prompt_defaults
          WHERE invocation_reason = 'target_level_failure'`,
      )
      .get()!;
    expect(row.prompt_text).toBe(adminPromptText);
    expect(row.source).toBe('override');
    db.close();
  });

  it('backfillSessionPrompts copies defaults into legacy sessions', async () => {
    const h = await makeHarness({ seed: false });
    try {
      const sessionId = await uploadOnePair(h.app);
      // No prompts yet — pre-seed state.
      expect(
        h.db.prepare<unknown[], { c: number }>('SELECT COUNT(*) AS c FROM lm_prompts').get()?.c,
      ).toBe(0);

      seedLmPromptDefaults(h.db);
      const filled = backfillSessionPrompts(h.db);
      expect(filled).toBe(1);

      const sessionPrompts = h.db
        .prepare<[string], { invocation_reason: string }>(
          'SELECT invocation_reason FROM lm_prompts WHERE session_id = ? ORDER BY invocation_reason',
        )
        .all(sessionId);
      expect(sessionPrompts.map((p) => p.invocation_reason)).toEqual([
        'ambiguous_pixel_result',
        'target_level_failure',
      ]);
    } finally {
      await h.cleanup();
    }
  });
});

describe('createSession copies defaults', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('inserts lm_prompts rows for both reasons at creation time', async () => {
    const sessionId = await uploadOnePair(h.app);
    const list = await request(h.app).get(`/api/sessions/${sessionId}/lm-prompts`);
    expect(list.status).toBe(200);
    expect(list.body.prompts).toHaveLength(2);
    expect(list.body.prompts.map((p: { invocation_reason: string }) => p.invocation_reason).sort())
      .toEqual(['ambiguous_pixel_result', 'target_level_failure']);
  });
});

describe('LM analyze receives the session prompt', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('passes the session-scoped prompt id + text into the LM call (target_level_failure)', async () => {
    const sessionId = await uploadOnePair(h.app);
    // Force a target_level_failure LM call: pixel walk reaches tolerant
    // (pct=1, ssim=0.97), but target=strict requires pct≤0.5 → miss.
    h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'strict',
      invoke_lm: true,
    });
    await settle(h);

    expect(h.analyzeCalls).toHaveLength(1);
    const call = h.analyzeCalls[0]!;
    expect(call.invocationReason).toBe('target_level_failure');
    expect(call.prompt?.id).toBe(hashPrompt(TARGET_LEVEL_FAILURE_PROMPT));
    expect(call.prompt?.text).toBe(TARGET_LEVEL_FAILURE_PROMPT);

    const lmRow = h.db
      .prepare<unknown[], { prompt_id: string }>(
        'SELECT prompt_id FROM lm_verdict_cache LIMIT 1',
      )
      .get();
    expect(lmRow?.prompt_id).toBe(hashPrompt(TARGET_LEVEL_FAILURE_PROMPT));
  });
});

describe('editing a session prompt invalidates its LM cache', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('cache hits before edit, cache miss after edit, hit again after re-eval', async () => {
    const sessionId = await uploadOnePair(h.app);

    // First evaluation: produces a cached LM verdict via target_level_failure.
    h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'strict',
      invoke_lm: true,
    });
    await settle(h);
    expect(h.analyzeCalls).toHaveLength(1);

    // Second evaluation, no edit: should be all cache hits.
    const before = h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'strict',
      invoke_lm: true,
    });
    await settle(h);
    expect(h.analyzeCalls).toHaveLength(1); // no new LM call
    const beforeDetail = await request(h.app).get(`/api/evaluations/${before.evaluation_id}`);
    expect(beforeDetail.body.evaluation.cache_hits.lm).toBe(1);

    // Edit the session's target_level_failure prompt (advanced mode).
    const edit = await request(h.app)
      .put(`/api/sessions/${sessionId}/lm-prompts/target_level_failure`)
      .send({
        mode: 'advanced',
        prompt_text: 'A completely new prompt for second-pass review.',
      });
    expect(edit.status).toBe(200);
    expect(edit.body.prompt.prompt_id).not.toBe(hashPrompt(TARGET_LEVEL_FAILURE_PROMPT));
    expect(edit.body.prompt.mode).toBe('advanced');
    expect(edit.body.prompt.guidance).toBeNull();

    // Third evaluation: should re-invoke LM (new prompt_id → cache miss).
    h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'strict',
      invoke_lm: true,
    });
    await settle(h);
    expect(h.analyzeCalls).toHaveLength(2);
    expect(h.analyzeCalls[1]!.prompt?.text).toBe(
      'A completely new prompt for second-pass review.',
    );
    // Two cache rows now exist — one per prompt_id.
    expect(
      h.db.prepare<unknown[], { c: number }>('SELECT COUNT(*) AS c FROM lm_verdict_cache').get()?.c,
    ).toBe(2);
  });
});

describe('routes', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('GET /api/lm-prompts/defaults returns seeded entries', async () => {
    const res = await request(h.app).get('/api/lm-prompts/defaults');
    expect(res.status).toBe(200);
    expect(res.body.defaults).toHaveLength(2);
  });

  it('PUT /api/lm-prompts/defaults/:reason flips source to override', async () => {
    const put = await request(h.app)
      .put('/api/lm-prompts/defaults/target_level_failure')
      .send({ prompt_text: 'admin-overridden default' });
    expect(put.status).toBe(200);
    expect(put.body.default.source).toBe('override');
    expect(put.body.default.prompt_id).toBe(hashPrompt('admin-overridden default'));
  });

  it('rejects unknown invocation reasons', async () => {
    const res = await request(h.app).put('/api/lm-prompts/defaults/nonsense').send({
      prompt_text: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_reason');
  });

  it('rejects empty advanced prompt_text', async () => {
    const sessionId = await uploadOnePair(h.app);
    const res = await request(h.app)
      .put(`/api/sessions/${sessionId}/lm-prompts/target_level_failure`)
      .send({ mode: 'advanced', prompt_text: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });

  it('rejects body missing the mode discriminator', async () => {
    const sessionId = await uploadOnePair(h.app);
    const res = await request(h.app)
      .put(`/api/sessions/${sessionId}/lm-prompts/target_level_failure`)
      .send({ prompt_text: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });

  it('PUT session prompt for unknown session returns 404', async () => {
    const res = await request(h.app)
      .put('/api/sessions/missing/lm-prompts/target_level_failure')
      .send({ mode: 'advanced', prompt_text: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('structured guidance mode', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('GET returns structured mode + parsed guidance for freshly seeded prompts', async () => {
    const sessionId = await uploadOnePair(h.app);
    const res = await request(h.app).get(
      `/api/sessions/${sessionId}/lm-prompts/target_level_failure`,
    );
    expect(res.status).toBe(200);
    expect(res.body.prompt.mode).toBe('structured');
    expect(res.body.prompt.guidance).toEqual({ toggles: {}, house_rules: { scope: [], trigger: [] } });
    expect(res.body.prompt.base_prompt_text).toBe(TARGET_LEVEL_FAILURE_PROMPT);
    expect(res.body.prompt.prompt_text).toBe(TARGET_LEVEL_FAILURE_PROMPT);
  });

  it('PUT structured assembles toggles into prompt_text and updates prompt_id', async () => {
    const sessionId = await uploadOnePair(h.app);
    const put = await request(h.app)
      .put(`/api/sessions/${sessionId}/lm-prompts/target_level_failure`)
      .send({
        mode: 'structured',
        guidance: {
          toggles: { language_must_match: true },
          house_rules: { scope: [], trigger: ['Hero headline must be identical'] },
        },
      });
    expect(put.status).toBe(200);
    expect(put.body.prompt.mode).toBe('structured');
    expect(put.body.prompt.guidance.toggles.language_must_match).toBe(true);
    expect(put.body.prompt.guidance.house_rules).toEqual({
      scope: [],
      trigger: ['Hero headline must be identical'],
    });
    expect(put.body.prompt.prompt_text).toContain('## Project rules');
    expect(put.body.prompt.prompt_text).toContain('one human language and B is in another');
    expect(put.body.prompt.prompt_text).toContain('Hero headline must be identical');
    expect(put.body.prompt.prompt_id).not.toBe(hashPrompt(TARGET_LEVEL_FAILURE_PROMPT));
  });

  it('flipping a toggle invalidates the LM verdict cache', async () => {
    const sessionId = await uploadOnePair(h.app);

    // Baseline run: structured mode with empty guidance → prompt_text == base.
    h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'strict',
      invoke_lm: true,
    });
    await settle(h);
    expect(h.analyzeCalls).toHaveLength(1);

    // Enable a toggle — different prompt_text → cache miss on next eval.
    await request(h.app)
      .put(`/api/sessions/${sessionId}/lm-prompts/target_level_failure`)
      .send({
        mode: 'structured',
        guidance: { toggles: { language_must_match: true }, house_rules: { scope: [], trigger: [] } },
      });

    h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'strict',
      invoke_lm: true,
    });
    await settle(h);
    expect(h.analyzeCalls).toHaveLength(2);
    expect(h.analyzeCalls[1]!.prompt?.text).toContain('one human language and B is in another');
  });

  it('reset endpoint restores the default and clears any session edits', async () => {
    const sessionId = await uploadOnePair(h.app);

    // Apply a structured edit.
    await request(h.app)
      .put(`/api/sessions/${sessionId}/lm-prompts/target_level_failure`)
      .send({
        mode: 'structured',
        guidance: {
          toggles: { ignore_chrome_only_diffs: true },
          house_rules: [],
        },
      });

    // Reset.
    const reset = await request(h.app).post(
      `/api/sessions/${sessionId}/lm-prompts/target_level_failure/reset`,
    );
    expect(reset.status).toBe(200);
    expect(reset.body.prompt.prompt_text).toBe(TARGET_LEVEL_FAILURE_PROMPT);
    expect(reset.body.prompt.guidance).toEqual({ toggles: {}, house_rules: { scope: [], trigger: [] } });
    expect(reset.body.prompt.mode).toBe('structured');
  });

  it('rejects unknown toggle keys in structured guidance', async () => {
    const sessionId = await uploadOnePair(h.app);
    const res = await request(h.app)
      .put(`/api/sessions/${sessionId}/lm-prompts/target_level_failure`)
      .send({
        mode: 'structured',
        guidance: { toggles: { not_a_real_toggle: true }, house_rules: { scope: [], trigger: [] } },
      });
    expect(res.status).toBe(400);
  });
});

describe('readSessionResults surfaces persisted LM verdicts regardless of invoke_lm', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('detail and list agree once an LM verdict is cached, even with invoke_lm=false', async () => {
    const sessionId = await uploadOnePair(h.app);

    // Run with invoke_lm=true at target=strict so the LM is invoked and
    // a verdict gets cached at invocation_reason='target_level_failure'.
    h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'strict',
      invoke_lm: true,
    });
    await settle(h);
    expect(h.analyzeCalls).toHaveLength(1);

    // Now query /results at the same target but with invoke_lm explicitly
    // off. Without the read-side fix this would return pixel-only because
    // the gate would refuse to probe the LM cache. With the fix the row
    // surfaces the cached LM verdict.
    const cfg = encodeURIComponent(JSON.stringify({ target_level: 'strict' }));
    const resultsOff = await request(h.app).get(
      `/api/sessions/${sessionId}/results?config=${cfg}`,
    );
    expect(resultsOff.status).toBe(200);
    const row = resultsOff.body.results[0];
    expect(row.matched_decided_by).toBe('lm');
    expect(row.lm).not.toBeNull();
    expect(row.lm.invocation_reason).toBe('target_level_failure');
  });

  it('still returns pixel-only when no LM verdict has been cached and invoke_lm=false', async () => {
    const sessionId = await uploadOnePair(h.app);

    // Run without LM so the cache stays empty for target_level_failure.
    h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'strict',
      invoke_lm: false,
    });
    await settle(h);
    expect(h.analyzeCalls).toHaveLength(0);

    const cfg = encodeURIComponent(JSON.stringify({ target_level: 'strict' }));
    const results = await request(h.app).get(
      `/api/sessions/${sessionId}/results?config=${cfg}`,
    );
    expect(results.status).toBe(200);
    const row = results.body.results[0];
    expect(row.matched_decided_by).toBe('pixel');
    expect(row.lm).toBeNull();
  });
});

describe('user_instruction_id participates in the LM cache key', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('a stale user_instruction_id row is ignored; the LM is re-invoked', async () => {
    const sessionId = await uploadOnePair(h.app);

    // First eval: produces a real cache row at the current user-instruction id.
    h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'strict',
      invoke_lm: true,
    });
    await settle(h);
    expect(h.analyzeCalls).toHaveLength(1);

    // Confirm there's exactly one LM cache row at the current id.
    const realId = userInstructionTemplateId('target_level_failure');
    const before = h.db
      .prepare<unknown[], { c: number }>(
        `SELECT COUNT(*) AS c FROM lm_verdict_cache WHERE user_instruction_id = ?`,
      )
      .get(realId);
    expect(before?.c).toBe(1);

    // Now mutate that row's user_instruction_id to a stale hash, simulating
    // what happens when the engineer edits buildPromptUserInstruction wording.
    h.db
      .prepare(
        `UPDATE lm_verdict_cache SET user_instruction_id = 'STALE_HASH' WHERE user_instruction_id = ?`,
      )
      .run(realId);

    // Re-eval — the planner should treat the stale row as a miss and the LM
    // is invoked again, producing a fresh row at the current user_instruction_id.
    h.evaluator.start(sessionId, {
      viewports: [desktop],
      target_level: 'strict',
      invoke_lm: true,
    });
    await settle(h);
    expect(h.analyzeCalls).toHaveLength(2);

    const after = h.db
      .prepare<unknown[], { c: number }>(
        `SELECT COUNT(*) AS c FROM lm_verdict_cache WHERE user_instruction_id = ?`,
      )
      .get(realId);
    expect(after?.c).toBe(1);
  });

  it('userInstructionTemplateId is stable for a given reason and differs across reasons', () => {
    const tlf1 = userInstructionTemplateId('target_level_failure');
    const tlf2 = userInstructionTemplateId('target_level_failure');
    const apr = userInstructionTemplateId('ambiguous_pixel_result');
    expect(tlf1).toBe(tlf2);
    expect(tlf1).not.toBe(apr);
    expect(tlf1).toMatch(/^[0-9a-f]{64}$/);
  });
});
