import { OrgShell } from "@/components/org-shell";
import { getOrgShellProps } from "@/lib/org-shell-server";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";

export const dynamic = "force-dynamic";

/**
 * Admin workspace shell. The whole /admin/organizations/[orgId]/* subtree
 * is administrator-only, so this layout enforces the admin grant itself —
 * member visitors get the same opaque 404 as every page below.
 */
export default async function OrganizationAdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const ctx = await requireOrgAdminOrNotFound(orgId);
  const shell = await getOrgShellProps(ctx, orgId);
  return <OrgShell {...shell}>{children}</OrgShell>;
}
