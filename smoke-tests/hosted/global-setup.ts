import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { chromium, type FullConfig } from "@playwright/test";

import { SMOKE_AUTH_STATE } from "./auth-state";

/**
 * Hosted-suite global setup: establish the authenticated project's
 * storage state. Two outcomes only —
 *
 * - No SMOKE_TEST_EMAIL/SMOKE_TEST_PASSWORD: write an empty session.
 *   The authenticated project still runs; every test self-skips.
 * - Credentials present: drive the REAL login journey — fill /login,
 *   let the Firebase client SDK authenticate, let the server mint its
 *   session cookie — then persist the browser state. If the journey
 *   fails, the setup throws: a deployment that cannot sign in is a
 *   smoke-test failure, not a skip.
 *
 * Credentials only ever reach the login form of SMOKE_BASE_URL; they
 * are never logged, echoed, or written to disk.
 */
const EMPTY_STATE = JSON.stringify({ cookies: [], origins: [] });

export default async function globalSetup(config: FullConfig) {
  const email = process.env.SMOKE_TEST_EMAIL;
  const password = process.env.SMOKE_TEST_PASSWORD;
  const statePath = SMOKE_AUTH_STATE;
  mkdirSync(dirname(statePath), { recursive: true });

  if (!email || !password) {
    writeFileSync(statePath, EMPTY_STATE);
    return;
  }

  const baseURL = config.projects[0]?.use.baseURL as string;
  const bypass = process.env.SMOKE_VERCEL_BYPASS;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      baseURL,
      extraHTTPHeaders: bypass ? { "x-vercel-protection-bypass": bypass } : {},
    });
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

    await context.storageState({ path: statePath });
    await context.close();
  } finally {
    await browser.close();
  }
}
