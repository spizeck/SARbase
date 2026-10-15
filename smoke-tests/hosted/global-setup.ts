import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { chromium, type FullConfig } from "@playwright/test";

import { SMOKE_AUTH_STATE, SMOKE_BYPASS_STATE } from "./auth-state";

/**
 * Hosted-suite global setup: establish the storage state both projects
 * load.
 *
 * - Deployment protection: when SMOKE_VERCEL_BYPASS is set, the secret
 *   is sent exactly once — a single API request to the deployment
 *   origin asking Vercel to mint its domain-scoped bypass cookie
 *   (`x-vercel-set-bypass-cookie`). The cookie lands in the context's
 *   cookie jar and is saved to `.auth/bypass.json`. Every project loads
 *   it via storageState, so browser pages AND the `request` fixture
 *   pass protection — while the secret itself never rides a
 *   context-wide header where it could leak to third-party origins.
 *
 * - Authentication: with SMOKE_TEST_EMAIL/SMOKE_TEST_PASSWORD present,
 *   the REAL login journey runs — fill /login, let the Firebase client
 *   SDK authenticate, let the server mint its session cookie — and the
 *   resulting state (bypass cookie + session) is saved to
 *   `.auth/smoke-user.json`. If the journey fails, setup throws: a
 *   deployment that cannot sign in is a smoke failure, not a skip.
 *   Without credentials an empty session is written and every
 *   authenticated spec self-skips.
 *
 * Credentials only ever reach the login form of SMOKE_BASE_URL; they
 * are never logged, echoed, or written to disk.
 */
const EMPTY_STATE = JSON.stringify({ cookies: [], origins: [] });

export default async function globalSetup(config: FullConfig) {
  const email = process.env.SMOKE_TEST_EMAIL;
  const password = process.env.SMOKE_TEST_PASSWORD;
  const bypass = process.env.SMOKE_VERCEL_BYPASS;
  const baseURL = config.projects[0]?.use.baseURL as string;

  mkdirSync(dirname(SMOKE_AUTH_STATE), { recursive: true });

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL });

    if (bypass) {
      // One scoped request mints the deployment-domain bypass cookie;
      // the secret never becomes a context-wide header.
      await context.request.get("/", {
        headers: {
          "x-vercel-protection-bypass": bypass,
          "x-vercel-set-bypass-cookie": "true",
        },
      });
    }
    await context.storageState({ path: SMOKE_BYPASS_STATE });

    if (!email || !password) {
      writeFileSync(SMOKE_AUTH_STATE, EMPTY_STATE);
      return;
    }

    const page = await context.newPage();
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

    // A successful sign-in leaves /login (the form routes to /account
    // or the caller's `next` target). Waiting on the URL — not on an
    // error absence — fails loudly for any deployment whose session
    // minting is broken, including silent Firebase project mismatches.
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 30_000,
    });

    await context.storageState({ path: SMOKE_AUTH_STATE });
  } finally {
    await browser.close();
  }
}
