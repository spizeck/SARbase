import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

/**
 * Authenticated hosted smoke coverage (workstream: hosted app testing).
 *
 * These specs run ONLY in the hosted config's `authenticated` project
 * (playwright.hosted.config.ts) — never in the local CI suite, which
 * cannot provision Firebase sessions. global-setup signs in through the
 * real login journey with SMOKE_TEST_EMAIL/SMOKE_TEST_PASSWORD and
 * stores the session cookie; without those variables every spec here
 * skips cleanly.
 *
 * The test identity is provisioned out-of-band (preview Firebase user +
 * `admin:provision` grant on the seeded preview organization — see
 * docs/hosted-smoke-testing.md). Specs assert authenticated contract,
 * not seeded row contents: org membership varies with what the operator
 * granted the smoke identity.
 */
const hasCredentials = Boolean(
  process.env.SMOKE_TEST_EMAIL && process.env.SMOKE_TEST_PASSWORD,
);

test.describe("authenticated session", () => {
  test.skip(
    !hasCredentials,
    "SMOKE_TEST_EMAIL/SMOKE_TEST_PASSWORD not configured — authenticated hosted coverage requires a provisioned smoke identity (docs/hosted-smoke-testing.md)",
  );

  test("the session survives navigation — /admin does not bounce to login", async ({
    page,
  }) => {
    // /admin redirects to the shared organization workspace at /org —
    // either the chooser (multi-org) or straight through to the single
    // accessible organization's dashboard.
    await page.goto("/admin");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(/\/org(\/|$)/);
    // Either branch is a correct authed render — org grants depend on
    // what the operator provisioned for the smoke identity.
    await expect(
      page
        .getByRole("heading", { name: "Your organizations" })
        .or(page.getByRole("heading").first()),
    ).toBeVisible();
  });

  test("/account renders the signed-in identity", async ({ page }) => {
    await page.goto("/account");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByText(process.env.SMOKE_TEST_EMAIL!)).toBeVisible();
  });

  test("organization workspaces resolve under the session", async ({
    page,
  }) => {
    await page.goto("/org");
    // A single-grant account is redirected straight to its dashboard;
    // multi-grant accounts land on the chooser first.
    if (!/\/org\/[a-z0-9]+$/i.test(page.url())) {
      // On the chooser: follow the first organization link. Without org
      // grants the empty state is the honest assertion.
      const orgLink = page
        .getByRole("link")
        .filter({ hasText: /Admin|Member/ })
        .first();
      if ((await orgLink.count()) === 0) {
        await expect(
          page.getByText(/does not belong to an organization/),
        ).toBeVisible();
        return;
      }
      await orgLink.click();
      await expect(page).toHaveURL(/\/org\/[a-z0-9]+$/i);
    }
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("attachment downloads remain authorized under the session", async ({
    request,
  }) => {
    // A fabricated id still fails opaquely — the session authorizes the
    // route, it does not reveal record existence across organizations.
    const response = await request.get(
      "/api/attachments/att-nonexistent/download",
    );
    expect([404, 401, 403]).toContain(response.status());
    const body = await response.text();
    expect(body.length).toBeLessThan(4096);
  });

  test("the reports page is understandable and accessible", async ({
    page,
  }) => {
    // Reports & exports is admin-gated: reach it through the org nav
    // when the smoke identity has admin access, otherwise skip.
    await page.goto("/org");
    let isAdmin: boolean | null = null;
    if (!/\/org\/[a-z0-9]+/i.test(page.url())) {
      // Chooser — wait for it to render before judging membership, and
      // use the per-org role badge to establish the grant rather than
      // treating a missing nav link as proof of a missing role.
      await expect(
        page.getByRole("heading", { name: "Your organizations" }),
      ).toBeVisible();
      // Match the exact role-badge text inside the link — an org named
      // e.g. "Admin Team" must not masquerade as an admin grant.
      const adminLink = page
        .getByRole("link")
        .filter({ has: page.getByText("Admin", { exact: true }) })
        .first();
      const memberLink = page
        .getByRole("link")
        .filter({ has: page.getByText("Member", { exact: true }) })
        .first();
      if (await adminLink.count()) {
        isAdmin = true;
        await adminLink.click();
      } else if (await memberLink.count()) {
        isAdmin = false;
        await memberLink.click();
      } else {
        test.skip(true, "smoke identity has no organization grant");
        return;
      }
    } else {
      // Landed directly on a workspace — confirm the shell nav has
      // rendered before judging whether the reports link exists.
      await expect(page.getByRole("navigation").first()).toBeVisible();
    }
    const reportsLink = page.getByRole("link", {
      name: "Reports & exports",
    });
    if (isAdmin === false) {
      test.skip(true, "smoke identity is not an organization admin");
      return;
    }
    if (isAdmin === true) {
      // Known admin: the link must appear — fail rather than skip.
      await expect(reportsLink).toBeVisible();
    } else if ((await reportsLink.count()) === 0) {
      // Role unknown (direct redirect) but nav is rendered — a missing
      // link here genuinely means no admin access.
      test.skip(true, "smoke identity is not an organization admin");
      return;
    }
    await reportsLink.click();
    await expect(page).toHaveURL(/\/reports$/);

    // Plain-language contract (issue #73): a consistent download action
    // and no implementation vocabulary leaking into coordinator copy.
    await expect(
      page.getByRole("heading", { name: /Download your data/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Download CSV" }).first(),
    ).toBeVisible();
    // innerText, not textContent: closed <details> help blocks keep
    // technical terms in the DOM legitimately — this asserts on what a
    // coordinator actually sees.
    const bodyText = await page.locator("main").innerText();
    for (const term of [
      "tombstone",
      "append-only",
      "linkType",
      "targetId",
      "amountMinor",
    ]) {
      expect(bodyText.toLowerCase()).not.toContain(term.toLowerCase());
    }

    // Progressive disclosure is required, not optional — open the first
    // help summary so axe also evaluates the revealed technical detail.
    const summary = page.locator("main details > summary").first();
    await expect(summary).toBeVisible();
    await summary.click();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test("the appearance control exists in the header and applies a choice", async ({
    page,
  }) => {
    // Any org workspace renders the shell header with the theme menu.
    await page.goto("/org");
    if (!/\/org\/[a-z0-9]+/i.test(page.url())) {
      const orgLink = page
        .getByRole("link")
        .filter({ hasText: /Admin|Member/ })
        .first();
      if ((await orgLink.count()) === 0) {
        test.skip(true, "smoke identity has no organization grant");
        return;
      }
      await orgLink.click();
    }
    const trigger = page.getByRole("button", { name: /^Appearance:/ });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(trigger).toHaveAccessibleName("Appearance: Dark");
  });

  test("/account exposes the appearance setting", async ({ page }) => {
    await page.goto("/account");
    await expect(
      page.getByRole("heading", { name: "Appearance" }),
    ).toBeVisible();
    const darkRadio = page.getByRole("radio", { name: /Dark/ });
    await darkRadio.check();
    await expect(darkRadio).toBeChecked();
    await expect(page.locator("html")).toHaveClass(/dark/);
    // Reset to system so the shared smoke identity's browser state does
    // not leak a theme into other specs.
    await page.getByRole("radio", { name: /System/ }).check();
  });
});
