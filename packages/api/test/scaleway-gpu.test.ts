import { describe, expect, it } from 'vitest';
import {
  createScalewayApi,
  createScalewayGpuController,
  readScalewayGpuConfigFromEnv,
  type ScalewayApi,
  type ScalewayGpuConfig,
  type ScalewayInstanceState,
} from '../src/services/scaleway-gpu.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface FakeApiState {
  state: ScalewayInstanceState['state'];
  publicIp?: string | null;
  /** Number of poweron calls received. */
  powerOnCalls: number;
  powerOffCalls: number;
  /** Optional: error to throw on the next call. Consumed once. */
  nextError?: Error;
}

function fakeScalewayApi(initial: ScalewayInstanceState['state']): {
  api: ScalewayApi;
  state: FakeApiState;
} {
  const state: FakeApiState = { state: initial, powerOnCalls: 0, powerOffCalls: 0 };
  const api: ScalewayApi = {
    async getInstance() {
      if (state.nextError) {
        const err = state.nextError;
        state.nextError = undefined;
        throw err;
      }
      return { state: state.state, publicIp: state.publicIp ?? null };
    },
    async powerOn() {
      state.powerOnCalls++;
      // Simulate the instance transitioning to running.
      state.state = 'running';
    },
    async powerOff() {
      state.powerOffCalls++;
      state.state = 'stopped';
    },
  };
  return { api, state };
}

interface FakeFetchOptions {
  /** Sequence of probe responses to return, oldest-first. Each item is consumed once. */
  modelsResponses: Array<
    | { kind: 'unreachable' }
    | { kind: 'ok'; loaded: string[] }
  >;
}

function fakeFetch(opts: FakeFetchOptions): { impl: typeof fetch; remaining: () => number } {
  const queue = [...opts.modelsResponses];
  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.endsWith('/v1/models') && !url.endsWith('/models')) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    const next = queue.shift();
    if (!next) throw new Error('fakeFetch ran out of responses');
    if (next.kind === 'unreachable') {
      const err = new Error('connection refused');
      throw err;
    }
    return new Response(
      JSON.stringify({ data: next.loaded.map((id) => ({ id })) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { impl, remaining: () => queue.length };
}

function makeConfig(overrides: Partial<ScalewayGpuConfig> = {}): ScalewayGpuConfig {
  return {
    zone: 'fr-par-2',
    instanceId: '00000000-0000-0000-0000-000000000000',
    secretKey: 'secret',
    apiBaseUrl: 'https://api.example',
    lmBaseUrl: 'http://10.0.0.2:1234/v1',
    model: 'gemma-test',
    startTimeoutSeconds: 30,
    loadTimeoutSeconds: 30,
    pollIntervalSeconds: 1,
    ...overrides,
  };
}

const noSleep = async () => {};

// ---------------------------------------------------------------------------
// readScalewayGpuConfigFromEnv
// ---------------------------------------------------------------------------

describe('readScalewayGpuConfigFromEnv', () => {
  it('returns null when any required var is missing', () => {
    expect(readScalewayGpuConfigFromEnv({})).toBeNull();
    expect(
      readScalewayGpuConfigFromEnv({
        SCW_GPU_ZONE: 'fr-par-2',
        SCW_GPU_INSTANCE_ID: 'id',
        SCW_SECRET_KEY: 'k',
        // LM_STUDIO_BASE_URL omitted
        LM_STUDIO_MODEL: 'm',
      }),
    ).toBeNull();
  });

  it('parses a complete env into a config', () => {
    const cfg = readScalewayGpuConfigFromEnv({
      SCW_GPU_ZONE: 'fr-par-2',
      SCW_GPU_INSTANCE_ID: 'id-1',
      SCW_SECRET_KEY: 'k',
      LM_STUDIO_BASE_URL: 'http://lm:1234/v1',
      LM_STUDIO_MODEL: 'm',
      LM_START_TIMEOUT_SECONDS: '120',
    });
    expect(cfg).toMatchObject({
      zone: 'fr-par-2',
      instanceId: 'id-1',
      lmBaseUrl: 'http://lm:1234/v1',
      model: 'm',
      startTimeoutSeconds: 120,
    });
  });
});

// ---------------------------------------------------------------------------
// createScalewayApi (HTTP wrapper)
// ---------------------------------------------------------------------------

describe('createScalewayApi', () => {
  it('GET parses state + public ip from the Scaleway shape', async () => {
    const impl = (async () =>
      new Response(
        JSON.stringify({ server: { state: 'running', public_ip: { address: '1.2.3.4' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    const api = createScalewayApi(
      { zone: 'z', instanceId: 'i', secretKey: 'k', apiBaseUrl: 'https://api.example' },
      impl,
    );
    expect(await api.getInstance()).toEqual({ state: 'running', publicIp: '1.2.3.4' });
  });

  it('GET maps unknown states to "unknown" rather than throwing', async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ server: { state: 'frobnicating' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const api = createScalewayApi(
      { zone: 'z', instanceId: 'i', secretKey: 'k', apiBaseUrl: 'https://api.example' },
      impl,
    );
    expect((await api.getInstance()).state).toBe('unknown');
  });

  it('powerOn POSTs the action verb', async () => {
    let captured: { url: string; body: unknown; headers: Record<string, string> } | null = null;
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      captured = {
        url: typeof input === 'string' ? input : input.toString(),
        body: init?.body ? JSON.parse(init.body as string) : null,
        headers: init?.headers as Record<string, string>,
      };
      return new Response('{}', { status: 202 });
    }) as typeof fetch;
    const api = createScalewayApi(
      { zone: 'z', instanceId: 'i', secretKey: 'k', apiBaseUrl: 'https://api.example' },
      impl,
    );
    await api.powerOn();
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://api.example/instance/v1/zones/z/servers/i/action');
    expect(captured!.body).toEqual({ action: 'poweron' });
    expect(captured!.headers['X-Auth-Token']).toBe('k');
  });

  it('treats 409 as success (idempotent powerOff)', async () => {
    const impl = (async () => new Response('conflict', { status: 409 })) as typeof fetch;
    const api = createScalewayApi(
      { zone: 'z', instanceId: 'i', secretKey: 'k', apiBaseUrl: 'https://api.example' },
      impl,
    );
    await expect(api.powerOff()).resolves.toBeUndefined();
  });

  it('throws on non-409 error responses', async () => {
    const impl = (async () =>
      new Response('boom', { status: 500 })) as typeof fetch;
    const api = createScalewayApi(
      { zone: 'z', instanceId: 'i', secretKey: 'k', apiBaseUrl: 'https://api.example' },
      impl,
    );
    await expect(api.powerOn()).rejects.toThrow(/HTTP 500/);
  });
});

// ---------------------------------------------------------------------------
// createScalewayGpuController (LmsCli adapter)
// ---------------------------------------------------------------------------

describe('createScalewayGpuController.serverStart', () => {
  it('powers the instance on when stopped and waits for /v1/models to answer', async () => {
    const { api, state } = fakeScalewayApi('stopped');
    const { impl: fetchImpl } = fakeFetch({
      modelsResponses: [
        { kind: 'unreachable' },
        { kind: 'ok', loaded: ['gemma-test'] },
      ],
    });
    const ctrl = createScalewayGpuController(makeConfig(), {
      fetchImpl,
      api,
      sleep: noSleep,
    });
    const result = await ctrl.serverStart();
    expect(result.ok).toBe(true);
    expect(state.powerOnCalls).toBe(1);
  });

  it('skips powerOn when the instance is already running', async () => {
    const { api, state } = fakeScalewayApi('running');
    const { impl: fetchImpl } = fakeFetch({
      modelsResponses: [{ kind: 'ok', loaded: ['gemma-test'] }],
    });
    const ctrl = createScalewayGpuController(makeConfig(), {
      fetchImpl,
      api,
      sleep: noSleep,
    });
    const result = await ctrl.serverStart();
    expect(result.ok).toBe(true);
    expect(state.powerOnCalls).toBe(0);
  });

  it('returns ok=false with a clear message when LM Studio never answers within the timeout', async () => {
    const { api } = fakeScalewayApi('running');
    const { impl: fetchImpl } = fakeFetch({
      // unlimited unreachable responses
      modelsResponses: Array.from({ length: 50 }, () => ({ kind: 'unreachable' as const })),
    });
    // Use injected `now` so we hit the deadline after a single iteration.
    let t = 0;
    const ctrl = createScalewayGpuController(makeConfig({ startTimeoutSeconds: 1 }), {
      fetchImpl,
      api,
      sleep: noSleep,
      now: () => {
        const v = t;
        t += 2000; // each call advances 2s, so deadline (1s) trips after one probe
        return v;
      },
    });
    const result = await ctrl.serverStart();
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/did not become reachable/);
  });

  it('surfaces a Scaleway API error as ok=false (does not throw)', async () => {
    const { api, state } = fakeScalewayApi('stopped');
    state.nextError = new Error('rate limited');
    const ctrl = createScalewayGpuController(makeConfig(), {
      fetchImpl: (async () => new Response('{}')) as typeof fetch,
      api,
      sleep: noSleep,
    });
    const result = await ctrl.serverStart();
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/rate limited/);
  });
});

describe('createScalewayGpuController.load', () => {
  it('returns ok once the configured model appears in /v1/models', async () => {
    const { api } = fakeScalewayApi('running');
    const { impl: fetchImpl } = fakeFetch({
      modelsResponses: [
        { kind: 'ok', loaded: [] }, // not yet
        { kind: 'ok', loaded: ['gemma-test'] }, // now loaded
      ],
    });
    const ctrl = createScalewayGpuController(makeConfig(), {
      fetchImpl,
      api,
      sleep: noSleep,
    });
    const result = await ctrl.load('gemma-test');
    expect(result.ok).toBe(true);
  });

  it('returns ok=false when the model never loads in time', async () => {
    const { api } = fakeScalewayApi('running');
    const { impl: fetchImpl } = fakeFetch({
      modelsResponses: Array.from({ length: 50 }, () => ({
        kind: 'ok' as const,
        loaded: ['other-model'],
      })),
    });
    let t = 0;
    const ctrl = createScalewayGpuController(makeConfig({ loadTimeoutSeconds: 1 }), {
      fetchImpl,
      api,
      sleep: noSleep,
      now: () => {
        const v = t;
        t += 2000;
        return v;
      },
    });
    const result = await ctrl.load('gemma-test');
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/did not appear/);
  });
});
