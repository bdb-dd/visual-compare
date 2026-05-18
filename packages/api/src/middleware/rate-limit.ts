import type { RequestHandler } from 'express';

/**
 * Token-bucket rate limiter, in-process, per-IP. Bounds brute-force on Caddy's
 * basic_auth and the cost of SSRF-via-capture (since each call enqueues
 * Playwright work). Burst lets a normal SPA session do its 5-10 parallel
 * fetches on page-load without tripping.
 *
 * Cheap enough to run on every request: one Map lookup + arithmetic per IP.
 * The Map is bounded by `maxKeys` — when full, the oldest-touched entries are
 * evicted (Map iteration order is insertion order, so we re-insert on update
 * to make eviction approximate LRU).
 */

export interface RateLimitOptions {
  /** Sustained refill rate, tokens per second. */
  refillPerSecond: number;
  /** Burst size — how many tokens a fresh bucket starts with. */
  burst: number;
  /** Cap on tracked IPs. Defaults to 10_000. */
  maxKeys?: number;
  /** Test seam — defaults to Date.now. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function createRateLimit(opts: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const maxKeys = opts.maxKeys ?? 10_000;
  const now = opts.now ?? (() => Date.now());

  return (req, res, next) => {
    const key = clientKey(req);
    const t = now();

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: opts.burst, updatedAt: t };
    } else {
      const elapsedMs = t - bucket.updatedAt;
      const refilled = (elapsedMs / 1000) * opts.refillPerSecond;
      bucket.tokens = Math.min(opts.burst, bucket.tokens + refilled);
      bucket.updatedAt = t;
      buckets.delete(key);
    }

    if (bucket.tokens < 1) {
      buckets.set(key, bucket);
      const retryAfterSec = Math.ceil((1 - bucket.tokens) / opts.refillPerSecond);
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({ error: 'rate_limited', message: 'too many requests' });
      return;
    }

    bucket.tokens -= 1;
    buckets.set(key, bucket);

    if (buckets.size > maxKeys) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }

    next();
  };
}

function clientKey(req: { ip?: string; socket?: { remoteAddress?: string } }): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
