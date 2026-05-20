import { describe, it, expect, vi } from 'vitest';
import { retry, defaultShouldRetry } from '../src/services/http-retry.js';

describe('retry', () => {
  it('returns the first success without delay', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const res = await retry(fn);
    expect(res).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient 5xx and succeeds on a later attempt', async () => {
    const fn = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('HTTP 502 bad gateway'))
      .mockRejectedValueOnce(new Error('HTTP 503 service unavailable'))
      .mockResolvedValue('ok');
    const onRetry = vi.fn();
    const res = await retry(fn, { baseDelayMs: 1, maxAttempts: 3, onRetry });
    expect(res).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts and throws the last error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('HTTP 502'));
    await expect(
      retry(fn, { baseDelayMs: 1, maxAttempts: 3 }),
    ).rejects.toThrow('HTTP 502');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry deterministic 4xx errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('HTTP 404 not found'));
    await expect(retry(fn, { baseDelayMs: 1 })).rejects.toThrow('HTTP 404');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects a custom shouldRetry predicate', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('whatever'));
    const shouldRetry = vi.fn().mockReturnValue(false);
    await expect(retry(fn, { baseDelayMs: 1, shouldRetry })).rejects.toThrow('whatever');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });
});

describe('defaultShouldRetry', () => {
  it('retries 5xx errors', () => {
    expect(defaultShouldRetry(new Error('HTTP 500'))).toBe(true);
    expect(defaultShouldRetry(new Error('Scaleway poweron failed: HTTP 502 …'))).toBe(true);
    expect(defaultShouldRetry(new Error('HTTP 599'))).toBe(true);
  });

  it('does not retry 4xx errors', () => {
    expect(defaultShouldRetry(new Error('HTTP 400'))).toBe(false);
    expect(defaultShouldRetry(new Error('HTTP 401'))).toBe(false);
    expect(defaultShouldRetry(new Error('HTTP 404'))).toBe(false);
    expect(defaultShouldRetry(new Error('HTTP 429'))).toBe(false);
  });

  it('retries TypeErrors (fetch network failures)', () => {
    expect(defaultShouldRetry(new TypeError('fetch failed'))).toBe(true);
  });

  it('retries transient errnos via err.code', () => {
    const err = new Error('boom') as NodeJS.ErrnoException;
    err.code = 'ECONNRESET';
    expect(defaultShouldRetry(err)).toBe(true);
  });

  it('retries transient errnos via err.cause.code (undici)', () => {
    const cause = new Error('underlying') as NodeJS.ErrnoException;
    cause.code = 'UND_ERR_SOCKET';
    const err = new Error('higher') as Error & { cause?: NodeJS.ErrnoException };
    err.cause = cause;
    expect(defaultShouldRetry(err)).toBe(true);
  });

  it('does not retry unknown errors', () => {
    expect(defaultShouldRetry(new Error('something else'))).toBe(false);
    expect(defaultShouldRetry('a string')).toBe(false);
    expect(defaultShouldRetry(null)).toBe(false);
  });
});
