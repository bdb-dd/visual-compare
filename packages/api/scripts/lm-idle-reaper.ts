/**
 * Idle-reaper for the on-demand GPU instance hosting LM Studio.
 *
 * Designed to be invoked by cron every ~5 minutes on the API VM. Reads
 * the timestamp written by `createLmUsageTracker`, asks Scaleway for the
 * current instance state, and powers off the instance when both:
 *   1. it is currently `running`, AND
 *   2. `now() - last_use_ms >= LM_IDLE_SHUTDOWN_MINUTES`.
 *
 * A missing timestamp file is treated as "never used since the API
 * started up". The safe answer is to power off — otherwise a GPU started
 * by hand (or left running by a crashed API) would stay billing forever.
 *
 * Exit codes:
 *   0 — nothing to do, or poweroff issued successfully
 *   1 — Scaleway API error / misconfiguration
 *   2 — invalid environment
 */

import { createLmUsageTracker } from '../src/services/lm-usage.js';
import { appendLmEvent } from '../src/services/lm-events.js';
import {
  createScalewayApi,
  readScalewayGpuConfigFromEnv,
  type ScalewayApi,
  type ScalewayInstanceState,
} from '../src/services/scaleway-gpu.js';

export interface ReaperInputs {
  instance: ScalewayInstanceState;
  lastUseMs: number | null;
  nowMs: number;
  idleThresholdMs: number;
}

export type ReaperAction =
  | { kind: 'noop'; reason: string }
  | { kind: 'powerOff'; reason: string };

/**
 * Pure decision function. No IO — exported so tests can exercise the
 * matrix (state × last-use × idle-threshold) without standing up a
 * fake Scaleway.
 */
export function decideAction(inputs: ReaperInputs): ReaperAction {
  const { instance, lastUseMs, nowMs, idleThresholdMs } = inputs;
  if (instance.state !== 'running') {
    return { kind: 'noop', reason: `instance is '${instance.state}', not running` };
  }
  if (lastUseMs === null) {
    return {
      kind: 'powerOff',
      reason: 'no last-use timestamp on disk — treating as idle',
    };
  }
  const idleMs = nowMs - lastUseMs;
  if (idleMs < idleThresholdMs) {
    const remaining = Math.ceil((idleThresholdMs - idleMs) / 1000);
    return {
      kind: 'noop',
      reason: `idle for ${Math.floor(idleMs / 1000)}s, threshold ${Math.floor(idleThresholdMs / 1000)}s (powering off in ~${remaining}s)`,
    };
  }
  return {
    kind: 'powerOff',
    reason: `idle for ${Math.floor(idleMs / 1000)}s (threshold ${Math.floor(idleThresholdMs / 1000)}s)`,
  };
}

export interface RunReaperOptions {
  /** Default: read SCW_* env vars. */
  api?: ScalewayApi;
  /** Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Default: console.log with UTC timestamp. Stdout-equivalent. */
  log?: (msg: string) => void;
  /**
   * Default: console.error with UTC timestamp. Stderr-equivalent.
   * Used for conditions that warrant operator attention (Scaleway API
   * errors, verify-loop timeout, env misconfiguration). Cron entry is
   * configured so stderr lands in MAILTO instead of being swallowed
   * into the log file.
   */
  logError?: (msg: string) => void;
  /** Default: Date.now. */
  now?: () => number;
  /** Default: setTimeout-based sleep. Replace with a no-op in unit tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Default: read LM_LAST_USE_PATH or `<cwd>/data/lm-last-use`. */
  lastUsePathOverride?: string;
  /**
   * Default 90_000. Max wall-clock to wait for the instance state to
   * leave `running` after powerOff is issued. If the deadline trips
   * without a state change, the reaper logs ERROR and exits non-zero.
   */
  verifyTimeoutMs?: number;
  /** Default 5_000. Interval between post-action state polls. */
  verifyPollMs?: number;
}

export async function runReaper(opts: RunReaperOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const log =
    opts.log ?? ((m: string) => console.log(`${new Date().toISOString()} [lm-idle-reaper] ${m}`));
  const logError =
    opts.logError ??
    ((m: string) => console.error(`${new Date().toISOString()} [lm-idle-reaper] ${m}`));
  const now = opts.now ?? (() => Date.now());

  const idleMinutes = env.LM_IDLE_SHUTDOWN_MINUTES
    ? Number(env.LM_IDLE_SHUTDOWN_MINUTES)
    : 60;
  if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) {
    logError(`invalid LM_IDLE_SHUTDOWN_MINUTES='${env.LM_IDLE_SHUTDOWN_MINUTES}'`);
    return 2;
  }
  const idleThresholdMs = idleMinutes * 60_000;

  const cfg = readScalewayGpuConfigFromEnv(env);
  if (!cfg) {
    logError(
      'missing Scaleway env (SCW_GPU_ZONE, SCW_GPU_INSTANCE_ID, SCW_SECRET_KEY, LM_STUDIO_BASE_URL, LM_STUDIO_MODEL) — refusing to run',
    );
    return 2;
  }

  const lastUsePath = opts.lastUsePathOverride ?? env.LM_LAST_USE_PATH;
  if (!lastUsePath) {
    logError('missing LM_LAST_USE_PATH — refusing to run');
    return 2;
  }
  const tracker = createLmUsageTracker({ path: lastUsePath });
  const lastUseMs = await tracker.read();

  const api = opts.api ?? createScalewayApi(cfg);
  let instance: ScalewayInstanceState;
  try {
    instance = await api.getInstance();
  } catch (err) {
    logError(`scaleway getInstance failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const decision = decideAction({
    instance,
    lastUseMs,
    nowMs: now(),
    idleThresholdMs,
  });

  if (decision.kind === 'noop') {
    log(`noop: ${decision.reason}`);
    return 0;
  }

  log(`powering off: ${decision.reason}`);
  try {
    await api.powerOff();
  } catch (err) {
    logError(`scaleway powerOff failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  log('poweroff issued');

  // Closing-loop verification. Scaleway's action endpoint is asynchronous
  // — a 2xx response only means the task was queued, not that the state
  // actually transitioned. (Production observation: `poweroff` tasks sat
  // `pending` indefinitely while the instance kept billing.) Poll until
  // the instance leaves `running` or we hit the deadline.
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? 90_000;
  const verifyPollMs = opts.verifyPollMs ?? 5_000;
  const verifyDeadline = now() + verifyTimeoutMs;
  while (now() < verifyDeadline) {
    await sleep(verifyPollMs);
    let post: ScalewayInstanceState;
    try {
      post = await api.getInstance();
    } catch (err) {
      log(
        `post-poweroff getInstance failed: ${err instanceof Error ? err.message : String(err)} — retrying`,
      );
      continue;
    }
    if (post.state !== 'running') {
      log(`verified: instance state is now '${post.state}'`);
      const eventsPath = env.LM_EVENTS_PATH;
      if (eventsPath) {
        await appendLmEvent({
          path: eventsPath,
          event: { event: 'powerOff', source: 'reaper' },
        });
      }
      return 0;
    }
  }
  logError(
    `ERROR: instance still 'running' ${Math.floor(verifyTimeoutMs / 1000)}s after powerOff — action did not take effect`,
  );
  return 1;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const isDirectInvocation = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const url = new URL(import.meta.url);
    return url.pathname.endsWith(argv1) || argv1.endsWith(url.pathname.split('/').pop() ?? '');
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  runReaper().then(
    (code) => process.exit(code),
    (err) => {
      // eslint-disable-next-line no-console
      console.error(`${new Date().toISOString()} [lm-idle-reaper] uncaught:`, err);
      process.exit(1);
    },
  );
}
