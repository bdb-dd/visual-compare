import { describe, expect, it } from 'vitest';
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMagick, MagickTimeoutError } from '../src/services/imagick.js';

/**
 * These tests don't exercise real ImageMagick. They use a fake `bin` —
 * usually `/bin/sleep` or a tiny shell script — to verify runMagick's
 * timeout, retry, and env-injection behavior independently of IM. Avoids
 * needing IM installed in CI and keeps the timing assertions deterministic.
 */

describe('runMagick timeout + retry', () => {
  it('throws MagickTimeoutError when the process exceeds timeoutMs', async () => {
    const start = Date.now();
    await expect(
      runMagick(['1'], {
        bin: '/bin/sleep',
        // Allowed exit codes for sleep: 0 normally, but on SIGKILL the
        // child closes with a non-zero code that the timeout path rejects
        // with MagickTimeoutError before the exit-code path runs.
        allowExitCodes: [0],
        timeoutMs: 100,
        retriesOnTimeout: 0,
      }),
    ).rejects.toBeInstanceOf(MagickTimeoutError);
    const elapsed = Date.now() - start;
    // 100ms timeout + spawn/cleanup overhead. Generous upper bound to keep
    // CI happy; the assertion that matters is "much less than 1000ms"
    // (the sleep duration), proving we killed early.
    expect(elapsed).toBeLessThan(800);
  });

  it('retries on timeout up to retriesOnTimeout times before giving up', async () => {
    const start = Date.now();
    await expect(
      runMagick(['1'], {
        bin: '/bin/sleep',
        timeoutMs: 80,
        retriesOnTimeout: 2,
      }),
    ).rejects.toBeInstanceOf(MagickTimeoutError);
    // 3 attempts × 80ms = 240ms minimum. With overhead, ~400-700ms.
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(240);
    expect(elapsed).toBeLessThan(2000);
  });

  it('succeeds without retry when the process exits before the timeout', async () => {
    const result = await runMagick(['hello'], {
      bin: '/bin/echo',
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('retries past a transient timeout and surfaces the eventual success', async () => {
    // Tiny shell helper: first invocation hangs (sleep) but creates a
    // marker file; subsequent invocations see the marker and exit fast.
    // Verifies the retry loop actually re-invokes the binary on timeout
    // and the second attempt's stdout is the resolved value.
    const dir = mkdtempSync(join(tmpdir(), 'vc-retry-test-'));
    const marker = join(dir, 'attempted');
    const script = join(dir, 'fake-magick.sh');
    writeFileSync(
      script,
      `#!/bin/sh
if [ -f "${marker}" ]; then
  echo retried
  exit 0
fi
touch "${marker}"
sleep 30
`,
    );
    chmodSync(script, 0o755);
    try {
      const result = await runMagick([], {
        bin: script,
        // Generous timeout on the first attempt so the script reliably
        // creates the marker before SIGKILL. The retry path is what we're
        // testing; we don't need to pin the first attempt's wall time.
        timeoutMs: 500,
        retriesOnTimeout: 1,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('retried');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runMagick env injection', () => {
  it('sets MAGICK_MEMORY_LIMIT and MAGICK_DISK_LIMIT defaults when caller env does not', async () => {
    const result = await runMagick(['MAGICK_MEMORY_LIMIT'], {
      bin: '/usr/bin/printenv',
      // printenv exits 1 when the var doesn't exist; allow that so we can
      // tell the difference between "set" and "unset" via stdout content.
      allowExitCodes: [0, 1],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1GiB');
  });

  it('preserves caller-provided env values rather than overwriting', async () => {
    const prev = process.env.MAGICK_MEMORY_LIMIT;
    process.env.MAGICK_MEMORY_LIMIT = '256MiB';
    try {
      const result = await runMagick(['MAGICK_MEMORY_LIMIT'], {
        bin: '/usr/bin/printenv',
        allowExitCodes: [0, 1],
      });
      expect(result.stdout.trim()).toBe('256MiB');
    } finally {
      if (prev === undefined) delete process.env.MAGICK_MEMORY_LIMIT;
      else process.env.MAGICK_MEMORY_LIMIT = prev;
    }
  });
});
