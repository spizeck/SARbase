import { notFound, redirect } from "next/navigation";

import { getTrainingEvent } from "@/lib/domain/training";
import { OrgCapability } from "@prisma/client";

import { hasOrgCapability, requireAuth } from "@/lib/auth/authorize";

export const dynamic = "force-dynamic";

/**
 * Compatibility shim — training event pages moved under the organization
 * tree. The grant check happens BEFORE the redirect so an event id
 * reveals nothing to an unauthorized caller.
 */
export default async function LegacyTrainingEventPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const ctx = await requireAuth();
  const { eventId } = await params;
  const event = await getTrainingEvent(eventId);
  if (
    !event ||
    !hasOrgCapability(ctx, event.organizationId, OrgCapability.TRAINING_MANAGE)
  )
    notFound();
  redirect(`/admin/organizations/${event.organizationId}/training/${event.id}`);
}
