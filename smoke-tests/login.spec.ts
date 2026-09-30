import { test, expect } from "@playwright/test";

test.describe("login", () => {
  // Regression: /login rendered <form> on the server while the client
  // component independently re-read process.env at render time, saw an
  // unconfigured browser environment, and hydrated to the "not
  // configured" notice — a hydration mismatch. The configured check is
  // now resolved on the server and passed down as a prop, so server and
  // client must always agree. The smoke webServer sets public (non-
  // secret) NEXT_PUBLIC_FIREBASE_* values so the configured branch runs.
  test("/login hydrates without a server/client markup mismatch", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      consoleErrors.push(error.message);
    });

    await page.goto("/login");

    // The configured branch renders the form; after hydration it must
    // still be the form — not swapped for the unconfigured notice.
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

    // Let hydration and any post-hydration re-render settle, then
    // confirm nothing React logged a mismatch about.
    await page.waitForLoadState("networkidle");
    await expect(page.getByLabel("Email")).toBeVisible();

    expect(consoleErrors.join("\n")).not.toMatch(
      /hydration|server rendered HTML didn't match/i,
    );
  });

  // Regression: the server saw NEXT_PUBLIC_FIREBASE_* and rendered the
  // form, but the bundled client parsed the ambient `process.env`
  // object — unenumerable in the browser — so getFirebaseClientAuth()
  // returned null and submit reported "Authentication is not
  // available." The parser now reads each public variable by explicit
  // reference, which Next.js inlines into the client bundle.
  //
  // Intercepting only the real Email/Password credential endpoint —
  // POST {identitytoolkit}/v1/accounts:signInWithPassword?key=... —
  // keeps the suite secret-free and deterministic: the fulfilled 400
  // makes signInWithEmailAndPassword reject with a credential error.
  // The interception flag is asserted before the error UI so the test
  // cannot pass on an unrelated failure that never reached Firebase.
  test("/login submit reaches Firebase instead of failing at config detection", async ({
    page,
  }) => {
    let credentialRequestIntercepted = false;
    await page.route(
      "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword*",
      (route) => {
        credentialRequestIntercepted = true;
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: 400, message: "INVALID_LOGIN_CREDENTIALS" },
          }),
        });
      },
    );

    await page.goto("/login");
    await page.getByLabel("Email").fill("user@example.com");
    await page.getByLabel("Password").fill("password123");
    await page.getByRole("button", { name: "Sign in" }).click();

    // Scoped to the form's error <p> — the page also contains Next's
    // route announcer, which shares role="alert".
    const alert = page.locator("form p[role='alert']");
    await expect(alert).toBeVisible();

    // The credential request must actually have been intercepted —
    // otherwise the error below could come from a failure that never
    // reached Firebase and the regression would pass silently.
    expect(credentialRequestIntercepted).toBe(true);
    await expect(alert).not.toHaveText(/authentication is not available/i);
    await expect(alert).toHaveText(/invalid email or password/i);
  });
});
