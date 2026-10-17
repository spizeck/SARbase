import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";

import { PostgresRateLimitStore } from "./postgres-store";
import { checkRateLimit } from "./rate-limit";

/**
 * Issue #55 — the whole point of the Postgres store is that windows are
 * shared and increments are atomic across instances. These tests run
 * against the real database: mocking the upsert would test nothing.
 */

const store = new PostgresRateLimitStore(0); // sweeping disabled — tested explicitly
const testKeys: string[] = [];

function key(name: string) {
  const k = `rl:db-test:${name}:${Date.now()}:${Math.random()}`;
  testKeys.push(k);
  return k;
}

beforeAll(async () => {
  await prisma.rateLimitWindow.deleteMany({
    where: { key: { startsWith: "rl:db-test:" } },
  });
});

afterAll(async () => {
  await prisma.rateLimitWindow.deleteMany({
    where: { key: { in: testKeys } },
  });
  await prisma.$disconnect();
});

describe("PostgresRateLimitStore", () => {
  it("starts a new key at count 1 inside the window", async () => {
    const window = await store.increment(key("fresh"), 60_000, 1_000);
    expect(window).toEqual({ count: 1, resetAt: 61_000 });
  });

  it("increments within the same window and keeps resetAt stable", async () => {
    const k = key("stable");
    const first = await store.increment(k, 60_000, 1_000);
    const second = await store.increment(k, 60_000, 5_000);
    expect(second.count).toBe(2);
    expect(second.resetAt).toBe(first.resetAt);
  });

  it("is atomic under concurrent increments — no lost updates", async () => {
    const k = key("race");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.increment(k, 60_000, 1_000)),
    );
    const counts = results.map((r) => r.count);
    // Every increment must have observed a distinct count 1..20 — a
    // check-then-write race would repeat or skip values.
    expect([...counts].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    const row = await prisma.rateLimitWindow.findUnique({ where: { key: k } });
    expect(row?.count).toBe(20);
  });

  it("restarts the window after resetAt has passed", async () => {
    const k = key("rollover");
    await store.increment(k, 60_000, 1_000);
    await store.increment(k, 60_000, 2_000);
    const after = await store.increment(k, 60_000, 70_000);
    expect(after.count).toBe(1);
    expect(after.resetAt).toBe(130_000);
  });

  it("sweep removes only expired rows", async () => {
    const expired = key("expired");
    const live = key("live");
    await store.increment(expired, 1_000, 1_000); // resetAt = 2_000
    await store.increment(live, 60_000, 1_000); // resetAt = 61_000

    const removed = await store.sweep(5_000);
    expect(removed).toBe(1);
    expect(
      await prisma.rateLimitWindow.findUnique({ where: { key: expired } }),
    ).toBeNull();
    expect(
      await prisma.rateLimitWindow.findUnique({ where: { key: live } }),
    ).not.toBeNull();
  });

  it("enforces the limit through checkRateLimit across store instances", async () => {
    // Two independent store objects behave like two serverless
    // instances: they must observe each other's windows.
    const instanceA = new PostgresRateLimitStore(0);
    const instanceB = new PostgresRateLimitStore(0);
    const k = key("shared");
    const config = { limit: 3, windowMs: 60_000 };

    await checkRateLimit(instanceA, k, config, 1_000);
    await checkRateLimit(instanceB, k, config, 1_000);
    const third = await checkRateLimit(instanceA, k, config, 1_000);
    const fourth = await checkRateLimit(instanceB, k, config, 1_000);

    expect(third.allowed).toBe(true);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });
});
