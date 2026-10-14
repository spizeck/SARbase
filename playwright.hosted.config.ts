import { defineConfig, devices } from "@playwright/test";

import {
  SMOKE_AUTH_STATE,
  SMOKE_BYPASS_STATE,
} from "./smoke-tests/hosted/auth-state";

/**
 * Hosted smoke tests — the same deterministic specs, pointed at a real
 * deployment instead of a local `next start`.
 *
 *   SMOKE_BASE_URL=https://<preview-host> npx playwright test \
 *     --config playwright.hosted.config.ts
 *
 * Two projects split the suite by auth posture:
 *
 * - `anonymous`  — every existing spec; asserts what must be true for a
 *                  caller with no session (redirects, opaque 401s,
 *                  headers, public pages). Runs anywhere.
 * - `authenticated` — `authenticated.spec.ts` only, using a real sign-in
 *                  captured by global-setup into `.auth/smoke-user.json`.
 *                  Runs only when SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD
 *                  are set (a dedicated test user on the deployment's
 *                  Firebase project); otherwise every test skips and the
 *                  storage state file is an empty session.
 *
 * Vercel Deployment Protection: set SMOKE_VERCEL_BYPASS to the
 * protection-bypass secret. Global setup sends it exactly once — to the
 * deployment origin, requesting the bypass cookie — and both projects
 * load that domain-scoped cookie from storage state. The secret is
 * never attached to cross-origin requests and never logged.
 */
const baseURL = process.env.SMOKE_BASE_URL;
if (!baseURL) {
  throw new Error(
    "SMOKE_BASE_URL is required — the hosted suite targets a deployed " +
      "instance (e.g. SMOKE_BASE_URL=https://sar-base-git-x.vercel.app).",
  );
}
const parsedBaseURL = new URL(baseURL);
const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(
  parsedBaseURL.hostname,
);
if (parsedBaseURL.protocol !== "https:" && !isLoopback) {
  throw new Error(
    "SMOKE_BASE_URL must be https:// — a plaintext http:// target would " +
      "send the bypass secret unencrypted. http:// is allowed only for " +
      "loopback targets.",
  );
}

export default defineConfig({
  testDir: "./smoke-tests",
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 45_000,
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : [["list"]],
  globalSetup: "./smoke-tests/hosted/global-setup.ts",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    reducedMotion: "reduce",
    // Deployment-scoped bypass cookie written by global-setup. Applies
    // to browser pages and the `request` fixture alike; when the target
    // is unprotected (e.g. loopback) the file holds an empty session.
    storageState: SMOKE_BYPASS_STATE,
  },
  projects: [
    {
      name: "anonymous",
      testIgnore: "authenticated.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "authenticated",
      testMatch: "authenticated.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        storageState: SMOKE_AUTH_STATE,
      },
    },
  ],
});
