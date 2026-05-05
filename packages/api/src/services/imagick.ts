import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Thin wrapper around the `magick` CLI. We deliberately do not use a
 * Node binding library — `magick` is documented to be installed system-wide
 * and the CLI surface we need is small and stable.
 */

export interface MagickResult {
  stdout: string;
  stderr: string;
  /** Exit code. `magick compare -metric AE` exits 1 when the metric is non-zero, which is *not* an error. */
  exitCode: number;
}

const DEFAULT_BIN = process.env.MAGICK_BIN || 'magick';

export interface RunMagickOptions {
  /** Allowed exit codes. Default `[0]`. `magick compare` uses 1 for "different". */
  allowExitCodes?: number[];
  bin?: string;
}

export function runMagick(args: string[], opts: RunMagickOptions = {}): Promise<MagickResult> {
  const allow = opts.allowExitCodes ?? [0];
  const bin = opts.bin ?? DEFAULT_BIN;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new Error(
            `'${bin}' was not found on PATH. Install ImageMagick 7 (e.g. \`brew install imagemagick\`) or set MAGICK_BIN.`,
          ),
        );
        return;
      }
      reject(err);
    });
    child.on('close', (code) => {
      const exitCode = code ?? -1;
      if (allow.includes(exitCode)) {
        resolve({ stdout, stderr, exitCode });
      } else {
        reject(
          new Error(
            `magick exited ${exitCode}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
      }
    });
  });
}

export interface ImageDimensions {
  width: number;
  height: number;
}

export async function getImageDimensions(path: string): Promise<ImageDimensions> {
  const { stdout } = await runMagick(['identify', '-format', '%w %h', path]);
  const [w, h] = stdout.trim().split(/\s+/).map(Number);
  if (!Number.isInteger(w) || !Number.isInteger(h) || !w || !h) {
    throw new Error(`Could not parse dimensions from \`identify\`: ${stdout}`);
  }
  return { width: w, height: h };
}

export interface AeCompareResult {
  /** Number of pixels that differ. */
  aePixels: number;
  /** Total pixel count of (each) image. */
  totalPixels: number;
  /** Always between 0 and 100. */
  changedPixelPercentage: number;
  diffImagePath: string;
  width: number;
  height: number;
}

/**
 * `magick compare -metric ...` emits two numbers: an absolute distortion
 * value and, in parentheses, a normalized 0..1 value.
 *
 *   identical:  "0 (0)"
 *   different:  "461955 (0.356447)"   (AE count, normalized fraction)
 *
 * `parseMetricLine` returns both. Callers choose whichever is meaningful for
 * the metric they ran — AE wants the count, SSIM/PSNR want the normalized.
 */
function parseMetricLine(text: string): { absolute: number; normalized: number | null } {
  const trimmed = text.trim();
  const tokens = trimmed.split(/\s+/);
  const absolute = Number(tokens[0]);
  if (!Number.isFinite(absolute)) {
    throw new Error(`magick compare produced unparseable output: "${trimmed}"`);
  }
  const parenMatch = /\(([^)]+)\)/.exec(trimmed);
  const normalized = parenMatch ? Number(parenMatch[1]) : null;
  return {
    absolute,
    normalized: normalized !== null && Number.isFinite(normalized) ? normalized : null,
  };
}

/** Returns the number of changed pixels and writes a diff image to `diffPath`. */
export async function compareAe(
  imageA: string,
  imageB: string,
  diffPath: string,
  options: { fuzzPercent?: number } = {},
): Promise<AeCompareResult> {
  await mkdir(dirname(diffPath), { recursive: true });
  const fuzz = options.fuzzPercent ?? 5;
  // Render the diff with explicit highlight/lowlight colours so the same diff
  // image can be (a) shown in the UI and (b) masked for connected-components
  // by isolating red pixels. The metric (AE count) is on stderr; exit 1 on diff.
  const result = await runMagick(
    [
      'compare',
      '-metric',
      'AE',
      '-fuzz',
      `${fuzz}%`,
      '-highlight-color',
      'red',
      '-lowlight-color',
      'white',
      imageA,
      imageB,
      diffPath,
    ],
    { allowExitCodes: [0, 1] },
  );

  const text = (result.stderr || result.stdout).trim();
  const { absolute: ae } = parseMetricLine(text);

  const dims = await getImageDimensions(diffPath);
  const totalPixels = dims.width * dims.height;
  const pct = totalPixels > 0 ? (ae / totalPixels) * 100 : 0;

  return {
    aePixels: ae,
    totalPixels,
    changedPixelPercentage: pct,
    diffImagePath: diffPath,
    width: dims.width,
    height: dims.height,
  };
}

/**
 * Returns SSIM as a similarity in 0..1 where 1 means identical.
 *
 * IM 7.1.x emits SSIM as `<absolute-distortion> (<normalized-dissimilarity>)`,
 * where the parenthesized value is in 0..1 and behaves like dissimilarity
 * (0 for identical, larger for more different). We invert it so the stored
 * value matches the plan's expectation that high = perceptually similar.
 */
export async function compareSsim(imageA: string, imageB: string): Promise<number> {
  const result = await runMagick(
    ['compare', '-metric', 'SSIM', imageA, imageB, 'null:'],
    { allowExitCodes: [0, 1] },
  );
  const text = (result.stderr || result.stdout).trim();
  const { absolute, normalized } = parseMetricLine(text);
  // For identical images IM emits "0 (0)" — both absolute and normalized are 0.
  // For different images both are non-zero (e.g. "461955 (0.140968)").
  // Treat the parenthesized number as dissimilarity in 0..1 and invert.
  const dissimilarity = normalized ?? (absolute === 0 ? 0 : 1);
  const clamped = Math.max(0, Math.min(1, dissimilarity));
  return 1 - clamped;
}

export interface ConnectedComponentsRaw {
  /** `'json'` if the JSON form succeeded, `'text'` if we fell back to verbose text. */
  format: 'json' | 'text';
  raw: string;
}

/**
 * Run connected-components on a diff image rendered with red-on-white
 * highlight/lowlight colours (see `compareAe`).
 *
 * Steps:
 * 1. Build a binary mask where changed pixels (red) become white and
 *    unchanged pixels (white) become black. We extract the green channel —
 *    pure red has G=0, pure white has G=255 — threshold and negate.
 * 2. Run 8-connectivity connected-components on the mask, dropping regions
 *    smaller than `areaThreshold` to suppress single-pixel noise.
 *
 * IM 7.1.x silently ignores `connected-components:format=json`, so we always
 * use verbose text and parse it. The JSON branch is kept for newer/older
 * versions that honour the define.
 */
export async function extractConnectedComponents(
  diffPath: string,
  options: { areaThreshold?: number } = {},
): Promise<ConnectedComponentsRaw> {
  const areaThreshold = options.areaThreshold ?? 16;

  const baseArgs = [
    diffPath,
    '-channel',
    'G',
    '-separate',
    '+channel',
    '-threshold',
    '50%',
    '-negate',
    '-define',
    `connected-components:area-threshold=${areaThreshold}`,
    '-define',
    'connected-components:verbose=true',
  ];

  // Try JSON. IM honours this define on some versions.
  try {
    const result = await runMagick([
      ...baseArgs,
      '-define',
      'connected-components:format=json',
      '-connected-components',
      '8',
      'null:',
    ]);
    const trimmed = result.stdout.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      return { format: 'json', raw: trimmed };
    }
  } catch {
    // fall through to text
  }

  const result = await runMagick([
    ...baseArgs,
    '-connected-components',
    '8',
    'null:',
  ]);
  return { format: 'text', raw: result.stdout };
}

export async function ensureFileExists(path: string): Promise<void> {
  await stat(path);
}
