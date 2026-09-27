import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

// Database-backed tests. These run ONLY against TEST_DATABASE_URL —
// a dedicated disposable test database, never the ambient DATABASE_URL
// (which could be a dev or preview database with real schema state).
export default defineConfig({
  resolve: { alias: { "@": path.resolve(root, "src") } },
  test: {
    environment: "node",
    include: ["src/**/*.db.test.ts", "tests/db/**/*.test.ts"],
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "" },
    fileParallelism: false,
  },
});
