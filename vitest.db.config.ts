import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { assertDestructiveTarget } from "./scripts/lib/destructive-db-guard";

const root = path.dirname(fileURLToPath(import.meta.url));

// Database-backed tests. These run ONLY against TEST_DATABASE_URL —
// a dedicated disposable test database, never the ambient DATABASE_URL
// (which could be a dev or preview database with real schema state).
// The suite writes and deletes rows, so the target gets the same
// destructive-command guard as prisma migrate/reset (issue #88):
// loopback is fine, production/testing hosts are refused, and any
// other remote target requires TEST_DB_CONFIRM_HOST set to the exact
// resolved hostname.
if (process.env.TEST_DATABASE_URL) {
  assertDestructiveTarget(
    process.env.TEST_DATABASE_URL,
    {
      productionHost: process.env.APP_PRODUCTION_DB_HOST,
      testingHost: process.env.APP_TESTING_DB_HOST,
      confirmHost: process.env.TEST_DB_CONFIRM_HOST,
    },
    "the database test suite",
  );
}
export default defineConfig({
  resolve: { alias: { "@": path.resolve(root, "src") } },
  test: {
    environment: "node",
    include: ["src/**/*.db.test.ts", "tests/db/**/*.test.ts"],
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "" },
    fileParallelism: false,
  },
});
