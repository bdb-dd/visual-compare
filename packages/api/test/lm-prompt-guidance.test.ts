import { describe, expect, it } from 'vitest';
import {
  assemblePromptText,
  EMPTY_GUIDANCE,
  isGuidanceEmpty,
  parseGuidanceJson,
  promptGuidanceSchema,
  serialiseGuidance,
  TOGGLE_KIND,
  type PromptGuidance,
} from '../src/services/lm-prompt-guidance.js';

const BASE = 'You are a helpful assistant.';

describe('assemblePromptText', () => {
  it('returns the base verbatim when guidance is empty', () => {
    expect(assemblePromptText(BASE, EMPTY_GUIDANCE)).toBe(BASE);
  });

  it('returns base verbatim when toggles are explicitly false and rules are empty strings', () => {
    const g: PromptGuidance = {
      toggles: { language_must_match: false, ignore_chrome_only_diffs: false },
      house_rules: { scope: ['  ', ''], trigger: [''] },
    };
    expect(assemblePromptText(BASE, g)).toBe(BASE);
  });

  it('emits Step 1 and Step 2 when both have rules', () => {
    const g: PromptGuidance = {
      toggles: { language_must_match: true, ignore_chrome_only_diffs: true },
      house_rules: { scope: [], trigger: [] },
    };
    const out = assemblePromptText(BASE, g);
    expect(out).toContain('## Project rules — apply in order');
    expect(out).toContain('### Step 1 — Regions to exclude');
    expect(out).toContain('### Step 2 — Equivalence triggers');
    // Section headers ordered correctly.
    expect(out.indexOf('### Step 1')).toBeLessThan(out.indexOf('### Step 2'));
    // Chrome (scope) appears under Step 1, language (trigger) under Step 2.
    const step1Block = out.slice(out.indexOf('### Step 1'), out.indexOf('### Step 2'));
    const step2Block = out.slice(out.indexOf('### Step 2'));
    expect(step1Block).toMatch(/banner/);
    expect(step2Block).toMatch(/one human language/);
  });

  it('emits Step 1 only when there are no triggers', () => {
    const g: PromptGuidance = {
      toggles: { ignore_chrome_only_diffs: true },
      house_rules: { scope: [], trigger: [] },
    };
    const out = assemblePromptText(BASE, g);
    expect(out).toContain('### Step 1 — Regions to exclude');
    expect(out).not.toContain('### Step 2');
    expect(out).not.toContain('Equivalence triggers');
  });

  it('emits a flat triggers section when there are no scope rules', () => {
    const g: PromptGuidance = {
      toggles: { language_must_match: true },
      house_rules: { scope: [], trigger: [] },
    };
    const out = assemblePromptText(BASE, g);
    expect(out).not.toContain('### Step 1');
    expect(out).not.toContain('### Step 2');
    // The triggers header drops the "regions remaining after Step 1" framing
    // so the LM doesn't reason about a stage that doesn't exist.
    expect(out).toContain('### Equivalence triggers');
    expect(out).toMatch(/Set equivalent=false if ANY/);
  });

  it('appends scope and trigger house rules under their respective steps', () => {
    const g: PromptGuidance = {
      toggles: {},
      house_rules: {
        scope: ['Cookie banner overlays'],
        trigger: ['Hero headline must be identical'],
      },
    };
    const out = assemblePromptText(BASE, g);
    const step1 = out.slice(out.indexOf('### Step 1'), out.indexOf('### Step 2'));
    const step2 = out.slice(out.indexOf('### Step 2'));
    expect(step1).toContain('- Cookie banner overlays');
    expect(step2).toContain('- Hero headline must be identical');
  });

  it('produces deterministic output for the same input (cache-key stability)', () => {
    const g: PromptGuidance = {
      toggles: { language_must_match: true, ignore_chrome_only_diffs: true },
      house_rules: { scope: ['s1', 's2'], trigger: ['t1', 't2'] },
    };
    expect(assemblePromptText(BASE, g)).toBe(assemblePromptText(BASE, g));
  });
});

describe('TOGGLE_KIND', () => {
  it('classifies each toggle as scope or trigger', () => {
    expect(TOGGLE_KIND.ignore_chrome_only_diffs).toBe('scope');
    expect(TOGGLE_KIND.language_must_match).toBe('trigger');
    expect(TOGGLE_KIND.flag_added_removed_content).toBe('trigger');
  });
});

describe('isGuidanceEmpty', () => {
  it('true for the EMPTY_GUIDANCE singleton', () => {
    expect(isGuidanceEmpty(EMPTY_GUIDANCE)).toBe(true);
  });
  it('true when toggles all false and both rule arrays whitespace-only', () => {
    expect(
      isGuidanceEmpty({
        toggles: { language_must_match: false },
        house_rules: { scope: [' ', ''], trigger: [''] },
      }),
    ).toBe(true);
  });
  it('false when any toggle is true', () => {
    expect(
      isGuidanceEmpty({
        toggles: { language_must_match: true },
        house_rules: { scope: [], trigger: [] },
      }),
    ).toBe(false);
  });
  it('false when any non-blank scope rule exists', () => {
    expect(
      isGuidanceEmpty({ toggles: {}, house_rules: { scope: ['x'], trigger: [] } }),
    ).toBe(false);
  });
  it('false when any non-blank trigger rule exists', () => {
    expect(
      isGuidanceEmpty({ toggles: {}, house_rules: { scope: [], trigger: ['x'] } }),
    ).toBe(false);
  });
});

describe('parseGuidanceJson', () => {
  it('returns null for null input (advanced mode)', () => {
    expect(parseGuidanceJson(null)).toBeNull();
  });
  it('returns null for malformed JSON', () => {
    expect(parseGuidanceJson('{not json')).toBeNull();
  });
  it('returns null for shape that fails validation', () => {
    expect(parseGuidanceJson(JSON.stringify({ toggles: 'oops' }))).toBeNull();
  });
  it('round-trips a valid serialised guidance', () => {
    const g: PromptGuidance = {
      toggles: { language_must_match: true },
      house_rules: { scope: ['region'], trigger: ['rule'] },
    };
    const back = parseGuidanceJson(serialiseGuidance(g));
    expect(back).toEqual(g);
  });
  it('rejects unknown toggle keys (strict)', () => {
    expect(
      parseGuidanceJson(
        JSON.stringify({ toggles: { bogus: true }, house_rules: { scope: [], trigger: [] } }),
      ),
    ).toBeNull();
  });

  it('parses the legacy string[] house_rules shape and routes them to triggers', () => {
    const legacy = JSON.stringify({ toggles: {}, house_rules: ['old rule'] });
    const parsed = parseGuidanceJson(legacy);
    expect(parsed).toEqual({
      toggles: {},
      house_rules: { scope: [], trigger: ['old rule'] },
    });
  });

  it('parses the legacy empty-array house_rules shape as both arrays empty', () => {
    const legacy = JSON.stringify({ toggles: {}, house_rules: [] });
    const parsed = parseGuidanceJson(legacy);
    expect(parsed).toEqual({ toggles: {}, house_rules: { scope: [], trigger: [] } });
  });
});

describe('promptGuidanceSchema', () => {
  it('defaults missing fields', () => {
    const parsed = promptGuidanceSchema.parse({});
    expect(parsed).toEqual({ toggles: {}, house_rules: { scope: [], trigger: [] } });
  });
  it('caps each rule list independently', () => {
    const tooMany = {
      toggles: {},
      house_rules: { scope: Array(11).fill('x'), trigger: [] },
    };
    expect(() => promptGuidanceSchema.parse(tooMany)).toThrow();
  });
});
