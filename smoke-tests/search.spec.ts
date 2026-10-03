import { test, expect } from "@playwright/test";

/**
 * Global search authorization posture (issue #18). Authenticated
 * search behavior is covered by the db test suite — the smoke suite
 * does not provision Firebase sessions, so these specs verify the
 * anonymous contract: the search page is never reachable, and never
 * hints at record existence, without a session.
 */
test.describe("organization search", () => {
  test("the search page redirects unauthenticated callers to login", async ({
    page,
  }) => {
    await page.goto("/admin/organizations/org-fake/search?q=flare");
    await page.waitForURL(/\/login/);
    await expect(page).toHaveURL(/\/login/);
  });

  test("unauthenticated search requests receive no record content", async ({
    request,
  }) => {
    const response = await request.get(
      "/admin/organizations/org-fake/search?q=flare",
      { maxRedirects: 0 },
    );
    // Redirect to /login (3xx) or a non-2xx — never a rendered result
    // page. The response must not carry search output for anonymous
    // callers under any circumstances.
    expect(response.ok()).toBe(false);
    const body = await response.text();
    expect(body).not.toContain("Search results");
  });
});
