import { describe, expect, it } from "vitest";
import type { OrgCapability } from "@prisma/client";

import { ORG_CAPABILITIES } from "@/lib/auth/capabilities";
import { orgNavGroups } from "@/lib/org-nav";

const ALL = [...ORG_CAPABILITIES];
const STAFF_ADMIN = { isAdmin: true, isStaff: true };
const STAFF_MEMBER = { isAdmin: false, isStaff: false };
const MANAGER = { isAdmin: false, isStaff: true };

/**
 * Role/capability-aware navigation: the map the sidebar renders.
 * Visibility is a UX concern only — every destination page re-checks
 * its own requirement server-side — but the map must still be exactly
 * right so nobody sees controls they cannot use (issue #84).
 */

describe("orgNavGroups", () => {
  it("members see only the dashboard entry", () => {
    const groups = orgNavGroups("org-1", [], STAFF_MEMBER);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("Overview");
    expect(groups[0]?.items).toEqual([
      { href: "/org/org-1", label: "Dashboard" },
    ]);
  });

  it("admins see every group, all inside the org's admin workspace", () => {
    const groups = orgNavGroups("org-1", ALL, STAFF_ADMIN);
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual([
      "Overview",
      "Operations",
      "People",
      "Equipment",
      "Administration",
      "Reporting",
    ]);

    const hrefs = groups.flatMap((g) => g.items.map((i) => i.href));
    // The dashboard is the only destination outside the admin tree.
    for (const href of hrefs.slice(1)) {
      expect(href).toMatch(/^\/admin\/organizations\/org-1\//);
    }
    // Every advertised workspace exists as a real route group.
    for (const path of [
      "/callouts",
      "/incidents",
      "/training",
      "/members",
      "/access",
      "/reviews",
      "/units",
      "/qualifications",
      "/expiring",
      "/assets",
      "/inventory",
      "/locations",
      "/maintenance",
      "/vendors",
      "/expenses",
      "/documents",
      "/notifications",
      "/search",
      "/settings",
      "/reports",
    ]) {
      expect(hrefs).toContain(`/admin/organizations/org-1${path}`);
    }
  });

  it("a manager sees only the workspaces their capabilities cover", () => {
    const groups = orgNavGroups(
      "org-1",
      ["TRAINING_MANAGE", "MEMBERS_MANAGE"] as OrgCapability[],
      MANAGER,
    );
    const hrefs = groups.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).toContain("/admin/organizations/org-1/training");
    expect(hrefs).toContain("/admin/organizations/org-1/members");
    expect(hrefs).toContain("/admin/organizations/org-1/units");
    // Staff surface without a specific capability — visible.
    expect(hrefs).toContain("/admin/organizations/org-1/search");
    // No grant, no nav entry.
    for (const absent of [
      "/callouts",
      "/incidents",
      "/assets",
      "/expenses",
      "/reports",
      "/qualifications",
    ]) {
      expect(hrefs).not.toContain(`/admin/organizations/org-1${absent}`);
    }
  });

  it("managers never see admin-only destinations", () => {
    const groups = orgNavGroups("org-1", ALL, MANAGER);
    const hrefs = groups.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).not.toContain("/admin/organizations/org-1/access");
    expect(hrefs).not.toContain("/admin/organizations/org-1/settings");
  });

  it("a manager with no capabilities keeps only dashboard and search", () => {
    const groups = orgNavGroups("org-1", [], MANAGER);
    const hrefs = groups.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).toEqual(["/org/org-1", "/admin/organizations/org-1/search"]);
  });

  it("embeds the caller's organization id, never a literal", () => {
    const groups = orgNavGroups("org-xyz", ALL, STAFF_ADMIN);
    const all = groups.flatMap((g) => g.items.map((i) => i.href));
    for (const href of all) {
      expect(href).toContain("org-xyz");
      expect(href).not.toContain("org-1");
    }
  });
});
