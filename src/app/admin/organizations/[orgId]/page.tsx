import { redirect } from "next/navigation";

import { requireOrgAccessOrNotFound } from "@/lib/auth/authorize";

export const dynamic = "force-dynamic";

/**
 * Compatibility redirect — the old admin monolith is replaced by the
 * shared organization dashboard at /org/[orgId]. The access check runs
 * before the redirect so an org id reveals nothing to a caller without
 * a grant for it.
 */
export default async function OrganizationAdminIndexPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  await requireOrgAccessOrNotFound(orgId);
  redirect(`/org/${orgId}`);
}
