import type { OrgCapability } from "@prisma/client";

/**
 * Organization workspace navigation. One declarative map drives the
 * sidebar for every org-scoped surface (`/org/[orgId]` and
 * `/admin/organizations/[orgId]/*`).
 *
 * Items filter on the caller's role/capabilities as a UX matter — it is
 * NOT an authorization control. Every page enforces its own server-side
 * requirement; a member or manager who guesses a URL still gets the
 * opaque 404.
 */

export interface OrgNavItem {
  /** Path appended to the workspace root. */
  href: string;
  label: string;
  /** Staff capability required to see the item (absent = any staff). */
  capability?: OrgCapability;
  /** Reserved to ADMIN regardless of manager capabilities. */
  adminOnly?: boolean;
  /** Staff surface with no specific capability (visible to any staff). */
  staffOnly?: boolean;
}

export interface OrgNavGroup {
  label: string;
  items: OrgNavItem[];
}

const ADMIN_PREFIX = "/admin/organizations";

export function orgNavGroups(
  orgId: string,
  capabilities: readonly OrgCapability[],
  staff: { isAdmin: boolean; isStaff: boolean },
): OrgNavGroup[] {
  const { isAdmin, isStaff } = staff;
  const admin = (path: string) => `${ADMIN_PREFIX}/${orgId}${path}`;
  const groups: OrgNavGroup[] = [
    {
      label: "Overview",
      items: [{ href: `/org/${orgId}`, label: "Dashboard" }],
    },
    {
      label: "Operations",
      items: [
        {
          href: admin("/callouts"),
          label: "Callouts",
          capability: "OPERATIONS_MANAGE",
        },
        {
          href: admin("/incidents"),
          label: "Incidents",
          capability: "OPERATIONS_MANAGE",
        },
        {
          href: admin("/training"),
          label: "Training",
          capability: "TRAINING_MANAGE",
        },
      ],
    },
    {
      label: "People",
      items: [
        {
          href: admin("/members"),
          label: "Members",
          capability: "MEMBERS_MANAGE",
        },
        { href: admin("/access"), label: "Access & roles", adminOnly: true },
        {
          href: admin("/reviews"),
          label: "Submissions",
          capability: "QUALIFICATIONS_VERIFY",
        },
        { href: admin("/units"), label: "Units", capability: "MEMBERS_MANAGE" },
        {
          href: admin("/qualifications"),
          label: "Qualifications",
          capability: "QUALIFICATIONS_MANAGE",
        },
        {
          href: admin("/expiring"),
          label: "Expiring certifications",
          capability: "QUALIFICATIONS_MANAGE",
        },
      ],
    },
    {
      label: "Equipment",
      items: [
        {
          href: admin("/assets"),
          label: "Assets",
          capability: "EQUIPMENT_MANAGE",
        },
        {
          href: admin("/inventory"),
          label: "Inventory",
          capability: "EQUIPMENT_MANAGE",
        },
        {
          href: admin("/locations"),
          label: "Storage locations",
          capability: "EQUIPMENT_MANAGE",
        },
        {
          href: admin("/maintenance"),
          label: "Maintenance",
          capability: "EQUIPMENT_MANAGE",
        },
      ],
    },
    {
      label: "Administration",
      items: [
        {
          href: admin("/vendors"),
          label: "Vendors",
          capability: "FINANCE_MANAGE",
        },
        {
          href: admin("/expenses"),
          label: "Expenses",
          capability: "FINANCE_MANAGE",
        },
        {
          href: admin("/documents"),
          label: "Documents",
          capability: "DOCUMENTS_MANAGE",
        },
        {
          href: admin("/notifications"),
          label: "Notifications",
          capability: "NOTIFICATIONS_MANAGE",
        },
        { href: admin("/search"), label: "Search records", staffOnly: true },
        {
          href: admin("/settings"),
          label: "Organization settings",
          adminOnly: true,
        },
      ],
    },
    {
      label: "Reporting",
      items: [
        {
          href: admin("/reports"),
          label: "Reports & exports",
          capability: "REPORTS_EXPORT",
        },
      ],
    },
  ];

  const caps = new Set<OrgCapability>(capabilities);
  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter(
        (i) =>
          (!i.adminOnly || isAdmin) &&
          (!i.staffOnly || isStaff) &&
          (!i.capability || caps.has(i.capability)),
      ),
    }))
    .filter((g) => g.items.length > 0);
}
