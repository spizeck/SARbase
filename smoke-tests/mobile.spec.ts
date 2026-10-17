import { createHash, createHmac } from "node:crypto";

import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { PrismaClient } from "@prisma/client";

/**
 * Mobile regression coverage (issue #119) — runs only in the
 * `mobile-chromium` project (phone-sized viewport).
 *
 * SARbase is often used on phones during a real callout. These specs
 * exercise the two highest-stakes unauthenticated surfaces — the
 * response link and the login screen — for layout overflow and
 * thumb-sized tap targets that a desktop viewport cannot catch.
 *
 * The token flow needs a real database and skips cleanly without one,
 * matching callout-response.spec.ts.
 */

/** No horizontal scrolling — content fits the viewport width. */
async function expectNoHorizontalOverflow(
  page: import("@playwright/test").Page,
) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("mobile usability", { tag: "@mobile" }, () => {
  test("login renders without horizontal overflow", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: /sign in|log in/i }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("invalid-link card is readable without overflow", async ({ page }) => {
    await page.goto("/respond");
    await expect(page.getByText(/isn't valid/i)).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("mobile callout response", { tag: "@mobile" }, () => {
  const databaseUrl =
    process.env.SMOKE_DATABASE_URL ?? process.env.DATABASE_URL;
  const TOKEN_SECRET =
    process.env.CALLOUT_RESPONSE_TOKEN_SECRET ||
    "smoke-test-callout-token-secret";

  let prisma!: PrismaClient;
  let rawToken = "";
  let organizationId = "";
  let memberId = "";
  let calloutId = "";
  let dbAvailable = false;

  test.beforeAll(async () => {
    if (databaseUrl) {
      prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      try {
        await prisma.$queryRaw`SELECT 1`;
        dbAvailable = true;
      } catch {
        dbAvailable = false;
      }
    }
    if (!dbAvailable) return;

    const organization = await prisma.organization.create({
      data: { name: "e2e-mobile-org" },
    });
    organizationId = organization.id;
    const member = await prisma.member.create({
      data: {
        organizationId,
        displayName: "E2E Mobile Volunteer",
        email: "e2e-mobile@example.test",
      },
    });
    memberId = member.id;
    const callout = await prisma.callout.create({
      data: {
        organizationId,
        createdByAuthIdentityId: "e2e-actor",
        audience: "MEMBERS",
        title: "E2E mobile fixture callout",
        message: "Fixture initial information.",
        activationKey: `e2e-mobile-${Date.now()}`,
        intentHash: "e2e",
      },
    });
    calloutId = callout.id;
    rawToken = createHmac("sha256", TOKEN_SECRET)
      .update(`callout-response:${calloutId}:${memberId}`)
      .digest("base64url");
    await prisma.calloutInvitation.create({
      data: {
        organizationId,
        calloutId,
        memberId,
        responseTokenHash: createHash("sha256").update(rawToken).digest("hex"),
      },
    });
  });

  test.afterAll(async () => {
    if (dbAvailable) {
      await prisma.calloutResponseChange.deleteMany({
        where: { organizationId },
      });
      await prisma.calloutInvitation.deleteMany({ where: { organizationId } });
      await prisma.callout.deleteMany({ where: { organizationId } });
      await prisma.member.deleteMany({ where: { organizationId } });
      await prisma.organization.delete({ where: { id: organizationId } });
    }
    if (prisma) await prisma.$disconnect();
  });

  test.beforeEach(() => {
    test.skip(!dbAvailable, "DATABASE_URL unavailable to the smoke server");
  });

  test("response buttons are thumb-sized and work at phone width", async ({
    page,
  }) => {
    await page.goto(`/respond?t=${rawToken}`);
    await expect(
      page.getByRole("heading", { name: "E2E mobile fixture callout" }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const coming = page.getByRole("button", { name: /coming/i });
    const unavailable = page.getByRole("button", { name: /unavailable/i });
    // WCAG 2.5.5 target size: at least 44×44 CSS pixels.
    for (const button of [coming, unavailable]) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }

    await coming.click();
    await expect(page.getByText(/current response/i)).toContainText("Coming");
  });

  test("response page has no WCAG violations at phone width", async ({
    page,
  }) => {
    await page.goto(`/respond?t=${rawToken}`);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
