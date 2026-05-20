import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLmEvent } from '../src/services/lm-events.js';

describe('appendLmEvent', () => {
  it('appends a single JSON line with ts + event fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lm-events-'));
    try {
      const path = join(dir, 'events.log');
      await appendLmEvent({
        path,
        event: { event: 'powerOn', source: 'api' },
        now: () => 1_700_000_000_000,
      });
      await appendLmEvent({
        path,
        event: { event: 'powerOff', source: 'reaper' },
        now: () => 1_700_000_300_000,
      });
      const lines = (await readFile(path, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toEqual({
        ts: '2023-11-14T22:13:20.000Z',
        event: 'powerOn',
        source: 'api',
      });
      expect(JSON.parse(lines[1]!)).toEqual({
        ts: '2023-11-14T22:18:20.000Z',
        event: 'powerOff',
        source: 'reaper',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('swallows append errors via onWriteError so callers never throw', async () => {
    const errors: string[] = [];
    await expect(
      appendLmEvent({
        path: '/nope',
        event: { event: 'powerOff', source: 'reaper' },
        append: async () => {
          throw new Error('disk full');
        },
        onWriteError: (m) => errors.push(m),
      }),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/disk full/);
  });
});
