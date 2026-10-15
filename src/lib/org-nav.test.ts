import { describe, expect, it } from "vitest";

import { orgNavGroups } from "@/lib/org-nav";

/**
 * Role-aware navigation: the map the sidebar renders. Hiding admin
 * entries for members is a UX concern only — every destination page
 * re-checks the ADMIN grant server-side — but the map must still be
 * exactly right so members never see controls they cannot use.
 */

describe("orgNavGroups", () => {
  it("members see only the dashboard entry", () => {
    const groups = orgNavGroups("org-1", false);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("Overview");
    expect(groups[0]?.items).toEqual([
      { href: "/org/org-1", label: "Dashboard" },
    ]);
  });

  it("admins see every group, all inside the org's admin workspace", () => {
    const groups = orgNavGroups("org-1", true);
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

  it("embeds the caller's organization id, never a literal", () => {
    const groups = orgNavGroups("org-xyz", true);
    const all = groups.flatMap((g) => g.items.map((i) => i.href));
    for (const href of all) {
      expect(href).toContain("org-xyz");
      expect(href).not.toContain("org-1");
    }
  });
});
