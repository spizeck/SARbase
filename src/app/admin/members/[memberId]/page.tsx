import { notFound, redirect } from "next/navigation";

import { getMember } from "@/lib/domain/member";
import { isOrgAdmin, requireAuth } from "@/lib/auth/authorize";

export const dynamic = "force-dynamic";

/**
 * Compatibility shim — member pages moved under the organization tree.
 * The grant check happens BEFORE the redirect so a member id reveals
 * nothing to an unauthorized caller.
 */
export default async function LegacyMemberPage({
  params,
}: {
  params: Promise<{ memberId: string }>;
}) {
  const ctx = await requireAuth();
  const { memberId } = await params;
  const member = await getMember(memberId);
  if (!member || !isOrgAdmin(ctx, member.organizationId)) notFound();
  redirect(
    `/admin/organizations/${member.organizationId}/members/${member.id}`,
  );
}
