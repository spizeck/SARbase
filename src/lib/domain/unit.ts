import { prisma } from "@/lib/prisma";
import { log } from "@/lib/logging";

import type { UnitInput } from "./schemas";

/**
 * Unit domain operations. Units are optional internal groupings owned by
 * exactly one organization (organizationId FK is RESTRICT — an
 * organization cannot be deleted while units exist).
 */
export async function listUnits(organizationId: string) {
  return prisma.unit.findMany({
    where: { organizationId },
    orderBy: { name: "asc" },
    include: { _count: { select: { memberUnits: true } } },
  });
}

export async function createUnit(organizationId: string, input: UnitInput) {
  const unit = await prisma.unit.create({
    data: { organizationId, name: input.name },
  });
  log({
    event: "unit.created",
    subsystem: "domain",
    entityType: "Unit",
    entityId: unit.id,
    organizationId,
  });
  return unit;
}

export async function updateUnit(id: string, input: UnitInput) {
  const unit = await prisma.unit.update({
    where: { id },
    data: { name: input.name },
  });
  log({
    event: "unit.updated",
    subsystem: "domain",
    entityType: "Unit",
    entityId: unit.id,
    organizationId: unit.organizationId,
  });
  return unit;
}
