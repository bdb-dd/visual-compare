import type { LmsCli, LmsCliResult } from './lms-cli.js';
import { retry } from './http-retry.js';

/**
 * Scaleway-backed implementation of the `LmsCli` interface. Used in the
 * deployed environment where LM Studio runs on a GPU instance that is
 * powered off until the API needs it.
 *
 * Shape decisions:
 * - serverStart()  → power the GPU instance on (if not already running)
 *                    and poll `<baseURL>/models` until it answers.
 * - load(model)    → no-op-but-wait: the GPU's systemd unit auto-loads
 *                    the configured model on boot, so we just poll
 *                    `/models` until that model id appears.
 * - ps()           → returns a stringified instance state for diagnostics.
 *
 * Failures are surfaced as LmsCliResult{ok:false} with a populated
 * `errorMessage` rather than thrown — same contract as the local lms-cli
 * so runPreflight in lm.ts treats both backends identically.
 */

export interface ScalewayInstanceState {
  /** Lifecycle state as reported by Scaleway. */
  state:
    | 'starting'
    | 'running'
    | 'stopping'
    | 'stopped'
    | 'stopped in place'
    | 'locked'
    | 'unknown';
  /** Primary public IPv4 if assigned, else null. */
  publicIp: string | null;
}

export interface ScalewayApi {
  getInstance(): Promise<ScalewayInstanceState>;
  /** Issues the `poweron` action. Idempotent: ok if already running. */
  powerOn(): Promise<void>;
  /**
   * Issues the `stop_in_place` action — a hypervisor-level halt that does
   * not depend on the guest OS responding to ACPI. Used by the idle reaper
   * where the goal is to stop compute billing; the boot drive + IP are
   * preserved so the next `powerOn` is a fast cold boot.
   *
   * Idempotent: ok if already stopped. We deliberately do NOT use the
   * `poweroff` action — observed in production to leave tasks `pending`
   * indefinitely while the guest ignored the ACPI signal.
   */
  powerOff(): Promise<void>;
}

export interface ScalewayGpuConfig {
  /** Scaleway zone, e.g. `fr-par-2`. */
  zone: string;
  /** Instance id (UUID). */
  instanceId: string;
  /** Secret key for `X-Auth-Token`. */
  secretKey: string;
  /** Base URL for the Scaleway API. Defaults to https://api.scaleway.com. */
  apiBaseUrl?: string;
  /** Base URL of the LM Studio HTTP server on the GPU instance, including `/v1`. */
  lmBaseUrl: string;
  /** Configured model id — used to know when load() can return. */
  model: string;
  /** Max seconds to wait for serverStart to finish (boot + warmup). Default 360. */
  startTimeoutSeconds?: number;
  /** Max seconds to wait for load() to observe the model loaded. Default 240. */
  loadTimeoutSeconds?: number;
  /** Seconds between probes. Default 5. */
  pollIntervalSeconds?: number;
}

export interface ScalewayGpuConfigPartial extends Partial<ScalewayGpuConfig> {}

export function readScalewayGpuConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ScalewayGpuConfig | null {
  const zone = env.SCW_GPU_ZONE;
  const instanceId = env.SCW_GPU_INSTANCE_ID;
  const secretKey = env.SCW_SECRET_KEY;
  const lmBaseUrl = env.LM_STUDIO_BASE_URL;
  const model = env.LM_STUDIO_MODEL;
  if (!zone || !instanceId || !secretKey || !lmBaseUrl || !model) return null;
  return {
    zone,
    instanceId,
    secretKey,
    lmBaseUrl,
    model,
    apiBaseUrl: env.SCW_API_BASE_URL ?? 'https://api.scaleway.com',
    startTimeoutSeconds: env.LM_START_TIMEOUT_SECONDS
      ? Number(env.LM_START_TIMEOUT_SECONDS)
      : 360,
    loadTimeoutSeconds: env.LM_LOAD_TIMEOUT_SECONDS
      ? Number(env.LM_LOAD_TIMEOUT_SECONDS)
      : 240,
    pollIntervalSeconds: env.LM_POLL_INTERVAL_SECONDS
      ? Number(env.LM_POLL_INTERVAL_SECONDS)
      : 5,
  };
}

interface ScalewayServerResponse {
  server?: {
    state?: string;
    public_ip?: { address?: string } | null;
  };
}

/** Maps Scaleway's wire `state` string to our narrower union. */
function normalizeState(s: string | undefined): ScalewayInstanceState['state'] {
  switch (s) {
    case 'starting':
    case 'running':
    case 'stopping':
    case 'stopped':
    case 'stopped in place':
    case 'locked':
      return s;
    default:
      return 'unknown';
  }
}

export function createScalewayApi(
  config: Pick<ScalewayGpuConfig, 'zone' | 'instanceId' | 'secretKey' | 'apiBaseUrl'>,
  fetchImpl: typeof fetch = globalThis.fetch,
): ScalewayApi {
  const base = (config.apiBaseUrl ?? 'https://api.scaleway.com').replace(/\/$/, '');
  const serverUrl = `${base}/instance/v1/zones/${config.zone}/servers/${config.instanceId}`;

  const headers = {
    'X-Auth-Token': config.secretKey,
    'Content-Type': 'application/json',
  } as const;

  const action = async (verb: 'poweron' | 'stop_in_place') => {
    await retry(
      async () => {
        const res = await fetchImpl(`${serverUrl}/action`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ action: verb }),
        });
        if (res.status === 409) {
          // Already in target state — Scaleway returns 409 ("instance is locked"
          // or "no transition") for repeat actions. Treat as success.
          // eslint-disable-next-line no-console
          console.log(
            `${new Date().toISOString()} [scaleway] ${verb}: HTTP 409 (already in target state, treated as success)`,
          );
          return;
        }
        if (!res.ok) {
          const body = await safeText(res);
          throw new Error(`Scaleway ${verb} failed: HTTP ${res.status} ${body}`);
        }
        const body = await safeText(res);
        // eslint-disable-next-line no-console
        console.log(`${new Date().toISOString()} [scaleway] ${verb}: HTTP ${res.status} ${body}`);
      },
      {
        label: `scaleway ${verb}`,
        onRetry: (err, attempt, delayMs) =>
          // eslint-disable-next-line no-console
          console.warn(
            `[scaleway] ${verb} attempt ${attempt} failed (${(err as Error).message}); retrying in ${delayMs}ms`,
          ),
      },
    );
  };

  return {
    async getInstance() {
      return retry(
        async () => {
          const res = await fetchImpl(serverUrl, { headers });
          if (!res.ok) {
            const body = await safeText(res);
            throw new Error(`Scaleway getInstance failed: HTTP ${res.status} ${body}`);
          }
          const json = (await res.json()) as ScalewayServerResponse;
          return {
            state: normalizeState(json.server?.state),
            publicIp: json.server?.public_ip?.address ?? null,
          };
        },
        {
          label: 'scaleway getInstance',
          onRetry: (err, attempt, delayMs) =>
            // eslint-disable-next-line no-console
            console.warn(
              `[scaleway] getInstance attempt ${attempt} failed (${(err as Error).message}); retrying in ${delayMs}ms`,
            ),
        },
      );
    },
    powerOn: () => action('poweron'),
    powerOff: () => action('stop_in_place'),
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// LmsCli adapter
// ---------------------------------------------------------------------------

const ok = (stdout = '', durationMs = 0): LmsCliResult => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr: '',
  durationMs,
});

const fail = (errorMessage: string, durationMs = 0): LmsCliResult => ({
  ok: false,
  exitCode: -1,
  stdout: '',
  stderr: '',
  errorMessage,
  durationMs,
});

interface ProbeResult {
  reachable: boolean;
  loaded: string[];
}

async function probeLmStudio(
  lmBaseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs = 4000,
): Promise<ProbeResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${lmBaseUrl.replace(/\/$/, '')}/models`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return { reachable: false, loaded: [] };
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return { reachable: true, loaded: (json.data ?? []).map((m) => m.id) };
  } catch {
    return { reachable: false, loaded: [] };
  } finally {
    clearTimeout(t);
  }
}

export interface ScalewayGpuControllerOptions {
  fetchImpl?: typeof fetch;
  api?: ScalewayApi;
  /** Test seam for the polling delay. Replace with a no-op in unit tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for `Date.now()` so timeouts can be exercised deterministically. */
  now?: () => number;
}

export function createScalewayGpuController(
  config: ScalewayGpuConfig,
  options: ScalewayGpuControllerOptions = {},
): LmsCli {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const api = options.api ?? createScalewayApi(config, fetchImpl);
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());

  const pollMs = (config.pollIntervalSeconds ?? 5) * 1000;
  const startTimeoutMs = (config.startTimeoutSeconds ?? 360) * 1000;
  const loadTimeoutMs = (config.loadTimeoutSeconds ?? 240) * 1000;

  return {
    async serverStart(): Promise<LmsCliResult> {
      const startedAt = now();
      const deadline = startedAt + startTimeoutMs;
      try {
        const state = await api.getInstance();
        if (state.state !== 'running' && state.state !== 'starting') {
          await api.powerOn();
        }
      } catch (err) {
        return fail(
          `Scaleway powerOn failed: ${err instanceof Error ? err.message : String(err)}`,
          now() - startedAt,
        );
      }

      while (now() < deadline) {
        const probe = await probeLmStudio(config.lmBaseUrl, fetchImpl);
        if (probe.reachable) {
          return ok(
            `LM Studio reachable on ${config.lmBaseUrl}`,
            now() - startedAt,
          );
        }
        await sleep(pollMs);
      }
      return fail(
        `LM Studio at ${config.lmBaseUrl} did not become reachable within ${config.startTimeoutSeconds ?? 360}s after powerOn`,
        now() - startedAt,
      );
    },

    async load(model: string): Promise<LmsCliResult> {
      // The GPU image auto-loads the configured model on boot, so we don't
      // dispatch a load command — we just wait for the id to surface in
      // /v1/models. If it never does, that's a real configuration error on
      // the GPU side and we surface it as a failure.
      const startedAt = now();
      const deadline = startedAt + loadTimeoutMs;
      while (now() < deadline) {
        const probe = await probeLmStudio(config.lmBaseUrl, fetchImpl);
        if (probe.reachable && probe.loaded.includes(model)) {
          return ok(`model '${model}' is loaded`, now() - startedAt);
        }
        await sleep(pollMs);
      }
      return fail(
        `model '${model}' did not appear in /v1/models within ${config.loadTimeoutSeconds ?? 240}s. Check the GPU instance's lm-studio.service.`,
        now() - startedAt,
      );
    },

    async ps(): Promise<LmsCliResult> {
      const startedAt = now();
      try {
        const state = await api.getInstance();
        const probe =
          state.state === 'running'
            ? await probeLmStudio(config.lmBaseUrl, fetchImpl)
            : { reachable: false, loaded: [] as string[] };
        return ok(
          `instance=${state.state} reachable=${probe.reachable} loaded=${probe.loaded.join(',') || '(none)'}`,
          now() - startedAt,
        );
      } catch (err) {
        return fail(
          `Scaleway getInstance failed: ${err instanceof Error ? err.message : String(err)}`,
          now() - startedAt,
        );
      }
    },
  };
}
