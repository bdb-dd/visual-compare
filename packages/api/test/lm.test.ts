import { describe, expect, it } from 'vitest';
import {
  buildPromptUserInstruction,
  coerceLmPayload,
  extractFirstJsonObject,
  lmResponseSchema,
  readLmConfigFromEnv,
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
  it('frames semantic_mode as the LM being final authority', () => {
    const text = buildPromptUserInstruction({
      level: 'semantic',
      invocationReason: 'semantic_mode',
      changedPixelPercentage: 12.3,
      ssim: 0.7,
    });
    expect(text).toMatch(/final authority/i);
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
    expect(text).toMatch(/tolerant/);
  });

  it('omits the metrics line when both are null', () => {
    const text = buildPromptUserInstruction({
      level: 'semantic',
      invocationReason: 'semantic_mode',
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
    expect(cfg.model).toBe('google/gemma-4-e2b');
    expect(cfg.promptVersion).toBe('v2');
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
