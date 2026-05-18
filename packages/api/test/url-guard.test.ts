import { describe, it, expect } from 'vitest';
import {
  assertSafeCaptureUrl,
  isPrivateAddress,
  UnsafeTargetError,
} from '../src/services/url-guard.js';

const stubResolver = (addr: string) => async () => [{ address: addr, family: addr.includes(':') ? 6 : 4 }];

describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.254', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['169.254.42.42', true],
    ['100.64.0.1', true],
    ['224.0.0.1', true],
    ['0.0.0.0', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['::1', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fd00::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:8.8.8.8', false],
    ['2606:4700::1', false],
  ])('%s → %s', (addr, expected) => {
    expect(isPrivateAddress(addr)).toBe(expected);
  });
});

describe('assertSafeCaptureUrl', () => {
  it('allows public hostnames', async () => {
    await expect(
      assertSafeCaptureUrl('https://example.com/x', { resolver: stubResolver('93.184.216.34') }),
    ).resolves.toBeUndefined();
  });

  it('rejects literal loopback IPv4', async () => {
    await expect(assertSafeCaptureUrl('http://127.0.0.1:3001/api')).rejects.toThrow(UnsafeTargetError);
  });

  it('rejects cloud metadata service', async () => {
    await expect(assertSafeCaptureUrl('http://169.254.169.254/')).rejects.toThrow(/private_address/);
    await expect(assertSafeCaptureUrl('http://169.254.42.42/')).rejects.toThrow(/private_address/);
  });

  it('rejects "localhost"', async () => {
    await expect(assertSafeCaptureUrl('http://localhost:8080/')).rejects.toThrow(/private_address/);
  });

  it('rejects hostnames that resolve to private IPs', async () => {
    await expect(
      assertSafeCaptureUrl('http://staging.internal/x', { resolver: stubResolver('10.0.0.5') }),
    ).rejects.toThrow(/private_address/);
  });

  it('rejects non-http schemes', async () => {
    await expect(assertSafeCaptureUrl('file:///etc/passwd')).rejects.toThrow(/non_http_scheme/);
    await expect(assertSafeCaptureUrl('ftp://example.com/')).rejects.toThrow(/non_http_scheme/);
  });

  it('rejects DNS failures (closed by default)', async () => {
    await expect(
      assertSafeCaptureUrl('https://nope.invalid/', {
        resolver: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    ).rejects.toThrow(/dns_failure/);
  });

  it('honors ALLOW_PRIVATE_CAPTURE_TARGETS escape hatch', async () => {
    await expect(
      assertSafeCaptureUrl('http://127.0.0.1:5173/fixtures/x.html', {
        env: { ALLOW_PRIVATE_CAPTURE_TARGETS: '1' },
      }),
    ).resolves.toBeUndefined();
  });
});
