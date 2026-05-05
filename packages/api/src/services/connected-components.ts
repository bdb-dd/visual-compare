import type { BoundingBoxPercent } from '../types.js';

/**
 * Parse ImageMagick connected-components output and convert each region's
 * bounding box from pixels to percentages of the source image.
 *
 * Two input formats are supported:
 *
 * 1. JSON (preferred). Produced by:
 *      magick diff.png -threshold 1% \
 *        -define connected-components:format=json \
 *        -define connected-components:verbose=true \
 *        -connected-components 8 null:
 *
 *    The shape varies slightly across ImageMagick 7.x point releases, but each
 *    region object always contains a `geometry` field shaped either as a
 *    string ("WxH+X+Y") or as an object with width/height/x/y. The parser
 *    accepts both.
 *
 * 2. Verbose text fallback (used when JSON output is unavailable on the
 *    pinned IM version). The text format prints one region per line in the
 *    form:
 *
 *       <id>:  <area>  <bbox-WxH+X+Y>  <centroid>  <colour>  ...
 *
 * Fixture-based snapshot tests under
 * `packages/api/test/fixtures/connected-components/` lock down the exact
 * shapes accepted. The parser runs **before** being wired into the
 * comparison pipeline, by design.
 */

export interface ConnectedComponent {
  id: number;
  /** Area in pixels (count of pixels in the region). */
  area: number;
  /** Bounding box in pixels. */
  bbox_pixels: { x: number; y: number; width: number; height: number };
  /** Bounding box as percent of the source image (0-100). */
  bbox_percent: BoundingBoxPercent;
  /** Hex-ish colour string, when reported by ImageMagick. */
  color?: string;
}

export interface ParseConnectedComponentsArgs {
  /** Width of the diff image in pixels. */
  imageWidth: number;
  /** Height of the diff image in pixels. */
  imageHeight: number;
  /**
   * If `format` is `'auto'`, the parser sniffs by looking for a leading `[`
   * or `{`. If neither is present it falls back to the verbose text parser.
   */
  format?: 'json' | 'text' | 'auto';
  /**
   * Treat single-pixel regions as background and drop them. Default true.
   * ImageMagick's verbose JSON output normally includes the dominant
   * background colour as a region; we want to ignore it.
   */
  filterSinglePixel?: boolean;
  /** Drop the largest region if it covers > this fraction (assumed background). */
  backgroundDropThreshold?: number;
}

export function parseConnectedComponents(
  raw: string,
  args: ParseConnectedComponentsArgs,
): ConnectedComponent[] {
  const format = args.format ?? 'auto';
  const filterSinglePixel = args.filterSinglePixel ?? true;
  const bgThreshold = args.backgroundDropThreshold ?? 0.5;

  let pixelRegions: PixelRegion[];
  if (format === 'json' || (format === 'auto' && /^\s*[\[{]/.test(raw))) {
    pixelRegions = parseJson(raw);
  } else {
    pixelRegions = parseVerboseText(raw);
  }

  if (filterSinglePixel) {
    pixelRegions = pixelRegions.filter((r) => r.area > 1);
  }

  if (pixelRegions.length > 0 && bgThreshold > 0) {
    const totalArea = args.imageWidth * args.imageHeight;
    pixelRegions.sort((a, b) => b.area - a.area);
    const largest = pixelRegions[0]!;
    if (largest.area / totalArea >= bgThreshold) {
      pixelRegions = pixelRegions.slice(1);
    }
  }

  return pixelRegions.map((r) => ({
    id: r.id,
    area: r.area,
    bbox_pixels: { x: r.x, y: r.y, width: r.width, height: r.height },
    bbox_percent: pixelBoxToPercent(r, args.imageWidth, args.imageHeight),
    color: r.color,
  }));
}

interface PixelRegion {
  id: number;
  area: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

export function pixelBoxToPercent(
  box: { x: number; y: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number,
): BoundingBoxPercent {
  if (imageWidth <= 0 || imageHeight <= 0) {
    throw new Error('imageWidth/imageHeight must be positive');
  }
  return {
    x: clamp((box.x / imageWidth) * 100),
    y: clamp((box.y / imageHeight) * 100),
    width: clamp((box.width / imageWidth) * 100),
    height: clamp((box.height / imageHeight) * 100),
  };
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return Math.round(v * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// JSON parser
// ---------------------------------------------------------------------------

function parseJson(raw: string): PixelRegion[] {
  const text = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse connected-components JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Normalize to an array of region records.
  const candidates = extractRegions(parsed);
  return candidates.map((c) => normalizeJsonRegion(c));
}

function extractRegions(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    // Either an array of regions, or an array containing a single image
    // wrapper with a `channels` / `connected components` field.
    if (parsed.length > 0 && isPlainObject(parsed[0]) && hasGeometry(parsed[0])) {
      return parsed;
    }
    // Try the wrapper shape.
    for (const entry of parsed) {
      if (!isPlainObject(entry)) continue;
      const inner = findRegionsArray(entry);
      if (inner) return inner;
    }
    return [];
  }
  if (isPlainObject(parsed)) {
    const inner = findRegionsArray(parsed);
    return inner ?? [];
  }
  return [];
}

function findRegionsArray(obj: Record<string, unknown>): unknown[] | null {
  // ImageMagick wraps results in `image.channelStatistics` /
  // `image['connected components']`-ish structures. We try a few common keys.
  const keys = [
    'connected components',
    'connectedComponents',
    'objects',
    'regions',
  ];
  for (const k of keys) {
    const val = obj[k];
    if (Array.isArray(val)) return val;
  }
  // Recurse into `image` sub-object if present.
  const image = obj.image;
  if (isPlainObject(image)) {
    return findRegionsArray(image);
  }
  return null;
}

function hasGeometry(obj: Record<string, unknown>): boolean {
  return (
    'geometry' in obj ||
    'bounding-box' in obj ||
    'boundingBox' in obj ||
    'bbox' in obj
  );
}

function normalizeJsonRegion(raw: unknown): PixelRegion {
  if (!isPlainObject(raw)) {
    throw new Error(`Expected region object, got ${typeof raw}`);
  }
  const id = toInt(raw.id ?? raw.ID ?? raw.label) ?? 0;
  const area = toInt(raw.area ?? raw['area-px'] ?? raw.count) ?? 0;
  const color =
    typeof raw.color === 'string'
      ? raw.color
      : typeof raw.colour === 'string'
        ? raw.colour
        : undefined;
  const geom = parseGeometry(
    raw.geometry ?? raw['bounding-box'] ?? raw.boundingBox ?? raw.bbox,
  );
  return { id, area, color, ...geom };
}

function parseGeometry(value: unknown): { x: number; y: number; width: number; height: number } {
  if (typeof value === 'string') {
    return parseGeometryString(value);
  }
  if (isPlainObject(value)) {
    const width = toInt(value.width ?? value.w);
    const height = toInt(value.height ?? value.h);
    const x = toInt(value.x ?? value.left ?? 0);
    const y = toInt(value.y ?? value.top ?? 0);
    if (width == null || height == null || x == null || y == null) {
      throw new Error(`Geometry object missing fields: ${JSON.stringify(value)}`);
    }
    return { width, height, x, y };
  }
  throw new Error(`Unsupported geometry value: ${JSON.stringify(value)}`);
}

const GEOMETRY_RE = /^\s*(\d+)x(\d+)(?:([+-]\d+)([+-]\d+))?\s*$/;

function parseGeometryString(s: string): { x: number; y: number; width: number; height: number } {
  const m = GEOMETRY_RE.exec(s);
  if (!m) throw new Error(`Bad geometry string: ${s}`);
  return {
    width: Number(m[1]),
    height: Number(m[2]),
    x: m[3] ? Number(m[3]) : 0,
    y: m[4] ? Number(m[4]) : 0,
  };
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Verbose text parser (fallback)
// ---------------------------------------------------------------------------

// Real ImageMagick 7.1.x output for `-define connected-components:verbose=true`:
//
//   Objects (id: bounding-box centroid area mean-color):
//     162: 1440x652+0+127 722.1,453.7 841885 gray(0)
//     2086: 644x74+195+663 557.2,701.1 1825 gray(255)
//
// Field order is `id: geometry centroid area color`. Area can be in scientific
// notation (e.g. `1.296e+06`). IDs are not guaranteed sequential — they are
// pixel-label values. The "Objects (...):" header line is skipped because it
// does not match the data shape.
const TEXT_LINE_RE =
  /^\s*(?<id>\d+)\s*:\s*(?<geom>\d+x\d+[+-]\d+[+-]\d+)\s+[\d.,+\-eE]+\s+(?<area>[\d.]+(?:[eE][+\-]?\d+)?)\s+(?<color>\S+)/;

function parseVerboseText(raw: string): PixelRegion[] {
  const out: PixelRegion[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = TEXT_LINE_RE.exec(line);
    if (!m || !m.groups) continue;
    const geom = parseGeometryString(m.groups.geom!);
    const area = Number(m.groups.area);
    if (!Number.isFinite(area)) continue;
    out.push({
      id: Number(m.groups.id),
      area: Math.round(area),
      color: m.groups.color,
      ...geom,
    });
  }
  return out;
}
