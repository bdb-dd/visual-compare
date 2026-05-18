import { createLmsCli, readLmsCliConfigFromEnv, type LmsCli } from './lms-cli.js';
import {
  createScalewayGpuController,
  readScalewayGpuConfigFromEnv,
} from './scaleway-gpu.js';

/**
 * Backend-selection layer for the LM Studio lifecycle controller. The
 * preflight in `lm.ts` consumes the `LmsCli` shape regardless of backend;
 * this module picks the concrete implementation from env at boot.
 *
 *   LM_BACKEND=local    → spawn the local `lms` CLI (dev default)
 *   LM_BACKEND=scaleway → drive a Scaleway GPU instance + remote LM Studio
 *   LM_BACKEND=none     → preflight will be unable to recover; useful when
 *                         the deployment is intentionally offline.
 *
 * The "none" backend returns an LmsCli whose serverStart/load both fail
 * with an explanatory message — caller sees the same shape, no special-
 * casing needed in lm.ts.
 */

export type LmBackend = 'local' | 'scaleway' | 'none';

export interface LmServerFactoryResult {
  backend: LmBackend;
  cli: LmsCli;
  /** Human-readable summary for the startup banner. */
  description: string;
}

export function createLmServerControllerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LmServerFactoryResult {
  const backend = parseBackend(env.LM_BACKEND);

  if (backend === 'scaleway') {
    const cfg = readScalewayGpuConfigFromEnv(env);
    if (!cfg) {
      throw new Error(
        'LM_BACKEND=scaleway but required env vars are missing. Set SCW_GPU_ZONE, SCW_GPU_INSTANCE_ID, SCW_SECRET_KEY, LM_STUDIO_BASE_URL, LM_STUDIO_MODEL.',
      );
    }
    return {
      backend,
      cli: createScalewayGpuController(cfg),
      description: `scaleway zone=${cfg.zone} instance=${cfg.instanceId.slice(0, 8)}…`,
    };
  }

  if (backend === 'none') {
    return {
      backend,
      cli: disabledLmsCli('LM_BACKEND=none — refusing to start or load the LM server'),
      description: 'disabled',
    };
  }

  const cfg = readLmsCliConfigFromEnv(env);
  return {
    backend: 'local',
    cli: createLmsCli(cfg),
    description: `local lms (bin=${cfg.bin})`,
  };
}

function parseBackend(raw: string | undefined): LmBackend {
  const v = (raw ?? 'local').toLowerCase();
  if (v === 'scaleway' || v === 'none' || v === 'local') return v;
  throw new Error(`Unknown LM_BACKEND='${raw}'. Expected one of: local, scaleway, none.`);
}

function disabledLmsCli(message: string): LmsCli {
  const failResult = {
    ok: false as const,
    exitCode: -1,
    stdout: '',
    stderr: '',
    errorMessage: message,
    durationMs: 0,
  };
  return {
    serverStart: async () => failResult,
    load: async () => failResult,
    ps: async () => failResult,
  };
}
