import { prisma } from "@/lib/prisma";

import type { RateLimitStore, RateLimitWindow } from "./rate-limit";

interface WindowRow {
  count: number;
  resetAt: bigint;
}

/**
 * Shared fixed-window store backed by Postgres (issue #55).
 *
 * `InMemoryRateLimitStore` is per-process — on serverless platforms
 * every warm instance gets its own budget, so an attacker gets N× the
 * intended limit. This store keeps windows in the `RateLimitWindow`
 * table so the limit is authoritative regardless of instance count or
 * region. It needs no new infrastructure: the app database already
 * exists on every deployment.
 *
 * Correctness properties:
 * - Single-statement INSERT … ON CONFLICT upsert — atomic per key, so
 *   concurrent increments can never check-then-write over each other.
 * - Windows that rolled past `resetAt` restart at count 1 in the same
 *   statement — no separate "expired?" read.
 * - Expired rows are reclaimed by a probabilistic sweep (default ~1% of
 *   calls) so the table stays bounded without a scheduled job.
 *
 * Keys are opaque sha256 digests produced by rate-limit/keys.ts — the
 * table never holds IPs, user ids, or other PII.
 */
export class PostgresRateLimitStore implements RateLimitStore {
  /**
   * @param sweepProbability chance per call of running an expired-row
   *   sweep; 0 disables sweeping (tests control it explicitly).
   */
  constructor(private readonly sweepProbability = 0.01) {}

  async increment(
    key: string,
    windowMs: number,
    now: number,
  ): Promise<RateLimitWindow> {
    const newResetAt = BigInt(now + windowMs);
    const nowBig = BigInt(now);

    const rows = await prisma.$queryRaw<WindowRow[]>`
      INSERT INTO "RateLimitWindow" ("key", "count", "resetAt")
      VALUES (${key}, 1, ${newResetAt})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN "RateLimitWindow"."resetAt" > ${nowBig}
          THEN "RateLimitWindow"."count" + 1
          ELSE 1
        END,
        "resetAt" = CASE
          WHEN "RateLimitWindow"."resetAt" > ${nowBig}
          THEN "RateLimitWindow"."resetAt"
          ELSE ${newResetAt}
        END
      RETURNING "count", "resetAt"
    `;

    const row = rows[0];
    if (!row) {
      throw new Error("rate-limit upsert returned no window");
    }

    if (Math.random() < this.sweepProbability) {
      // Fire-and-forget: a failed sweep must never fail the request;
      // the next hit gets another chance. Batched so a pathologically
      // large backlog cannot take a long row lock on one unlucky call.
      void prisma.$executeRaw`
        DELETE FROM "RateLimitWindow"
        WHERE "key" IN (
          SELECT "key" FROM "RateLimitWindow"
          WHERE "resetAt" <= ${nowBig}
          LIMIT 500
        )
      `.catch(() => {});
    }

    return { count: Number(row.count), resetAt: Number(row.resetAt) };
  }

  /** Delete every window that expired at or before `now`. */
  async sweep(now: number): Promise<number> {
    return prisma.$executeRaw`
      DELETE FROM "RateLimitWindow" WHERE "resetAt" <= ${BigInt(now)}
    `;
  }
}
