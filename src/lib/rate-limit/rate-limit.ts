/**
 * Fixed-window rate limiting with a pluggable store.
 *
 * Derived from the Sea Saba implementation — selected because it is the
 * only audited limiter with an explicit store boundary, bounded memory
 * behavior, and honest documentation of what an in-memory store can and
 * cannot guarantee.
 *
 * IMPORTANT — store semantics: use `getRateLimitStore()`
 * (rate-limit/default-store.ts) rather than constructing a store
 * directly. Production resolves to `PostgresRateLimitStore`, which keeps
 * windows in the database so limits are authoritative across every
 * serverless instance; development and tests resolve to
 * `InMemoryRateLimitStore` (per-process — fine for single-process dev
 * and unit isolation, but an attacker hitting N instances would get N×
 * the budget, which is why it must never be the production default).
 */

export interface RateLimitWindow {
  /** Number of hits recorded in the current window. */
  count: number;
  /** Epoch ms when the current window ends. */
  resetAt: number;
}

export interface RateLimitStore {
  /**
   * Returns the current window for `key`, incrementing it by one.
   * Implementations must be atomic per key — a check-then-increment race
   * silently doubles the budget under concurrency.
   */
  increment(
    key: string,
    windowMs: number,
    now: number,
  ): Promise<RateLimitWindow>;
}

export interface RateLimitConfig {
  /** Maximum hits allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Remaining budget in this window after this request. */
  remaining: number;
  /** Epoch ms when the window resets. */
  resetAt: number;
  /** Seconds the client should wait before retrying (0 when allowed). */
  retryAfterSeconds: number;
}

/**
 * Check and consume one unit of rate budget for `key`.
 * `key` should already be an opaque scope+subject hash — see keys.ts;
 * raw IPs and user ids must not be used directly (they end up in logs
 * and store dumps).
 */
export async function checkRateLimit(
  store: RateLimitStore,
  key: string,
  config: RateLimitConfig,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const window = await store.increment(key, config.windowMs, now);
  const allowed = window.count <= config.limit;
  return {
    allowed,
    remaining: Math.max(0, config.limit - window.count),
    resetAt: window.resetAt,
    retryAfterSeconds: allowed
      ? 0
      : Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
  };
}
