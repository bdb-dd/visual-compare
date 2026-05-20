import { appendFile } from 'node:fs/promises';

/**
 * Single-line JSON events recording GPU on/off transitions, written by
 * both the API service (powerOn after preflight bootstraps the server)
 * and the cron reaper (powerOff after the verify loop confirms the
 * instance left `running`).
 *
 * The file is the durable source of truth for "how long was the GPU
 * actually off?" — pair successive `powerOff` and `powerOn` lines and
 * sum the deltas. Writes are best-effort: an error appending the line
 * is logged and swallowed so a flaky FS never blocks the calling path.
 */

export type LmEvent =
  | { event: 'powerOn'; source: 'api' }
  | { event: 'powerOff'; source: 'reaper' };

export interface AppendLmEventOptions {
  /** Absolute path to the events file. */
  path: string;
  /** The event to record. */
  event: LmEvent;
  /** Default: Date.now. */
  now?: () => number;
  /** Default: appendFile from node:fs/promises. */
  append?: (path: string, data: string) => Promise<void>;
  /** Default: console.warn with `[lm-events]` prefix. */
  onWriteError?: (msg: string) => void;
}

export async function appendLmEvent(opts: AppendLmEventOptions): Promise<void> {
  const now = opts.now ?? Date.now;
  const append = opts.append ?? ((p, d) => appendFile(p, d, 'utf8'));
  const onError =
    opts.onWriteError ??
    // eslint-disable-next-line no-console
    ((m: string) => console.warn(`[lm-events] ${m}`));
  const line =
    JSON.stringify({
      ts: new Date(now()).toISOString(),
      ...opts.event,
    }) + '\n';
  try {
    await append(opts.path, line);
  } catch (err) {
    onError(
      `failed to append to ${opts.path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
