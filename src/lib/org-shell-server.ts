import { notFound } from "next/navigation";

import { prisma } from "@/lib/prisma";
import { getOrganization } from "@/lib/domain/organization";
import { isOrgAdmin } from "@/lib/auth/authorize";
import type { AuthContext } from "@/lib/auth/context";
import type { ShellOrganization } from "@/components/org-shell";

/**
 * Resolve the props the OrgShell needs after a caller's access check:
 * the organization (404 if gone) and the caller's full set of accessible
 * organizations for the switcher. Grants come from the verified session
 * context — the URL orgId only selects WHICH grant is checked.
 */
export async function getOrgShellProps(
  ctx: AuthContext,
  orgId: string,
): Promise<{
  orgId: string;
  orgName: string;
  role: "ADMIN" | "MEMBER";
  organizations: ShellOrganization[];
}> {
  const organization = await getOrganization(orgId);
  if (!organization) notFound();
  const orgIds = ctx.access.map((a) => a.organizationId);
  const rows = await prisma.organization.findMany({
    where: { id: { in: orgIds } },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  return {
    orgId,
    orgName: organization.name,
    role: isOrgAdmin(ctx, orgId) ? "ADMIN" : "MEMBER",
    organizations: rows.map((o) => ({
      id: o.id,
      name: o.name,
      role: isOrgAdmin(ctx, o.id) ? "ADMIN" : "MEMBER",
    })),
  };
}
