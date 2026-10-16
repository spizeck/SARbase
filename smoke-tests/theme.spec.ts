import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

/**
 * Appearance theming (issue #72). The preference is a client-side
 * concern — a `sarbase-theme` localStorage value resolved by the
 * pre-paint bootstrap script — so every behavior is verifiable
 * anonymously on /login: no authenticated session needed.
 *
 * Playwright's emulateMedia drives prefers-color-scheme changes that
 * real matchMedia listeners observe, so "system tracks the OS without
 * reload" is tested end to end.
 */

const html = (page: import("@playwright/test").Page) => page.locator("html");

test.describe("appearance theme", () => {
  test("system preference follows the emulated OS scheme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/login");
    await expect(html(page)).toHaveClass(/dark/);
    // color-scheme must follow so native widgets (scrollbars,
    // form controls) render dark too.
    await expect(html(page)).toHaveCSS("color-scheme", "dark");
  });

  test("system stays light under a light OS scheme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/login");
    await expect(html(page)).not.toHaveClass(/\bdark\b/);
  });

  test("an explicit dark choice wins over a light OS scheme", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => {
      window.localStorage.setItem("sarbase-theme", "dark");
    });
    await page.goto("/login");
    await expect(html(page)).toHaveClass(/dark/);
  });

  test("an explicit light choice wins over a dark OS scheme", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => {
      window.localStorage.setItem("sarbase-theme", "light");
    });
    await page.goto("/login");
    await expect(html(page)).not.toHaveClass(/\bdark\b/);
  });

  test("the explicit choice persists across reloads", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/login");
    await page.evaluate(() => {
      window.localStorage.setItem("sarbase-theme", "dark");
      // The in-page listener applies immediately — no reload needed.
      window.dispatchEvent(new Event("sarbase-theme-change"));
    });
    await expect(html(page)).toHaveClass(/dark/);

    await page.reload();
    await expect(html(page)).toHaveClass(/dark/);
  });

  test("system mode tracks a live OS change without reload", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/login");
    await expect(html(page)).not.toHaveClass(/\bdark\b/);

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html(page)).toHaveClass(/dark/);
    await expect(html(page)).toHaveCSS("color-scheme", "dark");
  });

  test("an explicit choice does NOT track a live OS change", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/login");
    await page.evaluate(() => {
      window.localStorage.setItem("sarbase-theme", "light");
      window.dispatchEvent(new Event("sarbase-theme-change"));
    });

    await page.emulateMedia({ colorScheme: "dark" });
    // Give the media listener a beat to fire; the class must stay off.
    await page.waitForTimeout(100);
    await expect(html(page)).not.toHaveClass(/\bdark\b/);
  });

  test("applying dark produces no hydration errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.addInitScript(() => {
      window.localStorage.setItem("sarbase-theme", "dark");
    });
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    expect(
      errors.filter((e) => /hydrat/i.test(e)),
      "hydration errors",
    ).toEqual([]);
  });

  test("dark theme keeps the page free of detectable WCAG violations", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/login");
    await expect(html(page)).toHaveClass(/dark/);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
