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

/** Returns the number of changed pixels and writes a diff image to `diffPath`. */
export async function compareAe(
  imageA: string,
  imageB: string,
  diffPath: string,
  options: { fuzzPercent?: number } = {},
): Promise<AeCompareResult> {
  await mkdir(dirname(diffPath), { recursive: true });
  const fuzz = options.fuzzPercent ?? 5;
  // `magick compare` writes the AE count to stderr and exits 1 if pixels differ.
  const result = await runMagick(
    [
      'compare',
      '-metric',
      'AE',
      '-fuzz',
      `${fuzz}%`,
      imageA,
      imageB,
      diffPath,
    ],
    { allowExitCodes: [0, 1] },
  );

  // The metric value is on stderr (sometimes stdout depending on version).
  const text = (result.stderr || result.stdout).trim();
  const ae = Number(text.split(/\s+/)[0]);
  if (!Number.isFinite(ae)) {
    throw new Error(`compare -metric AE produced unparseable output: "${text}"`);
  }

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
 * Returns SSIM (0-1, higher = more similar). Uses `magick compare -metric SSIM`,
 * which prints the value to stderr.
 */
export async function compareSsim(imageA: string, imageB: string): Promise<number> {
  const result = await runMagick(
    ['compare', '-metric', 'SSIM', imageA, imageB, 'null:'],
    { allowExitCodes: [0, 1] },
  );
  const text = (result.stderr || result.stdout).trim();
  const value = Number(text.split(/\s+/)[0]);
  if (!Number.isFinite(value)) {
    throw new Error(`compare -metric SSIM produced unparseable output: "${text}"`);
  }
  return value;
}

export interface ConnectedComponentsRaw {
  /** `'json'` if the JSON form succeeded, `'text'` if we fell back to verbose text. */
  format: 'json' | 'text';
  raw: string;
}

/**
 * Run connected-components on a diff image. Prefers JSON output; falls back to
 * verbose text if the pinned ImageMagick version doesn't support `format=json`
 * for connected-components.
 */
export async function extractConnectedComponents(
  diffPath: string,
  options: { thresholdPercent?: number } = {},
): Promise<ConnectedComponentsRaw> {
  const threshold = options.thresholdPercent ?? 1;
  // Try JSON.
  try {
    const result = await runMagick(
      [
        diffPath,
        '-threshold',
        `${threshold}%`,
        '-define',
        'connected-components:format=json',
        '-define',
        'connected-components:verbose=true',
        '-connected-components',
        '8',
        'null:',
      ],
    );
    const trimmed = result.stdout.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      return { format: 'json', raw: trimmed };
    }
  } catch {
    // fall through
  }
  // Verbose text fallback.
  const result = await runMagick([
    diffPath,
    '-threshold',
    `${threshold}%`,
    '-define',
    'connected-components:verbose=true',
    '-connected-components',
    '8',
    'null:',
  ]);
  return { format: 'text', raw: result.stdout };
}

export async function ensureFileExists(path: string): Promise<void> {
  await stat(path);
}
