import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import OpenAI from 'openai';
import type { BoundingBoxPercent, DifferenceSeverity, EquivalenceLevelId } from '../types.js';
import {
  createLmsCli,
  readLmsCliConfigFromEnv,
  type LmsCli,
} from './lms-cli.js';

// ---------------------------------------------------------------------------
// v1 cluster-signature taxonomy (prompt version v3+).
//
// These three fields are emitted by the LM when running under the v3 prompt
// and used by the cluster-signature pipeline to group semantically-similar
// differences across pairs. See experiments/v1-taxonomy.md for the rationale
// and validation results.
//
// On v2-era responses they're absent — the zod fields are .optional() so old
// cached LM responses still parse. Cluster computation falls back to a v0
// geometric signature for rows without these tags.
// ---------------------------------------------------------------------------

export const CHANGE_TYPES = [
  'element_added',
  'element_removed',
  'element_replaced',
  'text_changed',
  'text_translated',
  'image_changed',
  'style_changed',
  'count_changed',
  'state_changed',
  'other',
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export const REGION_ROLES = [
  'header',
  'nav_primary',
  'nav_secondary',
  'hero',
  'main_content',
  'aside',
  'footer',
  'overlay',
  'alert_banner',
  'other',
] as const;
export type RegionRole = (typeof REGION_ROLES)[number];

// ---------------------------------------------------------------------------
// Response schema (zod) — must mirror the JSON Schema below.
// ---------------------------------------------------------------------------

export const lmDifferenceSchema = z.object({
  description: z.string(),
  severity: z.enum(['low', 'medium', 'high']),
  boundingBox: z.object({
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
    width: z.number().min(0).max(100),
    height: z.number().min(0).max(100),
  }),
  // v3-only fields. Optional so v2 cached responses still parse.
  changeType: z.enum(CHANGE_TYPES).optional(),
  regionRole: z.enum(REGION_ROLES).optional(),
  elementLabel: z.string().max(64).optional(),
});

export const lmResponseSchema = z.object({
  equivalent: z.boolean(),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  differences: z.array(lmDifferenceSchema),
});

export type LmDifference = z.infer<typeof lmDifferenceSchema>;
export type LmResponse = z.infer<typeof lmResponseSchema>;

// ---------------------------------------------------------------------------
// JSON Schema (sent to LM Studio via response_format).
// ---------------------------------------------------------------------------

export const LM_JSON_SCHEMA = {
  name: 'visual_compare_result',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['equivalent', 'confidence', 'summary', 'differences'],
    properties: {
      equivalent: { type: 'boolean' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      summary: { type: 'string' },
      differences: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['description', 'severity', 'boundingBox'],
          properties: {
            description: { type: 'string' },
            severity: { type: 'string', enum: ['low', 'medium', 'high'] },
            boundingBox: {
              type: 'object',
              additionalProperties: false,
              required: ['x', 'y', 'width', 'height'],
              properties: {
                x: { type: 'number', minimum: 0, maximum: 100 },
                y: { type: 'number', minimum: 0, maximum: 100 },
                width: { type: 'number', minimum: 0, maximum: 100 },
                height: { type: 'number', minimum: 0, maximum: 100 },
              },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * v3 strict schema — extends v2 with the cluster-signature taxonomy fields.
 * Sent to LM Studio via response_format when running under the v3 prompt.
 *
 * The three new fields (changeType, regionRole, elementLabel) are REQUIRED
 * in the v3 strict schema even though they're optional in the zod schema.
 * The optionality in zod is only for parsing v2-era cached responses; the
 * runtime v3 path enforces presence at the JSON-schema layer.
 */
export const LM_JSON_SCHEMA_V3 = {
  name: 'visual_compare_result',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['equivalent', 'confidence', 'summary', 'differences'],
    properties: {
      equivalent: { type: 'boolean' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      summary: { type: 'string' },
      differences: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['description', 'severity', 'boundingBox', 'changeType', 'regionRole', 'elementLabel'],
          properties: {
            description: { type: 'string' },
            severity: { type: 'string', enum: ['low', 'medium', 'high'] },
            changeType: { type: 'string', enum: [...CHANGE_TYPES] },
            regionRole: { type: 'string', enum: [...REGION_ROLES] },
            elementLabel: { type: 'string', maxLength: 64 },
            boundingBox: {
              type: 'object',
              additionalProperties: false,
              required: ['x', 'y', 'width', 'height'],
              properties: {
                x: { type: 'number', minimum: 0, maximum: 100 },
                y: { type: 'number', minimum: 0, maximum: 100 },
                width: { type: 'number', minimum: 0, maximum: 100 },
                height: { type: 'number', minimum: 0, maximum: 100 },
              },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * Detect whether a system prompt instructs the LM to emit the v1 cluster
 * taxonomy fields. Content-based because session-scoped prompts are keyed
 * by sha256 of their text, not by a version label — a hash can't tell us
 * which schema flavour the LM was instructed to follow, but the text can.
 *
 * The check looks for the canonical schema field names (`changeType`,
 * `regionRole`) which only appear in v3-derived prompts. False positives
 * would require someone to deliberately put those strings into a custom
 * v2-style prompt; in that case picking the v3 schema is still safe
 * because the response_format is permissive of extra information being
 * present in the model's textual reasoning.
 */
export function usesV1Taxonomy(systemPromptText: string): boolean {
  return systemPromptText.includes('changeType') && systemPromptText.includes('regionRole');
}

/**
 * Returns the JSON schema to send for a given system prompt. v1 taxonomy
 * → v3 strict schema; anything else → v2 strict schema. Centralised so
 * callers (runAnalyze, tests) don't branch on prompt content inline.
 */
export function jsonSchemaForPrompt(systemPromptText: string): typeof LM_JSON_SCHEMA | typeof LM_JSON_SCHEMA_V3 {
  return usesV1Taxonomy(systemPromptText) ? LM_JSON_SCHEMA_V3 : LM_JSON_SCHEMA;
}

// ---------------------------------------------------------------------------
// Prompt builder (versioned).
// ---------------------------------------------------------------------------

/**
 * Storage / display label for the active prompt schema. Bumped from 'v2'
 * to 'v3' alongside the seeding switch to the cluster-taxonomy prompt
 * (see constants/lm-prompts.ts). It's used as a cache-key component and
 * an audit trail — the actual schema-selection logic is content-based
 * (jsonSchemaForPrompt), so this label and the schema flavor can stay
 * loosely coupled.
 */
export const DEFAULT_PROMPT_VERSION = 'v3';

const SYSTEM_PROMPT_V1 = `You are a visual-regression assistant comparing screenshots of two web pages.

Your job: decide whether the two pages communicate the same content and purpose. Layout differences that don't change the meaning (minor styling, different ad slots) are acceptable. Differences that change navigation, headlines, primary content, or call-to-action mean the pages are NOT equivalent.

You will receive three images:
  1. Screenshot A
  2. Screenshot B
  3. A diff image where unchanged regions are white and changed regions are red. A nearly-all-white diff means the pages are pixel-identical or nearly so. Trust the diff: if it is overwhelmingly white, the differences array MUST be empty.

Decision procedure:
  - If A and B look the same to a user, return equivalent=true with an empty differences array.
  - Only return equivalent=false when at least one user-visible difference exists. Each entry in differences must describe an actual change you can point to in BOTH images.
  - It is OK to return zero differences. Do not invent differences to fill out the list.

Reply ONLY with JSON matching the supplied schema. Bounding boxes MUST be expressed as percentages of the image dimensions (0..100), NOT pixels. Each bounding box is an OBJECT with named fields x, y, width, height — never an array.

Worked example of one valid difference entry:

  {
    "description": "Hero headline differs.",
    "severity": "high",
    "boundingBox": { "x": 10, "y": 5, "width": 80, "height": 12 }
  }

confidence is your overall confidence in the equivalent verdict, in 0..1.`;


interface BuildPromptInput {
  level: EquivalenceLevelId;
  invocationReason: 'ambiguous_pixel_result' | 'target_level_failure' | 'manual_retry';
  changedPixelPercentage: number | null;
  ssim: number | null;
}

export function buildPromptUserInstruction(input: BuildPromptInput): string {
  const { invocationReason } = input;
  const ctx: string[] = [];
  if (input.changedPixelPercentage !== null) {
    ctx.push(`changed pixel %: ${input.changedPixelPercentage.toFixed(3)}`);
  }
  if (input.ssim !== null) {
    ctx.push(`SSIM (0..1, 1 = identical): ${input.ssim.toFixed(4)}`);
  }
  const ctxLine = ctx.length ? ` Pixel metrics: ${ctx.join(', ')}.` : '';

  // The level name is deliberately omitted: the LM kept latching onto the
  // word "tolerant" to justify ignoring explicit project rules ("the level
  // is tolerant, so this difference is acceptable…"). The level governed
  // whether to invoke the LM at all; once invoked, the LM's job is a pure
  // content/purpose call.
  if (invocationReason === 'target_level_failure') {
    return `The pixel comparison did not pass at the configured threshold. Decide whether these pages are nevertheless effectively equivalent in content and purpose. Apply any project rules in the system prompt as absolute, even if a difference might otherwise seem tolerable.${ctxLine} Reply per the schema.`;
  }
  if (invocationReason === 'ambiguous_pixel_result') {
    return `The pixel comparison was ambiguous, so you are the tiebreaker. Apply any project rules in the system prompt as absolute, even if a difference might otherwise seem tolerable.${ctxLine} Decide whether these pages communicate the same content and purpose, and reply per the schema.`;
  }
  return `Manual retry — reply per the schema.${ctxLine}`;
}

/**
 * Stable identifier for the user instruction *template* used at LM
 * invocation time. Computed by rendering `buildPromptUserInstruction` with
 * sentinel inputs (no pixel metrics, placeholder level) and hashing the
 * result. Per-call values like changedPct and SSIM are deliberately
 * stripped so the id depends only on the template wording, not on the
 * specific row being judged.
 *
 * Included in the LM verdict cache PK so wording changes auto-invalidate
 * cached verdicts without bumping PIPELINE_VERSION (which would also nuke
 * the pixel cache).
 */
export function userInstructionTemplateId(
  invocationReason: 'ambiguous_pixel_result' | 'target_level_failure' | 'manual_retry',
): string {
  const text = buildPromptUserInstruction({
    level: 'tolerant' as EquivalenceLevelId,
    invocationReason,
    changedPixelPercentage: null,
    ssim: null,
  });
  return createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// Client + invocation
// ---------------------------------------------------------------------------

export interface LmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  promptVersion: string;
  /** Override system prompt (rarely needed). */
  systemPrompt?: string;
  /** Hard cap on completion tokens. */
  maxTokens?: number;
  /** Hint to LM Studio. We keep it low to encourage stable JSON. */
  temperature?: number;
  /** Seconds before aborting an LM call. Default 240. */
  timeoutSeconds?: number;
  /** Try `lms server start` automatically when /v1/models is unreachable. */
  autoStart: boolean;
  /** Try `lms load <model>` automatically when the configured model is missing. */
  autoLoad: boolean;
  /** Seconds the cached preflight result remains valid. */
  preflightCacheSeconds: number;
}

export function readLmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LmConfig {
  const flag = (key: string, def: boolean) => {
    const v = env[key];
    if (v === undefined) return def;
    return v !== '0' && v.toLowerCase() !== 'false';
  };
  return {
    baseURL: env.LM_STUDIO_BASE_URL ?? 'http://localhost:1234/v1',
    apiKey: env.LM_STUDIO_API_KEY ?? 'lm-studio',
    model: env.LM_STUDIO_MODEL ?? 'google/gemma-4-e2b',
    promptVersion: env.LM_STUDIO_PROMPT_VERSION ?? DEFAULT_PROMPT_VERSION,
    maxTokens: env.LM_STUDIO_MAX_TOKENS ? Number(env.LM_STUDIO_MAX_TOKENS) : 1024,
    temperature: env.LM_STUDIO_TEMPERATURE ? Number(env.LM_STUDIO_TEMPERATURE) : 0.1,
    timeoutSeconds: env.LM_STUDIO_TIMEOUT_SECONDS ? Number(env.LM_STUDIO_TIMEOUT_SECONDS) : 240,
    autoStart: flag('LM_STUDIO_AUTO_START', true),
    autoLoad: flag('LM_STUDIO_AUTO_LOAD', true),
    preflightCacheSeconds: env.LM_STUDIO_PREFLIGHT_CACHE_SECONDS
      ? Number(env.LM_STUDIO_PREFLIGHT_CACHE_SECONDS)
      : 30,
  };
}

export interface AnalyzeArgs {
  config: LmConfig;
  aPath: string;
  bPath: string;
  diffPath: string;
  level: EquivalenceLevelId;
  invocationReason: 'ambiguous_pixel_result' | 'target_level_failure' | 'manual_retry';
  changedPixelPercentage: number | null;
  ssim: number | null;
  /**
   * Optional caller-supplied prompt. When present, replaces the env-derived
   * system prompt and `promptVersion`. Phase 4 wires session-scoped
   * prompts here so the LM cache key is content-addressable.
   */
  prompt?: { id: string; text: string };
}

export interface AnalyzeResult {
  /** Parsed and validated payload. */
  parsed: LmResponse;
  /** What the model literally returned (for `lm_response_json`). */
  rawText: string;
  /** Whether the strict-schema response_format succeeded or we fell back. */
  path: 'json_schema' | 'tolerant_extract';
  /** Prompt version used for this invocation. */
  promptVersion: string;
  /** Model id (echoed back from LM Studio). */
  model: string;
}

export interface AnalyzeError {
  parsed: null;
  rawText: string | null;
  message: string;
  promptVersion: string;
  model: string;
}

export type AnalyzeOutcome = AnalyzeResult | AnalyzeError;

export function isAnalyzeError(o: AnalyzeOutcome): o is AnalyzeError {
  return o.parsed === null;
}

export interface PreflightOk {
  ok: true;
  serverReachable: true;
  modelLoaded: true;
  configuredModel: string;
  loadedModels: string[];
  /** Whether `lms server start` was invoked during this preflight. */
  startedServer: boolean;
  /** Whether `lms load <model>` was invoked during this preflight. */
  loadedModel: boolean;
  durationMs: number;
}

export interface PreflightFailure {
  ok: false;
  serverReachable: boolean;
  modelLoaded: boolean;
  configuredModel: string;
  loadedModels: string[];
  /** Machine-readable failure category. */
  reason:
    | 'server_unreachable'
    | 'auto_start_failed'
    | 'model_not_loaded'
    | 'auto_load_failed'
    | 'unknown';
  message: string;
  startedServer: boolean;
  loadedModel: boolean;
  durationMs: number;
}

export type PreflightResult = PreflightOk | PreflightFailure;

export interface LmClient {
  config: LmConfig;
  /**
   * Verifies LM Studio is up and the configured model is loaded. Auto-starts
   * the server / auto-loads the model based on config flags. Result is cached
   * for `config.preflightCacheSeconds` to avoid hammering on every comparison
   * run; pass `force` to bypass the cache.
   */
  preflight(opts?: { force?: boolean }): Promise<PreflightResult>;
  /** Invalidate the preflight cache (e.g. after a real LM call fails). */
  invalidatePreflight(): void;
  analyze(args: Omit<AnalyzeArgs, 'config'>): Promise<AnalyzeOutcome>;
}

/**
 * Creates an OpenAI-compatible client pointed at LM Studio. Returns a small
 * surface (preflight, analyze, invalidatePreflight) so the comparison
 * pipeline doesn't have to know about the OpenAI SDK directly.
 */
export function createLmClient(
  config: LmConfig,
  cli: LmsCli = createLmsCli(readLmsCliConfigFromEnv()),
): LmClient {
  const client = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    timeout: (config.timeoutSeconds ?? 240) * 1000,
    maxRetries: 2,
  });

  let cached: { result: PreflightResult; expiresAt: number } | null = null;

  const invalidatePreflight = () => {
    cached = null;
  };

  const preflight = async (opts: { force?: boolean } = {}): Promise<PreflightResult> => {
    if (!opts.force && cached && cached.expiresAt > Date.now() && cached.result.ok) {
      return cached.result;
    }
    const result = await runPreflight(config, cli);
    cached = {
      result,
      expiresAt: Date.now() + config.preflightCacheSeconds * 1000,
    };
    return result;
  };

  const analyze = async (args: Omit<AnalyzeArgs, 'config'>): Promise<AnalyzeOutcome> => {
    const outcome = await runAnalyze({ config, ...args }, client);
    if (isAnalyzeError(outcome)) {
      // A failed call usually means LM is misbehaving — drop the cache so the
      // next preflight does a real check.
      invalidatePreflight();
    }
    return outcome;
  };

  return { config, preflight, invalidatePreflight, analyze };
}

async function runPreflight(config: LmConfig, cli: LmsCli): Promise<PreflightResult> {
  const startedAt = Date.now();
  let startedServer = false;
  let loadedModel = false;

  const ping = async (): Promise<{ ok: boolean; loaded: string[]; message?: string }> => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const res = await fetch(`${config.baseURL.replace(/\/$/, '')}/models`, {
          signal: ctrl.signal,
        });
        if (!res.ok) {
          return { ok: false, loaded: [], message: `HTTP ${res.status}` };
        }
        const json = (await res.json()) as { data?: Array<{ id: string }> };
        const loaded = (json.data ?? []).map((m) => m.id);
        return { ok: true, loaded };
      } finally {
        clearTimeout(t);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, loaded: [], message: msg };
    }
  };

  let probe = await ping();

  if (!probe.ok) {
    if (!config.autoStart) {
      return failure({
        reason: 'server_unreachable',
        message: `LM Studio at ${config.baseURL} is not reachable: ${probe.message ?? 'no response'}. Set LM_STUDIO_AUTO_START=1 or run \`lms server start\`.`,
        serverReachable: false,
        modelLoaded: false,
        loadedModels: [],
      });
    }
    const start = await cli.serverStart();
    startedServer = true;
    if (!start.ok) {
      return failure({
        reason: 'auto_start_failed',
        message: `\`lms server start\` failed: ${start.errorMessage ?? start.stderr.trim() ?? `exit ${start.exitCode}`}`,
        serverReachable: false,
        modelLoaded: false,
        loadedModels: [],
      });
    }
    probe = await ping();
    if (!probe.ok) {
      return failure({
        reason: 'server_unreachable',
        message: `LM Studio still unreachable after \`lms server start\`: ${probe.message ?? 'no response'}`,
        serverReachable: false,
        modelLoaded: false,
        loadedModels: [],
      });
    }
  }

  if (!probe.loaded.includes(config.model)) {
    if (!config.autoLoad) {
      return failure({
        reason: 'model_not_loaded',
        message: `Configured model '${config.model}' is not loaded. Set LM_STUDIO_AUTO_LOAD=1 or run \`lms load ${config.model}\`. Loaded: ${probe.loaded.join(', ') || '(none)'}`,
        serverReachable: true,
        modelLoaded: false,
        loadedModels: probe.loaded,
      });
    }
    const load = await cli.load(config.model);
    loadedModel = true;
    if (!load.ok) {
      return failure({
        reason: 'auto_load_failed',
        message: `\`lms load ${config.model}\` failed: ${load.errorMessage ?? load.stderr.trim() ?? `exit ${load.exitCode}`}`,
        serverReachable: true,
        modelLoaded: false,
        loadedModels: probe.loaded,
      });
    }
    probe = await ping();
    if (!probe.loaded.includes(config.model)) {
      return failure({
        reason: 'model_not_loaded',
        message: `Model '${config.model}' still not loaded after \`lms load\`. Loaded: ${probe.loaded.join(', ') || '(none)'}`,
        serverReachable: true,
        modelLoaded: false,
        loadedModels: probe.loaded,
      });
    }
  }

  return {
    ok: true,
    serverReachable: true,
    modelLoaded: true,
    configuredModel: config.model,
    loadedModels: probe.loaded,
    startedServer,
    loadedModel,
    durationMs: Date.now() - startedAt,
  };

  function failure(args: {
    reason: PreflightFailure['reason'];
    message: string;
    serverReachable: boolean;
    modelLoaded: boolean;
    loadedModels: string[];
  }): PreflightFailure {
    return {
      ok: false,
      configuredModel: config.model,
      startedServer,
      loadedModel,
      durationMs: Date.now() - startedAt,
      ...args,
    };
  }
}

async function runAnalyze(args: AnalyzeArgs, client: OpenAI): Promise<AnalyzeOutcome> {
  const { config } = args;
  const promptVersion = args.prompt?.id ?? config.promptVersion;
  const model = config.model;

  let aDataUrl: string;
  let bDataUrl: string;
  let diffDataUrl: string;
  try {
    [aDataUrl, bDataUrl, diffDataUrl] = await Promise.all([
      pngDataUrl(args.aPath),
      pngDataUrl(args.bPath),
      pngDataUrl(args.diffPath),
    ]);
  } catch (err) {
    return {
      parsed: null,
      rawText: null,
      message: `failed to read images: ${err instanceof Error ? err.message : String(err)}`,
      promptVersion,
      model,
    };
  }

  const system = args.prompt?.text ?? config.systemPrompt ?? SYSTEM_PROMPT_V1;
  const user = buildPromptUserInstruction({
    level: args.level,
    invocationReason: args.invocationReason,
    changedPixelPercentage: args.changedPixelPercentage,
    ssim: args.ssim,
  });

  const messages = [
    { role: 'system' as const, content: system },
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: user },
        { type: 'text' as const, text: 'Image A (first page):' },
        { type: 'image_url' as const, image_url: { url: aDataUrl } },
        { type: 'text' as const, text: 'Image B (second page):' },
        { type: 'image_url' as const, image_url: { url: bDataUrl } },
        { type: 'text' as const, text: 'Pixel diff (changed pixels are red):' },
        { type: 'image_url' as const, image_url: { url: diffDataUrl } },
      ],
    },
  ];

  // Path 1: strict JSON schema via response_format.
  try {
    const completion = await client.chat.completions.create({
      model,
      messages,
      response_format: { type: 'json_schema', json_schema: jsonSchemaForPrompt(system) },
      max_tokens: config.maxTokens,
      temperature: config.temperature,
    });
    const rawText = completion.choices[0]?.message?.content ?? '';
    const parsed = lmResponseSchema.safeParse(coerceLmPayload(JSON.parse(rawText)));
    if (parsed.success) {
      return {
        parsed: parsed.data,
        rawText,
        path: 'json_schema',
        promptVersion,
        model: completion.model || model,
      };
    }
    // Schema-shaped JSON but didn't match our zod even after coercion. Try the
    // tolerant path next — same call, no response_format — in case the
    // previous response was truncated or malformed.
  } catch (err) {
    // Some local models reject `response_format`. Fall through to the tolerant
    // path. We'll surface the original error if the fallback also fails.
    void err;
  }

  // Path 2: tolerant fallback — ask freely, extract the first balanced { ... }.
  try {
    const completion = await client.chat.completions.create({
      model,
      messages,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
    });
    const rawText = completion.choices[0]?.message?.content ?? '';
    const extracted = extractFirstJsonObject(rawText);
    if (!extracted) {
      return {
        parsed: null,
        rawText,
        message: 'tolerant fallback could not find a JSON object in the response',
        promptVersion,
        model: completion.model || model,
      };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(extracted);
    } catch (jsonErr) {
      return {
        parsed: null,
        rawText,
        message: `tolerant fallback found malformed JSON: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`,
        promptVersion,
        model: completion.model || model,
      };
    }
    const parsed = lmResponseSchema.safeParse(coerceLmPayload(parsedJson));
    if (parsed.success) {
      return {
        parsed: parsed.data,
        rawText,
        path: 'tolerant_extract',
        promptVersion,
        model: completion.model || model,
      };
    }
    return {
      parsed: null,
      rawText,
      message: `LM response did not match expected schema: ${parsed.error.message}`,
      promptVersion,
      model: completion.model || model,
    };
  } catch (err) {
    return {
      parsed: null,
      rawText: null,
      message: `LM Studio call failed: ${err instanceof Error ? err.message : String(err)}`,
      promptVersion,
      model,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pngDataUrl(path: string): Promise<string> {
  const buf = await readFile(path);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/**
 * Pre-process the raw JSON returned by the LM before zod validation.
 *
 * Local models often produce close-but-not-quite-right shapes:
 * - boundingBox as a 4-element array `[x, y, w, h]` instead of an object
 * - boundingBox values in pixels rather than percentages
 * - confidence outside 0..1 (e.g. expressed as 0..100)
 *
 * We coerce these into the canonical shape the schema expects. Anything that
 * still doesn't fit after coercion is dropped or flagged by zod downstream.
 */
export function coerceLmPayload(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const obj = { ...(input as Record<string, unknown>) };

  // Confidence: clamp into 0..1; if it looks like a percent (1..100), divide.
  if (typeof obj.confidence === 'number') {
    if (obj.confidence > 1 && obj.confidence <= 100) {
      obj.confidence = obj.confidence / 100;
    } else if (obj.confidence > 1) {
      obj.confidence = 1;
    } else if (obj.confidence < 0) {
      obj.confidence = 0;
    }
  }

  // Differences: normalize bounding boxes.
  if (Array.isArray(obj.differences)) {
    obj.differences = obj.differences.map((d) => coerceLmDifference(d)).filter(Boolean);
  }

  return obj;
}

function coerceLmDifference(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const d = { ...(input as Record<string, unknown>) };
  d.boundingBox = coerceBoundingBox(d.boundingBox);
  if (!d.boundingBox) return null;
  return d;
}

function coerceBoundingBox(value: unknown): { x: number; y: number; width: number; height: number } | null {
  let raw: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null = null;

  if (Array.isArray(value)) {
    if (value.length === 4 && value.every((v) => typeof v === 'number')) {
      const [x, y, width, height] = value as number[];
      raw = { x, y, width, height };
    }
  } else if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    raw = {
      x: v.x ?? v.left,
      y: v.y ?? v.top,
      width: v.width ?? v.w ?? v.right,
      height: v.height ?? v.h ?? v.bottom,
    };
  }

  if (!raw) return null;
  const nums = ['x', 'y', 'width', 'height'].map((k) => raw![k as keyof typeof raw]);
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null;
  let x = nums[0] as number;
  let y = nums[1] as number;
  let width = nums[2] as number;
  let height = nums[3] as number;

  // If any value exceeds 100, the model probably emitted pixels. Rescale by
  // the largest observed extent so the box fits in 0..100. This is a coarse
  // heuristic but better than dropping the box entirely.
  const max = Math.max(x, y, x + width, y + height);
  if (max > 100) {
    const scale = 100 / max;
    x *= scale;
    y *= scale;
    width *= scale;
    height *= scale;
  }
  return {
    x: clamp01(x),
    y: clamp01(y),
    width: clamp01(width),
    height: clamp01(height),
  };
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return Math.round(v * 1000) / 1000;
}

/**
 * Find the first balanced JSON object in `text` and return its substring.
 * Handles strings (with escapes) so braces inside strings don't confuse the
 * counter. Returns null if no balanced object is present.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Convert an LM bounding box (already 0..100) to the canonical percent shape. */
export function lmBoxToPercent(box: LmDifference['boundingBox']): BoundingBoxPercent {
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/** Re-export the union type for consumers that want it. */
export type LmSeverity = DifferenceSeverity;
