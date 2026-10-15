import { OrgShell } from "@/components/org-shell";
import { getOrgShellProps } from "@/lib/org-shell-server";
import { requireOrgAccessOrNotFound } from "@/lib/auth/authorize";

export const dynamic = "force-dynamic";

export default async function OrganizationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  // Untrusted URL selector — grant checked against the real org; a
  // foreign or fabricated id is an opaque 404 before any data loads.
  const ctx = await requireOrgAccessOrNotFound(orgId);
  const shell = await getOrgShellProps(ctx, orgId);
  return <OrgShell {...shell}>{children}</OrgShell>;
}
