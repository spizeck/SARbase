import { notFound, redirect } from "next/navigation";

import { getAsset } from "@/lib/domain/assets";
import { OrgCapability } from "@prisma/client";

import { hasOrgCapability, requireAuth } from "@/lib/auth/authorize";

export const dynamic = "force-dynamic";

/**
 * Compatibility shim — asset pages moved under the organization tree.
 * The grant check happens BEFORE the redirect so an asset id reveals
 * nothing to an unauthorized caller.
 */
export default async function LegacyAssetPage({
  params,
}: {
  params: Promise<{ assetId: string }>;
}) {
  const ctx = await requireAuth();
  const { assetId } = await params;
  const asset = await getAsset(assetId);
  if (
    !asset ||
    !hasOrgCapability(ctx, asset.organizationId, OrgCapability.EQUIPMENT_MANAGE)
  )
    notFound();
  redirect(`/admin/organizations/${asset.organizationId}/assets/${asset.id}`);
}
