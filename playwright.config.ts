import { defineConfig, devices } from "@playwright/test";

// Browser smoke tests run against the production build served by
// `next start` on a fixed local port. CI builds once (the `npm run build`
// step) and reuses that output here; locally the webServer command builds
// first so the suite stays a single command.
//
// The suite is deterministic; a failure means a real problem, not a flake
// to retry away — retries mask genuine regressions.
const port = Number(process.env.SMOKE_PORT ?? 3100);

export default defineConfig({
  testDir: "./smoke-tests",
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Deterministic animations: honor prefers-reduced-motion so suites do
    // not flake on transition timing.
    reducedMotion: "reduce",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: process.env.CI
      ? `npx next start -p ${port}`
      : `npm run build && npx next start -p ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
