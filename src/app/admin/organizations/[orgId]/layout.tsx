import { OrgShell } from "@/components/org-shell";
import { getOrgShellProps } from "@/lib/org-shell-server";
import { requireOrgStaffOrNotFound } from "@/lib/auth/authorize";

export const dynamic = "force-dynamic";

/**
 * Admin workspace shell. The /admin/organizations/[orgId]/* subtree is
 * staff-only (ADMIN or MANAGER) — member visitors get the same opaque
 * 404 as every page below. This is only the shell gate: each page
 * enforces its own capability, and a manager sees only the nav items
 * their grants cover.
 */
export default async function OrganizationAdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const ctx = await requireOrgStaffOrNotFound(orgId);
  const shell = await getOrgShellProps(ctx, orgId);
  return <OrgShell {...shell}>{children}</OrgShell>;
}
