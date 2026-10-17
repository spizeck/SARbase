import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

/**
 * Public legal pages (/privacy, /terms). They must be reachable with no
 * authentication and carry the draft/approval status honestly — these
 * are the pages the footer links everywhere point at.
 */
test.describe("legal pages", () => {
  for (const path of ["/privacy", "/terms"]) {
    test(`${path} loads publicly with content and version`, async ({
      page,
    }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      // A real document renders: heading, TOC, and section anchors.
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Contents" }),
      ).toBeVisible();
      await expect(page.getByText(/Version /)).toBeVisible();
      // Draft state is disclosed honestly until documents are approved.
      await expect(
        page.getByText(/draft|in effect|effective/i).first(),
      ).toBeVisible();
    });
  }

  test("/privacy has no automatically detectable WCAG violations", async ({
    page,
  }) => {
    await page.goto("/privacy");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test("home and sign-in surfaces link to both documents", async ({ page }) => {
    for (const path of ["/", "/login"]) {
      await page.goto(path);
      await expect(
        page.getByRole("link", { name: /privacy/i }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: /terms/i }).first(),
      ).toBeVisible();
    }
  });
});
