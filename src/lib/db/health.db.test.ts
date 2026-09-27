import { describe, expect, it } from "vitest";

/**
 * Database-backed test — runs only via `npm run test:db`, which loads
 * vitest.db.config.ts and maps TEST_DATABASE_URL onto DATABASE_URL.
 * Skips loudly (not silently green) when the test database is absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("database health check", () => {
  it("connects and answers SELECT 1", async () => {
    const { checkDatabaseConnection } = await import("./health");
    const result = await checkDatabaseConnection();
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("can read the migrated domain tables", async () => {
    const { prisma } = await import("@/lib/prisma");
    const count = await prisma.organization.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
