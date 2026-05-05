import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import OpenAI from 'openai';
import type { BoundingBoxPercent, DifferenceSeverity, EquivalenceLevelId } from '../types.js';

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

// ---------------------------------------------------------------------------
// Prompt builder (versioned).
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT_VERSION = 'v2';

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
  invocationReason: 'semantic_mode' | 'ambiguous_pixel_result' | 'manual_retry';
  changedPixelPercentage: number | null;
  ssim: number | null;
}

export function buildPromptUserInstruction(input: BuildPromptInput): string {
  const { level, invocationReason } = input;
  const ctx: string[] = [];
  if (input.changedPixelPercentage !== null) {
    ctx.push(`changed pixel %: ${input.changedPixelPercentage.toFixed(3)}`);
  }
  if (input.ssim !== null) {
    ctx.push(`SSIM (0..1, 1 = identical): ${input.ssim.toFixed(4)}`);
  }
  const ctxLine = ctx.length ? ` Pixel metrics: ${ctx.join(', ')}.` : '';

  if (invocationReason === 'semantic_mode') {
    return `Equivalence level requested: "${level}". You are the final authority on equivalence — pixel metrics are informational only.${ctxLine} Compare the two pages and reply per the schema.`;
  }
  if (invocationReason === 'ambiguous_pixel_result') {
    return `Equivalence level requested: "${level}". The pixel-level comparison landed inside the ambiguity band, so you are the tiebreaker.${ctxLine} Decide whether these pages are equivalent at this level and reply per the schema.`;
  }
  return `Equivalence level requested: "${level}". Manual retry — reply per the schema.${ctxLine}`;
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
}

export function readLmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LmConfig {
  return {
    baseURL: env.LM_STUDIO_BASE_URL ?? 'http://localhost:1234/v1',
    apiKey: env.LM_STUDIO_API_KEY ?? 'lm-studio',
    model: env.LM_STUDIO_MODEL ?? 'google/gemma-4-e2b',
    promptVersion: env.LM_STUDIO_PROMPT_VERSION ?? DEFAULT_PROMPT_VERSION,
    maxTokens: env.LM_STUDIO_MAX_TOKENS ? Number(env.LM_STUDIO_MAX_TOKENS) : 1024,
    temperature: env.LM_STUDIO_TEMPERATURE ? Number(env.LM_STUDIO_TEMPERATURE) : 0.1,
    timeoutSeconds: env.LM_STUDIO_TIMEOUT_SECONDS ? Number(env.LM_STUDIO_TIMEOUT_SECONDS) : 240,
  };
}

export interface AnalyzeArgs {
  config: LmConfig;
  aPath: string;
  bPath: string;
  diffPath: string;
  level: EquivalenceLevelId;
  invocationReason: 'semantic_mode' | 'ambiguous_pixel_result' | 'manual_retry';
  changedPixelPercentage: number | null;
  ssim: number | null;
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

export interface LmClient {
  analyze(args: Omit<AnalyzeArgs, 'config'>): Promise<AnalyzeOutcome>;
}

/**
 * Creates an OpenAI-compatible client pointed at LM Studio. Returns a small
 * `analyze` interface so the comparison pipeline doesn't have to know about
 * the OpenAI SDK directly.
 */
export function createLmClient(config: LmConfig): LmClient {
  const client = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    timeout: (config.timeoutSeconds ?? 240) * 1000,
    maxRetries: 0,
  });

  return {
    analyze: (args) => analyze({ config, ...args }, client),
  };
}

async function analyze(args: AnalyzeArgs, client: OpenAI): Promise<AnalyzeOutcome> {
  const { config } = args;
  const promptVersion = config.promptVersion;
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

  const system = config.systemPrompt ?? SYSTEM_PROMPT_V1;
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
      response_format: { type: 'json_schema', json_schema: LM_JSON_SCHEMA },
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
