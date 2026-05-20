import { spawn } from 'node:child_process';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

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
const DEFAULT_TIMEOUT_MS = Number(process.env.MAGICK_TIMEOUT_MS ?? 60_000);
const DEFAULT_RETRIES = Number(process.env.MAGICK_RETRIES ?? 1);
/**
 * Niceness applied to spawned `magick` processes. Positive values
 * deprioritize IM relative to the Node API process, which keeps the event
 * loop and HTTP responses responsive even when comparisons are saturating
 * the CPU. 0 (default) leaves scheduling unchanged. Range is OS-dependent
 * (Linux/macOS: -20..19; higher = lower priority).
 *
 * Only applied when the binary is the default `magick` — tests that
 * substitute their own `bin` (e.g. `/bin/sleep`, `/usr/bin/printenv`) are
 * untouched so timing assertions stay deterministic.
 */
const DEFAULT_NICE = Number(process.env.MAGICK_NICE ?? 0);
/** Resolved at module load so we don't probe the filesystem per spawn. */
const NICE_BIN = process.env.NICE_BIN || '/usr/bin/nice';

/**
 * IM resource limits applied to every spawned `magick` call (unless the
 * caller's environment already sets them). The defaults exist to prevent
 * the failure mode we observed in production: when the host got memory-
 * constrained, IM silently fell back to spooling its image cache to disk,
 * which made comparisons run 50–150× slower without erroring. Capping the
 * disk-cache budget makes IM fail loudly instead — at which point the
 * timeout-and-retry path picks it up.
 */
const DEFAULT_MAGICK_ENV: Record<string, string> = {
  MAGICK_MEMORY_LIMIT: '1GiB',
  MAGICK_DISK_LIMIT: '2GiB',
};

export interface RunMagickOptions {
  /** Allowed exit codes. Default `[0]`. `magick compare` uses 1 for "different". */
  allowExitCodes?: number[];
  bin?: string;
  /**
   * SIGKILL the magick process after this many ms. Default 60s (env-
   * overridable via `MAGICK_TIMEOUT_MS`). 0 disables the timeout entirely.
   * The 60s default is comfortably above the p99 of healthy fast-path
   * comparisons (~2s) but bounds the pathological "stuck for 30 min"
   * cases we saw under memory pressure.
   */
  timeoutMs?: number;
  /**
   * How many times to retry on timeout. Default 1 (so up to 2 attempts
   * total). Non-timeout errors are surfaced immediately, no retry.
   */
  retriesOnTimeout?: number;
}

export class MagickTimeoutError extends Error {
  readonly code = 'MAGICK_TIMEOUT' as const;
  constructor(timeoutMs: number, args: string[]) {
    super(
      `magick timed out after ${timeoutMs}ms: ${args.slice(0, 6).join(' ')}${args.length > 6 ? ' …' : ''}`,
    );
    this.name = 'MagickTimeoutError';
  }
}

export async function runMagick(args: string[], opts: RunMagickOptions = {}): Promise<MagickResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retriesOnTimeout ?? DEFAULT_RETRIES;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await runMagickOnce(args, opts, timeoutMs);
    } catch (err) {
      if (err instanceof MagickTimeoutError && attempt < retries) {
        lastErr = err;
        // eslint-disable-next-line no-console
        console.warn(
          `[magick] timeout, retry ${attempt + 1}/${retries}: ${args.slice(0, 4).join(' ')}`,
        );
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error('magick: unreachable retry loop');
}

function runMagickOnce(
  args: string[],
  opts: RunMagickOptions,
  timeoutMs: number,
): Promise<MagickResult> {
  const allow = opts.allowExitCodes ?? [0];
  const bin = opts.bin ?? DEFAULT_BIN;
  return new Promise((resolve, reject) => {
    // Fill in IM resource limits unless caller's env already set them. We
    // copy from process.env so PATH and friends still propagate.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(DEFAULT_MAGICK_ENV)) {
      if (!env[k]) env[k] = v;
    }
    // detached: true puts the child in its own process group. On timeout we
    // SIGKILL the whole group (process.kill(-pid)), which catches helper
    // workers magick spawns internally (e.g. for HDRI ops). Without this,
    // killing only the magick parent leaves orphans that keep the stdout
    // pipe open and the 'close' event never fires — the timeout would
    // appear to hang forever.
    //
    // When MAGICK_NICE>0 and the caller hasn't overridden the binary, run
    // magick under `nice -n N` so it competes for CPU at a lower priority
    // than the Node API process. The `nice` wrapper inherits the same
    // process group via detached: true, so the SIGKILL-by-pgid path still
    // tears down the whole subtree (nice + magick + helpers) on timeout.
    const useNice = DEFAULT_NICE > 0 && bin === DEFAULT_BIN;
    const spawnBin = useNice ? NICE_BIN : bin;
    const spawnArgs = useNice ? ['-n', String(DEFAULT_NICE), bin, ...args] : args;
    const child = spawn(spawnBin, spawnArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            // Negative pid kills the entire process group. EPERM/ESRCH on a
            // race (child already exited) is benign.
            try {
              if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
            } catch {
              /* already gone */
            }
          }, timeoutMs)
        : null;

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (useNice) {
          reject(
            new Error(
              `'${NICE_BIN}' was not found. MAGICK_NICE is set but the nice binary is missing; unset MAGICK_NICE or set NICE_BIN to an absolute path.`,
            ),
          );
        } else {
          reject(
            new Error(
              `'${bin}' was not found on PATH. Install ImageMagick 7 (e.g. \`brew install imagemagick\`) or set MAGICK_BIN.`,
            ),
          );
        }
        return;
      }
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new MagickTimeoutError(timeoutMs, args));
        return;
      }
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

/**
 * Returns the number of changed pixels and writes a diff image to `diffPath`.
 *
 * **Tolerance for sub-pixel shifts.** Two rendering quirks make raw pixel
 * comparison too noisy at looser equivalence levels:
 *
 *   1. Anti-aliasing differs subtly between renders even when content is
 *      identical. `-fuzz` absorbs small per-channel colour deltas.
 *   2. Whole regions of text shift 1–3 pixels between renders (font hinting,
 *      layout reflow). Pixel-exact compare flags every glyph edge twice —
 *      once where the old text was and once where the new text is —
 *      producing the "ghost text" wall-of-red pattern. Pre-blurring both
 *      inputs softens edges so a small spatial shift no longer registers as
 *      a per-pixel difference.
 *
 * Tolerance is **caller-driven**: each session's target equivalence level
 * carries a `tolerance: { fuzzPercent, blurSigma }`, and the comparison
 * pipeline passes those values here. Defaults are conservative (fuzz=5%,
 * blur=0) so callers that don't pass tolerance get strict-level behaviour.
 *
 * `magick compare` doesn't accept inline operators on its inputs, so the blur
 * step writes both inputs to temporary MIFF files first and feeds those into
 * compare. The temp files are cleaned up before returning.
 */
export async function compareAe(
  imageA: string,
  imageB: string,
  diffPath: string,
  options: { fuzzPercent?: number; blurSigma?: number } = {},
): Promise<AeCompareResult> {
  await mkdir(dirname(diffPath), { recursive: true });
  const fuzz = options.fuzzPercent ?? 5;
  const blurSigma = options.blurSigma ?? 0;

  const tempDir = join(tmpdir(), 'visual-compare-blurred');
  await mkdir(tempDir, { recursive: true });
  const runId = randomUUID();
  const blurredA = blurSigma > 0 ? join(tempDir, `${runId}-a.miff`) : imageA;
  const blurredB = blurSigma > 0 ? join(tempDir, `${runId}-b.miff`) : imageB;

  try {
    if (blurSigma > 0) {
      await Promise.all([
        runMagick([imageA, '-blur', `0x${blurSigma}`, blurredA]),
        runMagick([imageB, '-blur', `0x${blurSigma}`, blurredB]),
      ]);
    }

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
        blurredA,
        blurredB,
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
  } finally {
    if (blurSigma > 0) {
      await Promise.all([
        unlink(blurredA).catch(() => {}),
        unlink(blurredB).catch(() => {}),
      ]);
    }
  }
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
 * 2. Apply a morphological close to merge adjacent diff pixels into solid
 *    blobs. Even after `compareAe`'s pre-blur, glyph-edge differences leave
 *    fragmented specks; closing gives one region per visually-grouped
 *    change instead of dozens of tiny ones.
 * 3. Run 8-connectivity connected-components on the cleaned mask, dropping
 *    regions smaller than `areaThreshold` to suppress remaining noise.
 *
 * IM 7.1.x silently ignores `connected-components:format=json`, so we always
 * use verbose text and parse it. The JSON branch is kept for newer/older
 * versions that honour the define.
 */
export async function extractConnectedComponents(
  diffPath: string,
  options: { areaThreshold?: number; closeKernel?: string } = {},
): Promise<ConnectedComponentsRaw> {
  const areaThreshold = options.areaThreshold ?? 32;
  const closeKernel = options.closeKernel ?? 'Disk:2';

  const baseArgs = [
    diffPath,
    '-channel',
    'G',
    '-separate',
    '+channel',
    '-threshold',
    '50%',
    '-negate',
    ...(closeKernel ? ['-morphology', 'Close', closeKernel] : []),
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
