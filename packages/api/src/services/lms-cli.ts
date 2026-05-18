import { spawn } from 'node:child_process';

/**
 * Thin wrapper around the LM Studio `lms` CLI. Used to auto-recover when the
 * preflight check finds the server stopped or the configured model unloaded.
 *
 * Every function returns a structured result instead of throwing — callers
 * decide how to surface failures.
 */

export interface LmsCliConfig {
  /** Path to the `lms` binary. Defaults to env LMS_BIN or 'lms'. */
  bin: string;
  /** Hard timeout (ms). Long enough for a model load. */
  timeoutMs: number;
}

export interface LmsCliResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set when the call could not be invoked (e.g. ENOENT) or timed out. */
  errorMessage?: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 120_000; // model load can be slow

export function readLmsCliConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LmsCliConfig {
  return {
    bin: env.LMS_BIN ?? 'lms',
    timeoutMs: env.LMS_TIMEOUT_MS ? Number(env.LMS_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
  };
}

/** Process spawner — abstracted so tests can stub it. */
export type Spawner = (
  bin: string,
  args: string[],
  timeoutMs: number,
) => Promise<LmsCliResult>;

export const realSpawner: Spawner = (bin, args, timeoutMs) => {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;

    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({
        ok: false,
        exitCode: -1,
        stdout: '',
        stderr: '',
        errorMessage: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: 0,
      });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({
        ok: false,
        exitCode: -1,
        stdout,
        stderr,
        errorMessage: `timed out after ${timeoutMs}ms`,
        durationMs: Date.now() - startedAt,
      });
    }, timeoutMs);

    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      const isNotFound = code === 'ENOENT';
      resolve({
        ok: false,
        exitCode: -1,
        stdout,
        stderr,
        errorMessage: isNotFound
          ? `'${bin}' not found on PATH. Set LMS_BIN to the full path (e.g. ~/.lmstudio/bin/lms).`
          : `spawn error: ${err.message}`,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? -1;
      resolve({
        ok: exitCode === 0,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
};

export interface LmsCli {
  serverStart(): Promise<LmsCliResult>;
  load(model: string): Promise<LmsCliResult>;
  ps(): Promise<LmsCliResult>;
}

export function createLmsCli(
  config: LmsCliConfig,
  spawner: Spawner = realSpawner,
): LmsCli {
  const run = (args: string[]) => spawner(config.bin, args, config.timeoutMs);
  return {
    serverStart: () => run(['server', 'start']),
    load: (model) => run(['load', model]),
    ps: () => run(['ps']),
  };
}
