import { prisma } from "@/lib/prisma";
import { log } from "@/lib/logging";

import type { OrganizationInput } from "./schemas";

/**
 * Organization domain operations — the record-owning boundary every
 * other record scopes to. Organization has deliberately minimal fields;
 * see docs/domain-model.md.
 */
export async function listOrganizations() {
  return prisma.organization.findMany({
    orderBy: { name: "asc" },
    include: {
      _count: { select: { units: true, members: true } },
    },
  });
}

export async function getOrganization(id: string) {
  return prisma.organization.findUnique({
    where: { id },
    include: {
      units: { orderBy: { name: "asc" } },
    },
  });
}

export async function createOrganization(input: {
  name: string;
  timezone?: string;
}) {
  const organization = await prisma.organization.create({
    data: { name: input.name, timezone: input.timezone ?? "UTC" },
  });
  log({
    event: "organization.created",
    subsystem: "domain",
    entityType: "Organization",
    entityId: organization.id,
  });
  return organization;
}

export async function updateOrganization(id: string, input: OrganizationInput) {
  const organization = await prisma.organization.update({
    where: { id },
    data: {
      name: input.name,
      timezone: input.timezone,
      // The setup checklist's "review settings" item reads this — it is
      // stamped only here, by an actual settings save, never inferred
      // from @updatedAt (any unrelated org write bumps that).
      settingsReviewedAt: new Date(),
    },
  });
  log({
    event: "organization.updated",
    subsystem: "domain",
    entityType: "Organization",
    entityId: organization.id,
  });
  return organization;
}
