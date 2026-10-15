/**
 * Organization workspace navigation. One declarative map drives the
 * sidebar for every org-scoped surface (`/org/[orgId]` and
 * `/admin/organizations/[orgId]/*`).
 *
 * `adminOnly` items are hidden from non-admin members as a UX matter —
 * it is NOT an authorization control. Every admin page enforces its own
 * server-side grant; a member who guesses a URL still gets the opaque
 * 404.
 */

export interface OrgNavItem {
  /** Path appended to the workspace root. */
  href: string;
  label: string;
}

export interface OrgNavGroup {
  label: string;
  items: OrgNavItem[];
}

const ADMIN_PREFIX = "/admin/organizations";

export function orgNavGroups(orgId: string, isAdmin: boolean): OrgNavGroup[] {
  const admin = (path: string) => `${ADMIN_PREFIX}/${orgId}${path}`;
  const groups: OrgNavGroup[] = [
    {
      label: "Overview",
      items: [{ href: `/org/${orgId}`, label: "Dashboard" }],
    },
  ];

  if (!isAdmin) return groups;

  groups.push(
    {
      label: "Operations",
      items: [
        { href: admin("/callouts"), label: "Callouts" },
        { href: admin("/incidents"), label: "Incidents" },
        { href: admin("/training"), label: "Training" },
      ],
    },
    {
      label: "People",
      items: [
        { href: admin("/members"), label: "Members" },
        { href: admin("/units"), label: "Units" },
        { href: admin("/qualifications"), label: "Qualifications" },
        { href: admin("/expiring"), label: "Expiring certifications" },
      ],
    },
    {
      label: "Equipment",
      items: [
        { href: admin("/assets"), label: "Assets" },
        { href: admin("/inventory"), label: "Inventory" },
        { href: admin("/locations"), label: "Storage locations" },
        { href: admin("/maintenance"), label: "Maintenance" },
      ],
    },
    {
      label: "Administration",
      items: [
        { href: admin("/vendors"), label: "Vendors" },
        { href: admin("/expenses"), label: "Expenses" },
        { href: admin("/documents"), label: "Documents" },
        { href: admin("/notifications"), label: "Notifications" },
        { href: admin("/search"), label: "Search records" },
        { href: admin("/settings"), label: "Organization settings" },
      ],
    },
    {
      label: "Reporting",
      items: [{ href: admin("/reports"), label: "Reports & exports" }],
    },
  );
  return groups;
}
