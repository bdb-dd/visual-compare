import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideAction, runReaper } from '../scripts/lm-idle-reaper.js';
import type {
  ScalewayApi,
  ScalewayInstanceState,
} from '../src/services/scaleway-gpu.js';

// ---------------------------------------------------------------------------
// decideAction — pure decision logic
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60_000;

describe('decideAction', () => {
  it('no-ops when the instance is not running', () => {
    for (const state of ['stopped', 'stopping', 'starting', 'locked', 'unknown'] as const) {
      const r = decideAction({
        instance: { state, publicIp: null } satisfies ScalewayInstanceState,
        lastUseMs: Date.now(),
        nowMs: Date.now(),
        idleThresholdMs: HOUR_MS,
      });
      expect(r.kind).toBe('noop');
      expect(r.reason).toContain(state);
    }
  });

  it('powers off when running with no last-use timestamp on disk', () => {
    const r = decideAction({
      instance: { state: 'running', publicIp: null },
      lastUseMs: null,
      nowMs: 1_000_000,
      idleThresholdMs: HOUR_MS,
    });
    expect(r.kind).toBe('powerOff');
  });

  it('no-ops when running but within the idle window', () => {
    const now = 10_000_000;
    const r = decideAction({
      instance: { state: 'running', publicIp: null },
      lastUseMs: now - 30 * 60_000, // 30 min ago, threshold 60 min
      nowMs: now,
      idleThresholdMs: HOUR_MS,
    });
    expect(r.kind).toBe('noop');
    expect(r.reason).toMatch(/threshold/);
  });

  it('powers off when running and last use is older than the threshold', () => {
    const now = 10_000_000;
    const r = decideAction({
      instance: { state: 'running', publicIp: null },
      lastUseMs: now - 2 * HOUR_MS,
      nowMs: now,
      idleThresholdMs: HOUR_MS,
    });
    expect(r.kind).toBe('powerOff');
    expect(r.reason).toMatch(/idle for/);
  });
});

// ---------------------------------------------------------------------------
// runReaper — orchestration with a fake Scaleway API
// ---------------------------------------------------------------------------

interface FakeApiHandle {
  api: ScalewayApi;
  readonly powerOffCalls: number;
  readonly powerOnCalls: number;
}

interface FakeApiOptions {
  /**
   * Default true. If true, powerOff() flips the reported state to
   * 'stopped in place' (simulating a working hypervisor halt). If false,
   * powerOff() returns ok but the state remains unchanged — modelling
   * the observed-in-production failure mode where the Scaleway task is
   * accepted but never takes effect.
   */
  transitionOnPowerOff?: boolean;
}

function fakeApi(
  initial: ScalewayInstanceState['state'],
  opts: FakeApiOptions = {},
): FakeApiHandle {
  const transition = opts.transitionOnPowerOff ?? true;
  const counters = { powerOffCalls: 0, powerOnCalls: 0 };
  let state = initial;
  const api: ScalewayApi = {
    async getInstance() {
      return { state, publicIp: null };
    },
    async powerOn() {
      counters.powerOnCalls++;
      state = 'running';
    },
    async powerOff() {
      counters.powerOffCalls++;
      if (transition) state = 'stopped in place';
    },
  };
  return {
    api,
    get powerOffCalls() {
      return counters.powerOffCalls;
    },
    get powerOnCalls() {
      return counters.powerOnCalls;
    },
  };
}

const noSleep = async () => {};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reaper-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    SCW_GPU_ZONE: 'fr-par-2',
    SCW_GPU_INSTANCE_ID: 'i',
    SCW_SECRET_KEY: 'k',
    LM_STUDIO_BASE_URL: 'http://lm:1234/v1',
    LM_STUDIO_MODEL: 'm',
    LM_LAST_USE_PATH: join(dir, 'last'),
    LM_IDLE_SHUTDOWN_MINUTES: '60',
    ...extra,
  };
}

describe('runReaper', () => {
  it('returns 2 and refuses to act when Scaleway env is missing', async () => {
    const errors: string[] = [];
    const code = await runReaper({
      env: { LM_LAST_USE_PATH: join(dir, 'last') },
      log: () => {},
      logError: (m) => errors.push(m),
    });
    expect(code).toBe(2);
    expect(errors.join('\n')).toMatch(/missing Scaleway env/);
  });

  it('returns 2 when LM_LAST_USE_PATH is unset', async () => {
    const env = baseEnv();
    delete env.LM_LAST_USE_PATH;
    const code = await runReaper({ env, log: () => {}, logError: () => {} });
    expect(code).toBe(2);
  });

  it('powers off when running and idle longer than the threshold', async () => {
    const lastUseMs = Date.now() - 2 * HOUR_MS;
    await writeFile(join(dir, 'last'), String(lastUseMs), 'utf8');
    const handle = fakeApi('running');
    const code = await runReaper({
      env: baseEnv(),
      api: handle.api,
      log: () => {},
      logError: () => {},
      sleep: noSleep,
    });
    expect(code).toBe(0);
    expect(handle.powerOffCalls).toBe(1);
  });

  it('does not power off when within the idle window', async () => {
    const lastUseMs = Date.now() - 5 * 60_000;
    await writeFile(join(dir, 'last'), String(lastUseMs), 'utf8');
    const handle = fakeApi('running');
    const code = await runReaper({
      env: baseEnv(),
      api: handle.api,
      log: () => {},
      logError: () => {},
      sleep: noSleep,
    });
    expect(code).toBe(0);
    expect(handle.powerOffCalls).toBe(0);
  });

  it('does not power off a stopped instance', async () => {
    const handle = fakeApi('stopped');
    const code = await runReaper({
      env: baseEnv(),
      api: handle.api,
      log: () => {},
      logError: () => {},
      sleep: noSleep,
    });
    expect(code).toBe(0);
    expect(handle.powerOffCalls).toBe(0);
  });

  it('returns 1 when getInstance throws', async () => {
    const api: ScalewayApi = {
      async getInstance() {
        throw new Error('boom');
      },
      async powerOn() {},
      async powerOff() {},
    };
    const code = await runReaper({
      env: baseEnv(),
      api,
      log: () => {},
      logError: () => {},
      sleep: noSleep,
    });
    expect(code).toBe(1);
  });

  it('logs the verified state and returns 0 when powerOff causes state to leave running', async () => {
    const lastUseMs = Date.now() - 2 * HOUR_MS;
    await writeFile(join(dir, 'last'), String(lastUseMs), 'utf8');
    const handle = fakeApi('running'); // transitionOnPowerOff defaults to true
    const logs: string[] = [];
    const code = await runReaper({
      env: baseEnv(),
      api: handle.api,
      log: (m) => logs.push(m),
      logError: () => {},
      sleep: noSleep,
    });
    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/verified: instance state is now 'stopped in place'/);
  });

  it('appends a powerOff event when LM_EVENTS_PATH is set and powerOff verifies', async () => {
    const lastUseMs = Date.now() - 2 * HOUR_MS;
    await writeFile(join(dir, 'last'), String(lastUseMs), 'utf8');
    const eventsPath = join(dir, 'events.log');
    const handle = fakeApi('running');
    const code = await runReaper({
      env: baseEnv({ LM_EVENTS_PATH: eventsPath }),
      api: handle.api,
      log: () => {},
      logError: () => {},
      sleep: noSleep,
    });
    expect(code).toBe(0);
    const events = (await import('node:fs/promises')).readFile;
    const written = await events(eventsPath, 'utf8');
    const parsed = JSON.parse(written.trim());
    expect(parsed).toMatchObject({ event: 'powerOff', source: 'reaper' });
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does not append an event when verify fails — only successful halts get logged', async () => {
    await writeFile(join(dir, 'last'), '0', 'utf8');
    const eventsPath = join(dir, 'events.log');
    const handle = fakeApi('running', { transitionOnPowerOff: false });
    let t = 3 * HOUR_MS;
    const code = await runReaper({
      env: baseEnv({ LM_EVENTS_PATH: eventsPath }),
      api: handle.api,
      log: () => {},
      logError: () => {},
      sleep: noSleep,
      now: () => {
        const v = t;
        t += 10 * 60_000;
        return v;
      },
    });
    expect(code).toBe(1);
    const { access } = await import('node:fs/promises');
    await expect(access(eventsPath)).rejects.toThrow(/ENOENT/);
  });

  it('routes ERROR to logError (stderr) when state stays running past the verify deadline', async () => {
    // lastUseMs is epoch and fake `now` starts at +3h, so decideAction
    // sees 3h of idle (> 1h threshold) and picks powerOff. After that,
    // each `now()` call jumps 10 min — well past the 90s verify timeout
    // — so the polling loop trips the deadline on its first check and
    // we hit the ERROR path.
    await writeFile(join(dir, 'last'), '0', 'utf8');
    const handle = fakeApi('running', { transitionOnPowerOff: false });
    const logs: string[] = [];
    const errors: string[] = [];
    let t = 3 * HOUR_MS;
    const code = await runReaper({
      env: baseEnv(),
      api: handle.api,
      log: (m) => logs.push(m),
      logError: (m) => errors.push(m),
      sleep: noSleep,
      now: () => {
        const v = t;
        t += 10 * 60_000;
        return v;
      },
    });
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(
      /ERROR: instance still 'running'.*action did not take effect/,
    );
    // The ERROR line must NOT appear in the stdout-equivalent stream —
    // cron's MAILTO depends on stderr-only routing to surface a page.
    expect(logs.join('\n')).not.toMatch(/ERROR/);
    expect(handle.powerOffCalls).toBe(1);
  });
});
