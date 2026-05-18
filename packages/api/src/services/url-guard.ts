import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Reject URLs that would let a capture target the VM's loopback, the cloud
 * metadata service, or another host on the internal network. The capture
 * worker takes user-supplied URLs and feeds them to a headless browser; without
 * this guard an authenticated user could read e.g. `169.254.42.42`
 * (Scaleway metadata → IAM credentials) or `127.0.0.1:3001/api/...`.
 *
 * Setting `ALLOW_PRIVATE_CAPTURE_TARGETS=1` skips the check — useful when
 * pointing dev captures at `http://localhost:5173/fixtures/...`.
 */

const ESCAPE_HATCH_ENV = 'ALLOW_PRIVATE_CAPTURE_TARGETS';

export interface UrlGuardOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam — defaults to Node's `dns.lookup`. */
  resolver?: (host: string) => Promise<{ address: string; family: number }[]>;
}

export class UnsafeTargetError extends Error {
  constructor(public readonly reason: string, public readonly url: string) {
    super(`unsafe capture target (${reason}): ${url}`);
    this.name = 'UnsafeTargetError';
  }
}

export async function assertSafeCaptureUrl(rawUrl: string, opts: UrlGuardOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  if (env[ESCAPE_HATCH_ENV] === '1') return;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeTargetError('invalid_url', rawUrl);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeTargetError('non_http_scheme', rawUrl);
  }

  const host = url.hostname;
  if (host === '' || host === 'localhost') {
    throw new UnsafeTargetError('private_address', rawUrl);
  }

  let addrs: { address: string; family: number }[];
  if (isIP(host)) {
    addrs = [{ address: host, family: isIP(host) }];
  } else {
    const resolve = opts.resolver ?? (async (h: string) => lookup(h, { all: true }));
    try {
      addrs = await resolve(host);
    } catch {
      throw new UnsafeTargetError('dns_failure', rawUrl);
    }
  }

  for (const { address } of addrs) {
    if (isPrivateAddress(address)) {
      throw new UnsafeTargetError('private_address', rawUrl);
    }
  }
}

/** True for loopback / link-local / RFC1918 / CGNAT / unspecified addresses. */
export function isPrivateAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) return isPrivateV4(addr);
  if (v === 6) return isPrivateV6(addr);
  return false;
}

function isPrivateV4(addr: string): boolean {
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateV6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length);
    if (isIP(v4) === 4) return isPrivateV4(v4);
  }
  return false;
}
