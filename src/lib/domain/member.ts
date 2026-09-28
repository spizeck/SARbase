import { prisma } from "@/lib/prisma";
import { log } from "@/lib/logging";

import type { MemberInput, MemberStatusInput } from "./schemas";

/**
 * Thrown when a member is assigned to a unit outside their organization.
 * Application-level guard producing a clear error; the composite foreign
 * keys on MemberUnit are the database-level guarantee behind it.
 */
export class CrossOrganizationAssignmentError extends Error {
  constructor() {
    super("Cannot assign a member to a unit of another organization.");
    this.name = "CrossOrganizationAssignmentError";
  }
}

/**
 * Member domain operations.
 *
 * A Member is a DOMAIN person record owned by exactly one organization —
 * not an authentication account. Volunteers exist here before any sign-in;
 * the future auth layer (issue #6) links an identity TO a member record.
 *
 * Deactivation is administrative (status ACTIVE ↔ INACTIVE) and preserves
 * identity and history — member rows are never destructively deleted from
 * the application surface, because incidents/training/expenses will
 * reference them later.
 */

export async function listMembers(
  organizationId: string,
  options: { unitId?: string } = {},
) {
  return prisma.member.findMany({
    where: {
      organizationId,
      ...(options.unitId
        ? { memberUnits: { some: { unitId: options.unitId } } }
        : {}),
    },
    orderBy: { displayName: "asc" },
    include: {
      memberUnits: {
        include: { unit: { select: { id: true, name: true } } },
      },
    },
  });
}

export async function getMember(id: string) {
  return prisma.member.findUnique({
    where: { id },
    include: {
      organization: { select: { id: true, name: true, timezone: true } },
      memberUnits: {
        include: { unit: { select: { id: true, name: true } } },
      },
    },
  });
}

export async function createMember(organizationId: string, input: MemberInput) {
  const member = await prisma.member.create({
    data: {
      organizationId,
      displayName: input.displayName,
      email: input.email ?? null,
      phone: input.phone ?? null,
    },
  });
  log({
    event: "member.created",
    subsystem: "domain",
    entityType: "Member",
    entityId: member.id,
    organizationId,
  });
  return member;
}

export async function updateMember(id: string, input: MemberInput) {
  const member = await prisma.member.update({
    where: { id },
    data: {
      displayName: input.displayName,
      email: input.email ?? null,
      phone: input.phone ?? null,
    },
  });
  log({
    event: "member.updated",
    subsystem: "domain",
    entityType: "Member",
    entityId: member.id,
    organizationId: member.organizationId,
  });
  return member;
}

/**
 * Administrative activate/deactivate. Status changes are ordinary column
 * updates for now — the audit-history work in a later issue is expected
 * to strengthen this into durable lifecycle records.
 */
export async function setMemberStatus(id: string, status: MemberStatusInput) {
  const member = await prisma.member.update({
    where: { id },
    data: { status },
  });
  log({
    event: "member.status_changed",
    subsystem: "domain",
    entityType: "Member",
    entityId: member.id,
    organizationId: member.organizationId,
    memberStatus: member.status,
  });
  return member;
}

/**
 * Replace a member's unit assignments with the given set.
 *
 * The member's organizationId is carried into each MemberUnit row, where
 * the composite foreign keys ((memberId, organizationId) → Member and
 * (unitId, organizationId) → Unit) make a cross-organization assignment
 * physically impossible — the application pre-check below exists only to
 * produce a clear error instead of a raw constraint violation.
 */
export async function setMemberUnits(memberId: string, unitIds: string[]) {
  const member = await prisma.member.findUniqueOrThrow({
    where: { id: memberId },
    select: { id: true, organizationId: true },
  });

  const uniqueUnitIds = [...new Set(unitIds)];
  if (uniqueUnitIds.length > 0) {
    const sameOrgCount = await prisma.unit.count({
      where: {
        id: { in: uniqueUnitIds },
        organizationId: member.organizationId,
      },
    });
    if (sameOrgCount !== uniqueUnitIds.length) {
      throw new CrossOrganizationAssignmentError();
    }
  }

  await prisma.$transaction([
    prisma.memberUnit.deleteMany({ where: { memberId } }),
    prisma.memberUnit.createMany({
      data: uniqueUnitIds.map((unitId) => ({
        organizationId: member.organizationId,
        memberId,
        unitId,
      })),
    }),
  ]);

  log({
    event: "member.units_updated",
    subsystem: "domain",
    entityType: "Member",
    entityId: member.id,
    organizationId: member.organizationId,
    unitCount: uniqueUnitIds.length,
  });
}
