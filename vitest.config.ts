import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": path.resolve(root, "src") } },
  test: {
    environment: "node",
    // *.db.test.ts needs a real database — it runs only via
    // `npm run test:db` (vitest.db.config.ts + TEST_DATABASE_URL).
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    exclude: ["src/**/*.db.test.ts", "tests/db/**"],
  },
});
