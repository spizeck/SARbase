import type { RateLimitStore, RateLimitWindow } from "./rate-limit";

interface Entry {
  count: number;
  resetAt: number;
}

/**
 * Per-process fixed-window store for local development, tests, and
 * single-process deployments.
 *
 * Two bounds keep memory honest under hostile key spray:
 * - `maxEntries` — once reached, unexpired new keys are rejected softly
 *   by being counted at the limit boundary (effectively throttled);
 * - periodic sweep of expired windows so stale keys cannot accumulate.
 *
 * NOT authoritative across serverless instances/regions — see the
 * module README and rate-limit.ts header.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly entries = new Map<string, Entry>();
  private lastSweep = 0;

  constructor(
    private readonly maxEntries = 10_000,
    private readonly sweepIntervalMs = 60_000,
  ) {}

  async increment(
    key: string,
    windowMs: number,
    now: number,
  ): Promise<RateLimitWindow> {
    this.sweep(now);

    const existing = this.entries.get(key);
    if (existing && existing.resetAt > now) {
      existing.count += 1;
      return { count: existing.count, resetAt: existing.resetAt };
    }

    if (this.entries.size >= this.maxEntries) {
      // Soft failure: count the probe at the window boundary so new keys
      // are throttled rather than allowed during a key-spray event.
      return { count: Number.MAX_SAFE_INTEGER, resetAt: now + windowMs };
    }

    const entry: Entry = { count: 1, resetAt: now + windowMs };
    this.entries.set(key, entry);
    return { count: entry.count, resetAt: entry.resetAt };
  }

  private sweep(now: number) {
    if (now - this.lastSweep < this.sweepIntervalMs) return;
    this.lastSweep = now;
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }

  /** Test helper: number of live (unexpired or unswept) entries. */
  get size() {
    return this.entries.size;
  }
}
