import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createArtifactStore, imageUrl } from '../src/services/artifact-store.js';

describe('artifactStore', () => {
  let storeDir: string;
  let workDir: string;

  beforeEach(async () => {
    storeDir = await mkdtemp(join(tmpdir(), 'vc-store-'));
    workDir = await mkdtemp(join(tmpdir(), 'vc-work-'));
  });
  afterEach(async () => {
    await rm(storeDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it('writes a file under sha256/<2hex>/<full>.png and returns hash + size', async () => {
    const store = createArtifactStore(storeDir);
    const tempPath = join(workDir, 'a.png');
    const data = Buffer.from('PNG bytes 1');
    await writeFile(tempPath, data);

    const expected = createHash('sha256').update(data).digest('hex');
    const result = await store.writeImage(tempPath);

    expect(result.sha256).toBe(expected);
    expect(result.byteSize).toBe(data.length);
    expect(store.pathFor(expected)).toBe(`sha256/${expected.slice(0, 2)}/${expected}.png`);

    // The file is moved into the content-addressed location.
    const dest = store.absolutePathFor(expected);
    const onDisk = await readFile(dest);
    expect(onDisk.equals(data)).toBe(true);

    // Temp file is gone.
    await expect(stat(tempPath)).rejects.toThrow();
  });

  it('deduplicates identical content', async () => {
    const store = createArtifactStore(storeDir);
    const data = Buffer.from('same bytes');

    const t1 = join(workDir, 'one.png');
    const t2 = join(workDir, 'two.png');
    await writeFile(t1, data);
    await writeFile(t2, data);

    const r1 = await store.writeImage(t1);
    const r2 = await store.writeImage(t2);

    expect(r1.sha256).toBe(r2.sha256);
    // Both temps should be consumed.
    await expect(stat(t1)).rejects.toThrow();
    await expect(stat(t2)).rejects.toThrow();
  });

  it('imageUrl returns null for null/empty/invalid hashes and a path for valid', () => {
    expect(imageUrl(null)).toBeNull();
    expect(imageUrl(undefined)).toBeNull();
    expect(imageUrl('not-a-hash')).toBeNull();
    const hash = 'a'.repeat(64);
    expect(imageUrl(hash)).toBe(`/images/sha256/aa/${hash}.png`);
  });
});
