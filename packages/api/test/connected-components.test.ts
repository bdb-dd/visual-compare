import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseConnectedComponents,
  pixelBoxToPercent,
} from '../src/services/connected-components.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, 'fixtures', 'connected-components');

const read = (name: string) => readFileSync(join(FIX, name), 'utf8');

describe('parseConnectedComponents (JSON, simple)', () => {
  it('parses two regions with mixed string/object geometry', () => {
    const result = parseConnectedComponents(read('simple.json'), {
      imageWidth: 1000,
      imageHeight: 1000,
    });
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "area": 1234,
          "bbox_percent": {
            "height": 4,
            "width": 24,
            "x": 5,
            "y": 10,
          },
          "bbox_pixels": {
            "height": 40,
            "width": 240,
            "x": 50,
            "y": 100,
          },
          "color": "srgba(255,0,0,1)",
          "id": 1,
        },
        {
          "area": 800,
          "bbox_percent": {
            "height": 8,
            "width": 10,
            "x": 60,
            "y": 40,
          },
          "bbox_pixels": {
            "height": 80,
            "width": 100,
            "x": 600,
            "y": 400,
          },
          "color": "srgba(0,0,255,1)",
          "id": 2,
        },
      ]
    `);
  });
});

describe('parseConnectedComponents (verbose text — real IM 7 output)', () => {
  // Captured from `magick compare -metric AE -fuzz 5% -highlight-color red
  // -lowlight-color white | -channel G -separate +channel -threshold 50% -negate
  // -connected-components 8 null:` on a real 1440x900 diff (iana home vs about).
  // The first row is the gray(0) background covering ~70% of the image and
  // must be dropped by the background heuristic.
  it('drops the dominant background and converts pixel boxes to %', () => {
    const result = parseConnectedComponents(read('simple.txt'), {
      imageWidth: 1440,
      imageHeight: 900,
      format: 'text',
    });
    expect(result.map((r) => r.area)).toEqual([190731, 174240, 3892, 2563]);
    expect(result.map((r) => r.color)).toEqual([
      'gray(255)',
      'gray(255)',
      'gray(255)',
      'gray(255)',
    ]);
    expect(result[0]).toMatchObject({
      id: 0,
      bbox_pixels: { x: 0, y: 0, width: 1440, height: 162 },
      bbox_percent: { x: 0, y: 0, width: 100, height: 18 },
    });
    expect(result[3]).toMatchObject({
      id: 693,
      bbox_pixels: { x: 534, y: 329, width: 367, height: 306 },
    });
  });

  it('handles scientific-notation areas', () => {
    const synthetic = [
      'Objects (id: bounding-box centroid area mean-color):',
      '  0: 1440x900+0+0 720.0,450.0 1.296e+06 gray(255)',
      '  1: 100x50+10+20 60.0,45.0 5.0e+03 gray(0)',
    ].join('\n');
    const result = parseConnectedComponents(synthetic, {
      imageWidth: 1440,
      imageHeight: 900,
      format: 'text',
    });
    // The 1.296e+06 region covers the entire image and is dropped as background.
    expect(result).toHaveLength(1);
    expect(result[0]?.area).toBe(5000);
  });
});

describe('parseConnectedComponents (wrapper)', () => {
  it('finds regions inside `image["connected components"]` and drops the background', () => {
    const result = parseConnectedComponents(read('wrapper.json'), {
      imageWidth: 800,
      imageHeight: 600,
    });
    // Regions remaining: 9600px (red) and 600px (green). The 480000px region
    // covering the entire image is treated as background and dropped.
    expect(result.map((r) => r.area).sort((a, b) => b - a)).toEqual([9600, 600]);
    expect(result.map((r) => r.bbox_percent)).toMatchInlineSnapshot(`
      [
        {
          "height": 13.333,
          "width": 15,
          "x": 42.5,
          "y": 43.333,
        },
        {
          "height": 3.333,
          "width": 3.75,
          "x": 87.5,
          "y": 8.333,
        },
      ]
    `);
  });
});

describe('parseConnectedComponents (noise)', () => {
  it('drops single-pixel regions and the background region', () => {
    const result = parseConnectedComponents(read('noise.json'), {
      imageWidth: 800,
      imageHeight: 600,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.area).toBe(5000);
  });
});

describe('parseConnectedComponents (empty)', () => {
  it('returns no regions for an empty array', () => {
    const result = parseConnectedComponents(read('empty.json'), {
      imageWidth: 100,
      imageHeight: 100,
    });
    expect(result).toEqual([]);
  });
});

describe('pixelBoxToPercent', () => {
  it('converts pixel coordinates to clamped percentages', () => {
    expect(pixelBoxToPercent({ x: 50, y: 100, width: 240, height: 40 }, 1000, 1000))
      .toEqual({ x: 5, y: 10, width: 24, height: 4 });
  });

  it('clamps values to 0-100', () => {
    expect(pixelBoxToPercent({ x: 0, y: 0, width: 2000, height: 2000 }, 1000, 1000))
      .toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it('throws when image dimensions are non-positive', () => {
    expect(() => pixelBoxToPercent({ x: 0, y: 0, width: 1, height: 1 }, 0, 100))
      .toThrow();
  });
});
