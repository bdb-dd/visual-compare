import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Persists the wall-clock timestamp of the last LM Studio invocation so an
 * out-of-process reaper can decide when the GPU instance has been idle
 * long enough to power off. The format is a single decimal integer (ms
 * since epoch) — small, fsync-cheap, and trivial to inspect by hand.
 *
 * Writes are best-effort: a failure here must never block an LM call.
 * The reaper treats a missing file as "never used" and powers off any
 * instance it finds running, which is the safe default.
 */

export interface LmUsageTracker {
  /** Best-effort write of `Date.now()` to the timestamp file. */
  record(): Promise<void>;
  /** Read the stored timestamp. Returns null when the file is absent or unparseable. */
  read(): Promise<number | null>;
  /** Resolved path for diagnostics / logging. */
  readonly path: string;
}

export interface CreateLmUsageTrackerOptions {
  path: string;
  /** Override `Date.now()` (used in tests). */
  now?: () => number;
  /** Called with the error message when a write fails. Default: console.warn. */
  onWriteError?: (message: string) => void;
}

export function createLmUsageTracker(opts: CreateLmUsageTrackerOptions): LmUsageTracker {
  const now = opts.now ?? (() => Date.now());
  const onWriteError =
    opts.onWriteError ??
    ((msg: string) => {
      // eslint-disable-next-line no-console
      console.warn(`[lm-usage] ${msg}`);
    });

  return {
    path: opts.path,
    async record() {
      try {
        await mkdir(dirname(opts.path), { recursive: true });
        await writeFile(opts.path, String(now()), 'utf8');
      } catch (err) {
        onWriteError(`failed to write ${opts.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    async read() {
      try {
        const text = await readFile(opts.path, 'utf8');
        const ms = Number.parseInt(text.trim(), 10);
        return Number.isFinite(ms) ? ms : null;
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
  };
}

function isEnoent(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
