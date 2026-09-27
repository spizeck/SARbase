import { test, expect } from "@playwright/test";

test.describe("smoke", () => {
  test("home page renders the SARbase shell", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "SARbase", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveTitle(/SARbase/);
  });

  test("unknown routes render the not-found page", async ({ page }) => {
    const response = await page.goto("/definitely-not-a-route");
    expect(response?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
  });

  test("health endpoint reports the database check honestly", async ({
    request,
  }) => {
    const response = await request.get("/api/health");
    const body = await response.json();
    // With DATABASE_URL configured the check is healthy/200; without it
    // (e.g. CI smoke runs with no database) the endpoint must honestly
    // report degraded/503 rather than pretending to be up.
    expect(typeof body.checks?.database?.ok).toBe("boolean");
    if (body.checks.database.ok) {
      expect(response.status()).toBe(200);
      expect(body.status).toBe("healthy");
    } else {
      expect(response.status()).toBe(503);
      expect(body.status).toBe("degraded");
    }
  });

  test("security headers are present on responses", async ({ request }) => {
    const response = await request.get("/");
    const headers = response.headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  test("robots.txt and sitemap.xml resolve", async ({ request }) => {
    const robots = await request.get("/robots.txt");
    expect(robots.status()).toBe(200);
    expect(await robots.text()).toContain("Sitemap:");

    const sitemap = await request.get("/sitemap.xml");
    expect(sitemap.status()).toBe(200);
    expect(await sitemap.text()).toContain("<loc>");
  });
});
