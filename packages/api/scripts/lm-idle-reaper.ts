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
  /** Default: console.log. */
  log?: (msg: string) => void;
  /** Default: Date.now. */
  now?: () => number;
  /** Default: read LM_LAST_USE_PATH or `<cwd>/data/lm-last-use`. */
  lastUsePathOverride?: string;
}

export async function runReaper(opts: RunReaperOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const log =
    opts.log ?? ((m: string) => console.log(`${new Date().toISOString()} [lm-idle-reaper] ${m}`));
  const now = opts.now ?? (() => Date.now());

  const idleMinutes = env.LM_IDLE_SHUTDOWN_MINUTES
    ? Number(env.LM_IDLE_SHUTDOWN_MINUTES)
    : 60;
  if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) {
    log(`invalid LM_IDLE_SHUTDOWN_MINUTES='${env.LM_IDLE_SHUTDOWN_MINUTES}'`);
    return 2;
  }
  const idleThresholdMs = idleMinutes * 60_000;

  const cfg = readScalewayGpuConfigFromEnv(env);
  if (!cfg) {
    log(
      'missing Scaleway env (SCW_GPU_ZONE, SCW_GPU_INSTANCE_ID, SCW_SECRET_KEY, LM_STUDIO_BASE_URL, LM_STUDIO_MODEL) — refusing to run',
    );
    return 2;
  }

  const lastUsePath = opts.lastUsePathOverride ?? env.LM_LAST_USE_PATH;
  if (!lastUsePath) {
    log('missing LM_LAST_USE_PATH — refusing to run');
    return 2;
  }
  const tracker = createLmUsageTracker({ path: lastUsePath });
  const lastUseMs = await tracker.read();

  const api = opts.api ?? createScalewayApi(cfg);
  let instance: ScalewayInstanceState;
  try {
    instance = await api.getInstance();
  } catch (err) {
    log(`scaleway getInstance failed: ${err instanceof Error ? err.message : String(err)}`);
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
    log(`scaleway powerOff failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  log('poweroff issued');
  return 0;
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
