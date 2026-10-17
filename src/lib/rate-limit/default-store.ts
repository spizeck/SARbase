import { InMemoryRateLimitStore } from "./memory-store";
import { PostgresRateLimitStore } from "./postgres-store";
import type { RateLimitStore } from "./rate-limit";

let shared: RateLimitStore | null = null;

/**
 * Shared rate-limit store for server actions (issue #55).
 *
 * - Production with a database → `PostgresRateLimitStore`: windows are
 *   shared across every serverless instance, so limits are authoritative
 *   regardless of how many Vercel instances are warm.
 * - Development and tests → `InMemoryRateLimitStore`: single process,
 *   no database round-trips, unit tests stay isolated.
 *
 * Instantiated lazily on first call — importing an actions module must
 * never open a database connection (build-time route collection imports
 * server modules).
 */
export function getRateLimitStore(): RateLimitStore {
  if (!shared) {
    shared =
      process.env.NODE_ENV === "production" && process.env.DATABASE_URL
        ? new PostgresRateLimitStore()
        : new InMemoryRateLimitStore();
  }
  return shared;
}
