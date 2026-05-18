import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface ArtifactStore {
  rootDir: string;
  /**
   * Hash the file at `tempPath`, atomically move it into the content-addressed
   * tree, and return the hash + byte size. If a file with the same hash
   * already exists, the temp file is deleted and the existing file is reused.
   * The temp file is consumed either way.
   */
  writeImage(tempPath: string): Promise<{ sha256: string; byteSize: number }>;
  /** Returns a path relative to `rootDir` for a given hash. */
  pathFor(sha256: string): string;
  /** Returns an absolute path inside the store for a given hash. */
  absolutePathFor(sha256: string): string;
}

const HEX64 = /^[0-9a-f]{64}$/;

function assertHash(sha256: string): void {
  if (!HEX64.test(sha256)) {
    throw new Error(`Invalid sha256 hash: ${sha256}`);
  }
}

async function hashFile(path: string): Promise<{ sha256: string; byteSize: number }> {
  const hash = createHash('sha256');
  let byteSize = 0;
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    byteSize += buf.length;
    hash.update(buf);
  }
  return { sha256: hash.digest('hex'), byteSize };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export function createArtifactStore(rootDir: string): ArtifactStore {
  const pathFor = (sha256: string): string => {
    assertHash(sha256);
    return join('sha256', sha256.slice(0, 2), `${sha256}.png`);
  };

  const absolutePathFor = (sha256: string): string => join(rootDir, pathFor(sha256));

  const writeImage = async (
    tempPath: string,
  ): Promise<{ sha256: string; byteSize: number }> => {
    const { sha256, byteSize } = await hashFile(tempPath);
    const dest = absolutePathFor(sha256);
    if (await exists(dest)) {
      await unlink(tempPath).catch(() => {});
      return { sha256, byteSize };
    }
    await mkdir(dirname(dest), { recursive: true });
    try {
      await rename(tempPath, dest);
    } catch (err) {
      // EXDEV: temp on a different filesystem. Fall back to copy + unlink.
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        const { copyFile } = await import('node:fs/promises');
        await copyFile(tempPath, dest);
        await unlink(tempPath).catch(() => {});
      } else {
        throw err;
      }
    }
    return { sha256, byteSize };
  };

  return { rootDir, pathFor, absolutePathFor, writeImage };
}

/** Build the public `/images/...` URL the web app should fetch. */
export function imageUrl(sha256: string | null | undefined): string | null {
  if (!sha256) return null;
  if (!HEX64.test(sha256)) return null;
  return `/images/sha256/${sha256.slice(0, 2)}/${sha256}.png`;
}
