import { describe, expect, it } from 'vitest';
import {
  buildCanonicalCaptureOpts,
  captureOptsHashFor,
  hashCaptureOpts,
} from '../src/services/capture-opts-hash.js';
import { captureRunOptionsSchema } from '../src/services/capture.js';
import type { ViewportDef } from '../src/types.js';

const desktop: ViewportDef = {
  name: 'desktop',
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  orientation: 'landscape',
};
const desktopRenamed: ViewportDef = { ...desktop, name: 'big' };
const desktopWider: ViewportDef = { ...desktop, width: 1500 };

const baseOpts = captureRunOptionsSchema.parse({});

describe('captureOptsHashFor', () => {
  it('is deterministic for the same input', () => {
    expect(captureOptsHashFor(desktop, baseOpts)).toBe(
      captureOptsHashFor(desktop, baseOpts),
    );
  });

  it('is invariant under viewport rename when dimensions match', () => {
    expect(captureOptsHashFor(desktop, baseOpts)).toBe(
      captureOptsHashFor(desktopRenamed, baseOpts),
    );
  });

  it('changes when viewport dimensions change', () => {
    expect(captureOptsHashFor(desktop, baseOpts)).not.toBe(
      captureOptsHashFor(desktopWider, baseOpts),
    );
  });

  it('is invariant under hideSelectors reordering', () => {
    const a = captureRunOptionsSchema.parse({
      hideSelectors: ['.banner', '#cookie', 'header'],
    });
    const b = captureRunOptionsSchema.parse({
      hideSelectors: ['header', '.banner', '#cookie'],
    });
    expect(captureOptsHashFor(desktop, a)).toBe(captureOptsHashFor(desktop, b));
  });

  it('treats absent and undefined optional fields the same', () => {
    const a = captureRunOptionsSchema.parse({});
    const b = captureRunOptionsSchema.parse({
      userAgent: undefined,
      locale: undefined,
      timezoneId: undefined,
    });
    expect(captureOptsHashFor(desktop, a)).toBe(captureOptsHashFor(desktop, b));
  });

  it('changes when settleDelayMs or useNetworkIdle changes', () => {
    const slow = captureRunOptionsSchema.parse({ settleDelayMs: 1000 });
    const networkIdle = captureRunOptionsSchema.parse({ useNetworkIdle: true });
    const baseHash = captureOptsHashFor(desktop, baseOpts);
    expect(captureOptsHashFor(desktop, slow)).not.toBe(baseHash);
    expect(captureOptsHashFor(desktop, networkIdle)).not.toBe(baseHash);
  });

  it('changes when fullPage toggles', () => {
    const fp = captureRunOptionsSchema.parse({ fullPage: true });
    expect(captureOptsHashFor(desktop, fp)).not.toBe(captureOptsHashFor(desktop, baseOpts));
  });

  it('produces a 64-char hex string', () => {
    expect(captureOptsHashFor(desktop, baseOpts)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashCaptureOpts and buildCanonicalCaptureOpts compose', () => {
    expect(hashCaptureOpts(buildCanonicalCaptureOpts(desktop, baseOpts))).toBe(
      captureOptsHashFor(desktop, baseOpts),
    );
  });
});
