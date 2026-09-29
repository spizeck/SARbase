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
});
