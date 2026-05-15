import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLmUsageTracker } from '../src/services/lm-usage.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lm-usage-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createLmUsageTracker', () => {
  it('returns null when no file has been written yet', async () => {
    const tracker = createLmUsageTracker({ path: join(dir, 'last') });
    expect(await tracker.read()).toBeNull();
  });

  it('round-trips a recorded timestamp', async () => {
    const tracker = createLmUsageTracker({ path: join(dir, 'last'), now: () => 1_700_000_000_000 });
    await tracker.record();
    expect(await tracker.read()).toBe(1_700_000_000_000);
  });

  it('creates parent directories on first write', async () => {
    const tracker = createLmUsageTracker({
      path: join(dir, 'nested', 'subdir', 'last'),
      now: () => 42,
    });
    await tracker.record();
    expect(await tracker.read()).toBe(42);
  });

  it('returns null when the file contains garbage', async () => {
    const path = join(dir, 'last');
    const tracker = createLmUsageTracker({ path });
    // Manually write nonsense.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, 'not-a-number', 'utf8');
    expect(await tracker.read()).toBeNull();
  });

  it('swallows write failures and invokes onWriteError instead of throwing', async () => {
    const errors: string[] = [];
    const tracker = createLmUsageTracker({
      // A path under a regular file rather than a directory — mkdir will succeed
      // but writeFile will fail because the parent ends up being an existing file's path.
      // Simpler: pass a path inside a non-directory by writing a file first.
      path: '/dev/null/nope',
      onWriteError: (m) => errors.push(m),
    });
    await tracker.record();
    expect(errors.length).toBe(1);
  });
});
