import { test, expect } from "@playwright/test";

/**
 * Reporting/export authorization posture (issue #19). Authenticated
 * behavior is covered by the db test suite — the smoke suite does not
 * provision Firebase sessions, so these specs verify the anonymous
 * contract: no report page and no CSV bytes without a session.
 */
test.describe("organization reports and exports", () => {
  test("the reports page redirects unauthenticated callers to login", async ({
    page,
  }) => {
    await page.goto("/admin/organizations/org-fake/reports");
    await page.waitForURL(/\/login/);
    await expect(page).toHaveURL(/\/login/);
  });

  test("unauthenticated export requests receive no CSV content", async ({
    request,
  }) => {
    const response = await request.get(
      "/api/organizations/org-fake/exports/expenses",
    );
    // 401/redirect — never a CSV body for anonymous callers.
    expect(response.ok()).toBe(false);
    const body = await response.text();
    expect(body).not.toContain("amountMinor");
    expect(response.headers()["content-type"] ?? "").not.toContain("text/csv");
  });
});
