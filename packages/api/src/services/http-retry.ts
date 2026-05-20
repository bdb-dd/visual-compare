/**
 * Bounded retry helper for transient HTTP / network failures. Used by
 * callers that talk to flaky external services (Scaleway control plane,
 * LM Studio over WAN) — the eval orchestrator otherwise marks the whole
 * evaluation `'error'` on a single bubbling 5xx, leaving thousands of
 * queued items undone.
 *
 * Default policy:
 *   - 3 attempts (initial + 2 retries)
 *   - 500ms · 1500ms · 4500ms backoff (exponential base 3)
 *   - Retry on HTTP 5xx + common network errnos (ECONNRESET, ETIMEDOUT,
 *     ECONNREFUSED, EAI_AGAIN, EPIPE). 4xx is *not* retried — those are
 *     deterministic client errors and retrying would just stall.
 */

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Delay for the first retry; subsequent retries multiply by `backoffFactor`. Default 500ms. */
  baseDelayMs?: number;
  /** Exponential factor applied between retries. Default 3 (→ 500, 1500, 4500). */
  backoffFactor?: number;
  /**
   * Custom predicate for whether to retry an error. Defaults to retrying
   * 5xx + common transient network errnos.
   */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Observability hook fired before each sleep. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Optional label included in onRetry logs by callers; not used internally. */
  label?: string;
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const max = Math.max(1, opts.maxAttempts ?? 3);
  const base = opts.baseDelayMs ?? 500;
  const factor = opts.backoffFactor ?? 3;
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;

  let attempt = 0;
  // The loop runs at most `max` times; lastErr is set on every failed attempt.
  // The final attempt either returns or throws, so the post-loop throw is
  // a defensive guard.
  let lastErr: unknown;
  while (attempt < max) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (attempt >= max) break;
      if (!shouldRetry(err, attempt)) break;
      const delayMs = base * Math.pow(factor, attempt - 1);
      opts.onRetry?.(err, attempt, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(typeof lastErr === 'string' ? lastErr : 'retry failed');
}

const TRANSIENT_ERRNOS = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Default predicate: retries `HTTP 5xx` errors thrown with that pattern in
 * their message, plus common transient network errnos. `TypeError` is a
 * blanket retry too because `fetch()` throws `TypeError` on network
 * failures (the most likely shape of the "HTTP 502" path in our case
 * came from upstream proxies returning 502 inside a 200 response — those
 * are caught by the explicit HTTP-pattern check).
 */
export function defaultShouldRetry(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (!(err instanceof Error)) return false;
  const m = /HTTP (\d{3})/.exec(err.message);
  if (m) {
    const status = Number(m[1]);
    return status >= 500 && status <= 599;
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code && TRANSIENT_ERRNOS.has(code)) return true;
  // Undici causes errors whose `cause.code` is the transient errno.
  const causeCode = (err as { cause?: NodeJS.ErrnoException }).cause?.code;
  if (causeCode && TRANSIENT_ERRNOS.has(causeCode)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
