import { createHash, createHmac } from "node:crypto";

import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { PrismaClient } from "@prisma/client";

/**
 * Public callout-response surface (issue #14).
 *
 * The invalid-link path needs no database — `/respond` without a token
 * renders the opaque invalid card without a query.
 *
 * The token flows need a real database: fixtures are created directly
 * with Prisma (a callout + invitation whose `responseTokenHash` is the
 * SHA-256 of a token only this test knows — exactly what the emailed
 * link carries). These tests skip cleanly when DATABASE_URL is absent
 * (e.g. the CI smoke job, which runs build-only).
 */

test.describe("callout response — invalid link", () => {
  test("missing token renders the opaque invalid-link card", async ({
    page,
  }) => {
    await page.goto("/respond");
    await expect(
      page.getByRole("heading", { name: "SARbase callout" }),
    ).toBeVisible();
    await expect(page.getByText(/isn't valid/i)).toBeVisible();
    // No invitee/org data is exposed on the invalid path.
    await expect(page.getByText(/responding for/i)).toHaveCount(0);
  });

  test("invalid-link card has no automatically detectable WCAG violations", async ({
    page,
  }) => {
    await page.goto("/respond");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("callout response — token flow", () => {
  const prisma = new PrismaClient();
  // The fixture token must be the token the server would derive for
  // this invitation — the response path verifies against the live
  // derivation, not just the stored hash. Same pepper as the smoke
  // server's webServer env (playwright.config.ts).
  const TOKEN_SECRET =
    process.env.CALLOUT_RESPONSE_TOKEN_SECRET ||
    "smoke-test-callout-token-secret";

  let rawToken = "";
  let organizationId = "";
  let memberId = "";
  let calloutId = "";
  let invitationId = "";
  let dbAvailable = false;

  test.beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbAvailable = true;
    } catch {
      // No database configured for the smoke server (e.g. the CI
      // build-only job) — the token-flow tests report skipped.
      dbAvailable = false;
    }
    if (!dbAvailable) return;

    const organization = await prisma.organization.create({
      data: { name: "e2e-callout-org" },
    });
    organizationId = organization.id;
    const member = await prisma.member.create({
      data: {
        organizationId,
        displayName: "E2E Volunteer",
        email: "e2e-volunteer@example.test",
      },
    });
    memberId = member.id;
    const callout = await prisma.callout.create({
      data: {
        organizationId,
        createdByAuthIdentityId: "e2e-actor",
        audience: "MEMBERS",
        title: "E2E fixture callout",
        message: "Fixture initial information.",
        activationKey: `e2e-${Date.now()}`,
        intentHash: "e2e",
      },
    });
    calloutId = callout.id;
    // Derivation mirrors src/lib/domain/calloutTokens.ts —
    // base64url(HMAC-SHA256(pepper, "callout-response:<calloutId>:<memberId>")).
    rawToken = createHmac("sha256", TOKEN_SECRET)
      .update(`callout-response:${calloutId}:${memberId}`)
      .digest("base64url");
    const invitation = await prisma.calloutInvitation.create({
      data: {
        organizationId,
        calloutId,
        memberId,
        responseTokenHash: createHash("sha256").update(rawToken).digest("hex"),
      },
    });
    invitationId = invitation.id;
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
    await prisma.$disconnect();
  });

  test.beforeEach(() => {
    test.skip(!dbAvailable, "DATABASE_URL unavailable to the smoke server");
  });

  test("valid token responds, changes mind, and never sees other invitees", async ({
    page,
  }) => {
    await page.goto(`/respond?t=${rawToken}`);

    // The invitee sees the callout, their own name, and the two large
    // response buttons — nothing about other invitees or counts.
    await expect(
      page.getByRole("heading", { name: "E2E fixture callout" }),
    ).toBeVisible();
    await expect(page.getByText(/E2E Volunteer/)).toBeVisible();
    const coming = page.getByRole("button", { name: /coming/i });
    const unavailable = page.getByRole("button", { name: /unavailable/i });
    await expect(coming).toBeVisible();
    await expect(unavailable).toBeVisible();
    await expect(page.getByText(/invited/i)).toHaveCount(0);

    await coming.click();
    await expect(page.getByText(/current response/i)).toContainText("Coming");

    await unavailable.click();
    await expect(page.getByText(/current response/i)).toContainText(
      "Unavailable",
    );

    // The durable record agrees — current state plus append-only history.
    const invitation = await prisma.calloutInvitation.findUniqueOrThrow({
      where: { id: invitationId },
    });
    expect(invitation.response).toBe("UNAVAILABLE");
    expect(invitation.respondedAt).not.toBeNull();
    const changes = await prisma.calloutResponseChange.findMany({
      where: { invitationId },
      orderBy: { createdAt: "asc" },
    });
    expect(changes.map((c) => c.response)).toEqual(["COMING", "UNAVAILABLE"]);
    expect(changes.every((c) => c.source === "TOKEN_LINK")).toBe(true);
  });

  test("response page has no automatically detectable WCAG violations", async ({
    page,
  }) => {
    await page.goto(`/respond?t=${rawToken}`);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test("a bogus token shows only the opaque invalid-link card", async ({
    page,
  }) => {
    await page.goto("/respond?t=not-a-real-token");
    await expect(page.getByText(/isn't valid/i)).toBeVisible();
    await expect(page.getByText(/E2E Volunteer/)).toHaveCount(0);
  });
});
