import { describe, expect, it } from 'vitest';
import {
  computeSignature,
  computeV0Signature,
  computeV1Signature,
  normalizeElementLabel,
} from '../src/services/cluster-signature.js';

describe('computeV0Signature', () => {
  it('returns a stable hash for the same input', () => {
    const bbox = { x: 10, y: 20, width: 30, height: 40 };
    const a = computeV0Signature('desktop', bbox, 'lm');
    const b = computeV0Signature('desktop', bbox, 'lm');
    expect(a).toBe(b);
  });

  it('differs across viewports', () => {
    const bbox = { x: 10, y: 20, width: 30, height: 40 };
    expect(computeV0Signature('desktop', bbox, 'lm'))
      .not.toBe(computeV0Signature('mobile', bbox, 'lm'));
  });

  it('differs across sources', () => {
    const bbox = { x: 10, y: 20, width: 30, height: 40 };
    expect(computeV0Signature('desktop', bbox, 'lm'))
      .not.toBe(computeV0Signature('desktop', bbox, 'imagick'));
  });

  it('collapses bboxes whose centroid lands in the same grid cell + size band', () => {
    // Both centroids are around (25, 40) — same 10x10 cell. Same area band.
    const a = computeV0Signature('desktop', { x: 20, y: 30, width: 10, height: 20 }, 'lm');
    const b = computeV0Signature('desktop', { x: 24, y: 36, width: 10, height: 20 }, 'lm');
    expect(a).toBe(b);
  });

  it('separates bboxes in different size bands', () => {
    const tiny = computeV0Signature('desktop', { x: 0, y: 0, width: 0.1, height: 0.1 }, 'lm');
    const huge = computeV0Signature('desktop', { x: 0, y: 0, width: 50, height: 50 }, 'lm');
    expect(tiny).not.toBe(huge);
  });
});

describe('computeV1Signature', () => {
  it('returns a stable hash for the same input', () => {
    const a = computeV1Signature('desktop', 'nav_primary', 'element_added', 'sidebar navigation');
    const b = computeV1Signature('desktop', 'nav_primary', 'element_added', 'sidebar navigation');
    expect(a).toBe(b);
  });

  it('normalises label whitespace and punctuation', () => {
    const a = computeV1Signature('desktop', 'nav_primary', 'element_added', 'sidebar navigation');
    const b = computeV1Signature('desktop', 'nav_primary', 'element_added', '  Sidebar  Navigation!  ');
    expect(a).toBe(b);
  });

  it("does not collapse synonyms — that's the prompt's job", () => {
    // The taxonomy intentionally keeps "primary sidebar nav" and "sidebar
    // navigation" as separate clusters; if the LM emits both, the inconsistency
    // is surfaced rather than hidden behind a runtime synonym map.
    const a = computeV1Signature('desktop', 'nav_primary', 'element_added', 'sidebar navigation');
    const b = computeV1Signature('desktop', 'nav_primary', 'element_added', 'primary sidebar nav');
    expect(a).not.toBe(b);
  });

  it('treats empty / "other" elementLabel as fallback signature key', () => {
    const a = computeV1Signature('desktop', 'main_content', 'other', '');
    const b = computeV1Signature('desktop', 'main_content', 'other', 'other');
    expect(a).toBe(b);
  });
});

describe('computeSignature dispatcher', () => {
  it('returns v1 when all three taxonomy fields are present', () => {
    const r = computeSignature({
      source: 'lm',
      viewport_name: 'desktop',
      bbox: { x: 0, y: 0, width: 25, height: 80 },
      change_type: 'element_added',
      region_role: 'nav_primary',
      element_label: 'sidebar navigation',
    });
    expect(r?.signature_version).toBe('v1');
  });

  it('falls back to v0 when one taxonomy field is missing', () => {
    const r = computeSignature({
      source: 'lm',
      viewport_name: 'desktop',
      bbox: { x: 0, y: 0, width: 25, height: 80 },
      change_type: 'element_added',
      region_role: 'nav_primary',
      element_label: null,
    });
    expect(r?.signature_version).toBe('v0');
  });

  it('returns null when neither bbox nor taxonomy fields are present', () => {
    const r = computeSignature({
      source: 'imagick',
      viewport_name: 'desktop',
      bbox: null,
      change_type: null,
      region_role: null,
      element_label: null,
    });
    expect(r).toBeNull();
  });
});

describe('normalizeElementLabel', () => {
  it('lowercases and trims', () => {
    expect(normalizeElementLabel('  Hero IMAGE  ')).toBe('hero image');
  });
  it('strips punctuation except hyphens and apostrophes', () => {
    expect(normalizeElementLabel('CTA: "Start service" button!')).toBe('cta start service button');
    expect(normalizeElementLabel("page's main-content")).toBe("page's main-content");
  });
  it('collapses internal whitespace', () => {
    expect(normalizeElementLabel('foo   bar\tbaz\n')).toBe('foo bar baz');
  });
});
