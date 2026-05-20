import { describe, expect, it } from 'vitest';
import {
  buildPromptUserInstruction,
  coerceLmPayload,
  extractFirstJsonObject,
  jsonSchemaForPrompt,
  lmResponseSchema,
  LM_JSON_SCHEMA,
  LM_JSON_SCHEMA_V3,
  readLmConfigFromEnv,
  usesV1Taxonomy,
} from '../src/services/lm.js';

describe('lmResponseSchema', () => {
  it('accepts a well-formed payload', () => {
    const payload = {
      equivalent: true,
      confidence: 0.87,
      summary: 'Same content and purpose.',
      differences: [
        {
          description: 'Hero button text differs.',
          severity: 'medium' as const,
          boundingBox: { x: 12, y: 34, width: 20, height: 8 },
        },
      ],
    };
    expect(lmResponseSchema.parse(payload)).toEqual(payload);
  });

  it('rejects out-of-range confidence', () => {
    const r = lmResponseSchema.safeParse({
      equivalent: true,
      confidence: 1.5,
      summary: '...',
      differences: [],
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown severity', () => {
    const r = lmResponseSchema.safeParse({
      equivalent: false,
      confidence: 0.5,
      summary: '...',
      differences: [
        { description: 'x', severity: 'critical', boundingBox: { x: 0, y: 0, width: 1, height: 1 } },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects bounding box outside 0..100', () => {
    const r = lmResponseSchema.safeParse({
      equivalent: false,
      confidence: 0.5,
      summary: '...',
      differences: [
        { description: 'x', severity: 'low', boundingBox: { x: 0, y: 0, width: 200, height: 1 } },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('synthesizes summary from first difference when LM omits the field', () => {
    // Mirrors the failure mode some local LMs hit under strict response_format:
    // the JSON object is well-formed but `summary` is missing. coerceLmPayload
    // fills it in so zod still accepts the response.
    const raw = {
      equivalent: false,
      confidence: 0.9,
      differences: [
        {
          description: 'Breadcrumb path differs between pages.',
          severity: 'medium',
          boundingBox: { x: 10, y: 5, width: 50, height: 3 },
        },
      ],
    };
    const r = lmResponseSchema.safeParse(coerceLmPayload(raw));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.summary).toBe('Breadcrumb path differs between pages.');
    }
  });

  it('falls back to "Equivalent." when summary missing and equivalent=true', () => {
    const r = lmResponseSchema.safeParse(coerceLmPayload({
      equivalent: true,
      confidence: 0.95,
      differences: [],
    }));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.summary).toBe('Equivalent.');
    }
  });
});

describe('v1 cluster-signature taxonomy (v3 prompt)', () => {
  it('parses a v2-shaped payload (no v1 fields) unchanged', () => {
    // v2 cached responses must keep parsing — fields are .optional() in zod.
    const payload = {
      equivalent: false,
      confidence: 0.8,
      summary: 'Different.',
      differences: [
        {
          description: 'Headline differs.',
          severity: 'high' as const,
          boundingBox: { x: 10, y: 5, width: 80, height: 8 },
        },
      ],
    };
    const r = lmResponseSchema.safeParse(payload);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.differences[0]!.changeType).toBeUndefined();
      expect(r.data.differences[0]!.regionRole).toBeUndefined();
      expect(r.data.differences[0]!.elementLabel).toBeUndefined();
    }
  });

  it('parses a v3-shaped payload with the new taxonomy fields', () => {
    const payload = {
      equivalent: false,
      confidence: 0.92,
      summary: 'Sidebar nav added.',
      differences: [
        {
          description: 'A sidebar navigation menu has been added on the left side of the page.',
          severity: 'high' as const,
          boundingBox: { x: 0, y: 10, width: 22, height: 70 },
          changeType: 'element_added' as const,
          regionRole: 'nav_primary' as const,
          elementLabel: 'sidebar navigation',
        },
      ],
    };
    const r = lmResponseSchema.safeParse(payload);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.differences[0]!.changeType).toBe('element_added');
      expect(r.data.differences[0]!.regionRole).toBe('nav_primary');
      expect(r.data.differences[0]!.elementLabel).toBe('sidebar navigation');
    }
  });

  it('rejects an unknown changeType', () => {
    const r = lmResponseSchema.safeParse({
      equivalent: false,
      confidence: 0.5,
      summary: '...',
      differences: [
        {
          description: 'x',
          severity: 'low',
          boundingBox: { x: 0, y: 0, width: 1, height: 1 },
          changeType: 'not_a_real_type',
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an elementLabel over 64 chars', () => {
    const r = lmResponseSchema.safeParse({
      equivalent: false,
      confidence: 0.5,
      summary: '...',
      differences: [
        {
          description: 'x',
          severity: 'low',
          boundingBox: { x: 0, y: 0, width: 1, height: 1 },
          elementLabel: 'x'.repeat(65),
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('usesV1Taxonomy detects v3-style prompts by their canonical field names', () => {
    const v3Like = 'reply with changeType + regionRole + elementLabel per diff';
    const v2Like = 'reply with severity + boundingBox per diff';
    expect(usesV1Taxonomy(v3Like)).toBe(true);
    expect(usesV1Taxonomy(v2Like)).toBe(false);
    // Requires BOTH markers — a prompt that mentions only one doesn't count.
    expect(usesV1Taxonomy('changeType only')).toBe(false);
    expect(usesV1Taxonomy('regionRole only')).toBe(false);
  });

  it('jsonSchemaForPrompt picks v3 schema for v3-style prompts, v2 otherwise', () => {
    const v3 = 'fill in changeType and regionRole and elementLabel';
    const v2 = 'fill in severity and boundingBox';
    expect(jsonSchemaForPrompt(v3)).toBe(LM_JSON_SCHEMA_V3);
    expect(jsonSchemaForPrompt(v2)).toBe(LM_JSON_SCHEMA);
    expect(jsonSchemaForPrompt('')).toBe(LM_JSON_SCHEMA);
  });

  it('v3 strict JSON schema requires the three taxonomy fields', () => {
    const diffSchema = LM_JSON_SCHEMA_V3.schema.properties.differences.items;
    expect(diffSchema.required).toEqual(
      expect.arrayContaining(['changeType', 'regionRole', 'elementLabel']),
    );
  });
});

describe('extractFirstJsonObject', () => {
  it('returns null when no { is present', () => {
    expect(extractFirstJsonObject('just words')).toBeNull();
  });

  it('extracts a flat object', () => {
    expect(extractFirstJsonObject('prefix {"a":1} trailing')).toBe('{"a":1}');
  });

  it('extracts a nested object', () => {
    expect(extractFirstJsonObject('Here you go: {"a":{"b":[1,2,3]}, "c": true } end'))
      .toBe('{"a":{"b":[1,2,3]}, "c": true }');
  });

  it('ignores braces inside strings (with escapes)', () => {
    expect(extractFirstJsonObject('foo {"q": "a } b \\" c", "x": 1} bar'))
      .toBe('{"q": "a } b \\" c", "x": 1}');
  });

  it('returns null for unbalanced input', () => {
    expect(extractFirstJsonObject('{"a": 1')).toBeNull();
  });
});

describe('buildPromptUserInstruction', () => {
  it('frames target_level_failure as a second-pass review and includes pixel metrics', () => {
    const text = buildPromptUserInstruction({
      level: 'tolerant',
      invocationReason: 'target_level_failure',
      changedPixelPercentage: 12.3,
      ssim: 0.7,
    });
    expect(text).toMatch(/did not pass/i);
    expect(text).toMatch(/12\.300/);
    expect(text).toMatch(/0\.7000/);
  });

  it('frames ambiguous_pixel_result as a tiebreaker', () => {
    const text = buildPromptUserInstruction({
      level: 'tolerant',
      invocationReason: 'ambiguous_pixel_result',
      changedPixelPercentage: 4.7,
      ssim: 0.92,
    });
    expect(text).toMatch(/tiebreaker/i);
  });

  it('does not echo the level name in the user instruction (regression guard)', () => {
    // The LM was rationalizing around explicit project rules by anchoring
    // on the level name ("the level is tolerant, so…"). The level governs
    // whether LM is invoked, not how the LM should weigh content.
    const text = buildPromptUserInstruction({
      level: 'tolerant',
      invocationReason: 'target_level_failure',
      changedPixelPercentage: null,
      ssim: null,
    });
    expect(text).not.toMatch(/tolerant/);
    expect(text).not.toMatch(/Target equivalence level/);
  });

  it('tells the LM to apply project rules as absolute', () => {
    const text = buildPromptUserInstruction({
      level: 'tolerant',
      invocationReason: 'target_level_failure',
      changedPixelPercentage: null,
      ssim: null,
    });
    expect(text).toMatch(/project rules/i);
    expect(text).toMatch(/absolute/i);
  });

  it('omits the metrics line when both are null', () => {
    const text = buildPromptUserInstruction({
      level: 'tolerant',
      invocationReason: 'target_level_failure',
      changedPixelPercentage: null,
      ssim: null,
    });
    expect(text).not.toMatch(/Pixel metrics/);
  });
});

describe('coerceLmPayload', () => {
  it('passes a canonical payload through unchanged', () => {
    const payload = {
      equivalent: true,
      confidence: 0.5,
      summary: '...',
      differences: [
        { description: 'x', severity: 'low', boundingBox: { x: 0, y: 0, width: 50, height: 25 } },
      ],
    };
    const coerced = coerceLmPayload(payload);
    const parsed = lmResponseSchema.safeParse(coerced);
    expect(parsed.success).toBe(true);
  });

  it('coerces 4-element array bounding boxes to objects', () => {
    const coerced = coerceLmPayload({
      equivalent: false,
      confidence: 0.9,
      summary: '...',
      differences: [
        { description: 'x', severity: 'high', boundingBox: [10, 20, 30, 40] },
      ],
    });
    const parsed = lmResponseSchema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.differences[0]?.boundingBox).toEqual({ x: 10, y: 20, width: 30, height: 40 });
    }
  });

  it('rescales pixel-shaped boxes into 0..100 percentages', () => {
    // gemma-4-e2b live-call shape: pixel-ish array values for a 1440x900 image.
    const coerced = coerceLmPayload({
      equivalent: false,
      confidence: 1.0,
      summary: '...',
      differences: [
        { description: 'x', severity: 'high', boundingBox: [30, 65, 70, 840] },
      ],
    });
    const parsed = lmResponseSchema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const b = parsed.data.differences[0]!.boundingBox;
      // After rescaling so max(x+w, y+h) == 100: largest extent was y+height=905 → scale=100/905
      // width=70, height=840 → height*100/905 ≈ 92.8
      expect(b.x).toBeLessThanOrEqual(100);
      expect(b.y).toBeLessThanOrEqual(100);
      expect(b.width).toBeLessThanOrEqual(100);
      expect(b.height).toBeLessThanOrEqual(100);
      expect(b.height).toBeGreaterThan(50);
    }
  });

  it('rescales 0..100 confidence outside the strict band', () => {
    const coerced = coerceLmPayload({ equivalent: true, confidence: 87, summary: '', differences: [] });
    expect((coerced as { confidence: number }).confidence).toBeCloseTo(0.87, 2);
  });

  it('drops differences whose bounding box is unrecoverable', () => {
    const coerced = coerceLmPayload({
      equivalent: false,
      confidence: 0.5,
      summary: '...',
      differences: [
        { description: 'good', severity: 'low', boundingBox: { x: 0, y: 0, width: 1, height: 1 } },
        { description: 'bad', severity: 'low', boundingBox: 'not-a-box' },
      ],
    });
    expect(((coerced as { differences: unknown[] }).differences).length).toBe(1);
  });
});

describe('readLmConfigFromEnv', () => {
  it('returns the documented defaults when env is empty', () => {
    const cfg = readLmConfigFromEnv({});
    expect(cfg.baseURL).toBe('http://localhost:1234/v1');
    expect(cfg.model).toBe('google/gemma-4-26b-a4b');
    // DEFAULT_PROMPT_VERSION bumped to 'v3' with the v1-taxonomy prompt cutover.
    expect(cfg.promptVersion).toBe('v3');
    expect(cfg.temperature).toBe(0.1);
  });

  it('respects overrides', () => {
    const cfg = readLmConfigFromEnv({
      LM_STUDIO_BASE_URL: 'http://example:1235/v1',
      LM_STUDIO_MODEL: 'qwen3-vl-8b-norwegian',
      LM_STUDIO_PROMPT_VERSION: 'v2',
      LM_STUDIO_TEMPERATURE: '0',
    });
    expect(cfg.baseURL).toBe('http://example:1235/v1');
    expect(cfg.model).toBe('qwen3-vl-8b-norwegian');
    expect(cfg.promptVersion).toBe('v2');
    expect(cfg.temperature).toBe(0);
  });
});
