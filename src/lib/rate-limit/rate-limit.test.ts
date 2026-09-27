import { describe, expect, it } from "vitest";

import { InMemoryRateLimitStore } from "./memory-store";
import { checkRateLimit } from "./rate-limit";
import { clientIpFromHeaders, rateLimitKey } from "./keys";

const config = { limit: 3, windowMs: 60_000 };

describe("checkRateLimit", () => {
  it("allows up to the limit then rejects with retry timing", async () => {
    const store = new InMemoryRateLimitStore();
    const key = rateLimitKey("login", "203.0.113.1");

    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit(store, key, config, 1_000);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(3 - i - 1);
    }

    const rejected = await checkRateLimit(store, key, config, 2_000);
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
    expect(rejected.resetAt).toBe(61_000);
  });

  it("opens a fresh window after reset", async () => {
    const store = new InMemoryRateLimitStore();
    const key = rateLimitKey("login", "203.0.113.1");
    await checkRateLimit(store, key, { limit: 1, windowMs: 100 }, 0);
    expect(
      (await checkRateLimit(store, key, { limit: 1, windowMs: 100 }, 50))
        .allowed,
    ).toBe(false);
    expect(
      (await checkRateLimit(store, key, { limit: 1, windowMs: 100 }, 101))
        .allowed,
    ).toBe(true);
  });

  it("isolates keys", async () => {
    const store = new InMemoryRateLimitStore();
    const a = rateLimitKey("login", "ip-a");
    const b = rateLimitKey("login", "ip-b");
    await checkRateLimit(store, a, { limit: 1, windowMs: 60_000 });
    expect(
      (await checkRateLimit(store, b, { limit: 1, windowMs: 60_000 })).allowed,
    ).toBe(true);
  });
});

describe("InMemoryRateLimitStore bounds", () => {
  it("soft-throttles new keys when at maxEntries", async () => {
    const store = new InMemoryRateLimitStore(2);
    await store.increment("a", 60_000, 0);
    await store.increment("b", 60_000, 0);
    const flooded = await store.increment("c", 60_000, 0);
    expect(flooded.count).toBeGreaterThan(1);
    expect(store.size).toBe(2);
  });

  it("sweeps expired entries", async () => {
    const store = new InMemoryRateLimitStore(100, 10);
    await store.increment("a", 5, 0);
    await store.increment("b", 60_000, 11); // triggers sweep
    expect(store.size).toBe(1);
  });
});

describe("rateLimitKey", () => {
  it("is opaque and stable", () => {
    const key = rateLimitKey("contact", "user@example.com");
    expect(key).toMatch(/^rl:contact:[0-9a-f]{32}$/);
    expect(key).not.toContain("user@example.com");
    expect(key).toBe(rateLimitKey("contact", "user@example.com"));
    expect(key).not.toBe(rateLimitKey("other", "user@example.com"));
  });
});

describe("clientIpFromHeaders", () => {
  it("takes the first x-forwarded-for entry", () => {
    expect(
      clientIpFromHeaders({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }),
    ).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip then unknown", () => {
    expect(clientIpFromHeaders({ "x-real-ip": "198.51.100.2" })).toBe(
      "198.51.100.2",
    );
    expect(clientIpFromHeaders({})).toBe("unknown");
  });
});
