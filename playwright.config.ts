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
    env: {
      // Public Firebase client config (NEXT_PUBLIC_* is embedded in the
      // client bundle by definition — never secret) so /login renders
      // its configured branch during smoke tests.
      NEXT_PUBLIC_FIREBASE_API_KEY: "smoke-test-api-key",
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "smoke-test.firebaseapp.com",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "smoke-test-project",
      NEXT_PUBLIC_FIREBASE_APP_ID: "1:0:web:smoke-test",
      // `next start` runs as production — the callout token derivation
      // fails closed without a secret. Test-only value; the spec
      // derives the fixture token with the same pepper.
      CALLOUT_RESPONSE_TOKEN_SECRET:
        process.env.CALLOUT_RESPONSE_TOKEN_SECRET ??
        "smoke-test-callout-token-secret",
    },
  },
});
