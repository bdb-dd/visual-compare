import { createHash } from 'node:crypto';
import type { CaptureRunOptionsParsed } from './capture.js';
import type { ViewportDef } from '../types.js';

/**
 * Stable, sorted-key JSON. Keys whose values are `undefined` are omitted so
 * that the hash is invariant under "field present but unset" vs "field
 * absent" — the canonical builder normalises both before reaching here.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') +
    '}'
  );
}

export interface CanonicalCaptureOpts {
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    orientation: ViewportDef['orientation'];
  };
  hideSelectors: string[];
  settleDelayMs: number;
  useNetworkIdle: boolean;
  fullPage: boolean;
  reducedMotion: NonNullable<CaptureRunOptionsParsed['reducedMotion']>;
  userAgent: string | null;
  locale: string | null;
  timezoneId: string | null;
  waitForSelector: string | null;
}

/**
 * Build the canonical option set for one (viewport, options) pairing.
 *
 * Only fields that affect the captured pixels go in. `viewport.name` is
 * intentionally excluded — it lives in the cache PK alongside the hash and
 * users may rename a viewport without forcing a recapture, but if its
 * dimensions or orientation change the hash will too.
 */
export function buildCanonicalCaptureOpts(
  viewport: ViewportDef,
  options: CaptureRunOptionsParsed,
): CanonicalCaptureOpts {
  return {
    viewport: {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      orientation: viewport.orientation,
    },
    hideSelectors: [...(options.hideSelectors ?? [])].sort(),
    settleDelayMs: options.settleDelayMs,
    useNetworkIdle: options.useNetworkIdle,
    fullPage: options.fullPage,
    reducedMotion: options.reducedMotion,
    userAgent: options.userAgent ?? null,
    locale: options.locale ?? null,
    timezoneId: options.timezoneId ?? null,
    waitForSelector: options.waitForSelector ?? null,
  };
}

export function hashCaptureOpts(canonical: CanonicalCaptureOpts): string {
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}

/** Convenience: build + hash in one step. */
export function captureOptsHashFor(
  viewport: ViewportDef,
  options: CaptureRunOptionsParsed,
): string {
  return hashCaptureOpts(buildCanonicalCaptureOpts(viewport, options));
}
