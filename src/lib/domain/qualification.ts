import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { log } from "@/lib/logging";

import type {
  MemberQualificationInput,
  QualificationDefinitionInput,
  QualificationDefinitionStatusInput,
} from "./schemas";

/**
 * Qualification domain operations.
 *
 * PRODUCT BOUNDARY: qualification records are factual administrative
 * records ONLY. Nothing here computes operational fitness, mission
 * eligibility, crew sufficiency, or launch readiness — SARbase states
 * facts ("expires Nov 14", "expired 12 days ago") and qualified SAR
 * personnel draw the conclusions.
 *
 * Two record types:
 * - QualificationDefinition — the organization's own definition of what
 *   it tracks ("we record CPR"). INACTIVE stops new assignment; it does
 *   NOT invalidate or hide historical MemberQualification records.
 * - MemberQualification — append-only evidence rows. A renewal is a NEW
 *   record; history is preserved, never overwritten. Dates are
 *   calendar dates (@db.Date, UTC-midnight Dates) — an expiry date means
 *   "valid through that day, expired the next".
 */

export class CrossOrganizationQualificationError extends Error {
  constructor() {
    super(
      "Cannot record a qualification from another organization's definition.",
    );
    this.name = "CrossOrganizationQualificationError";
  }
}

export class InactiveQualificationError extends Error {
  constructor() {
    super(
      "This qualification definition is inactive — it cannot receive new records.",
    );
    this.name = "InactiveQualificationError";
  }
}

/* ------------------------------------------------------------------ */
/* Date/expiry helpers (pure, deterministic, timezone-safe)            */
/* ------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Today's calendar date pinned to UTC midnight. */
export function todayUtc(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** Whole days from `from` to `to`, both treated as calendar dates. */
export function daysBetween(from: Date, to: Date): number {
  const utc = (d: Date) =>
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}

/** "YYYY-MM-DD" — the canonical date-only rendering of a stored date. */
export function formatDateOnly(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

export type ExpiryState = "no_expiry" | "expired" | "expiring_soon" | "current";

export interface ExpiryInfo {
  state: ExpiryState;
  /** Days until expiry; negative once expired. null when no expiry. */
  daysUntil: number | null;
}

/**
 * Factual expiry state for one record.
 *
 * - no expiry recorded      → no_expiry
 * - expiresOn <  today      → expired (expiry date is the last valid day)
 * - expiresOn <= today+win  → expiring_soon (includes "expires today")
 * - otherwise               → current
 *
 * `windowDays` is purely a presentation/reporting window — it is NOT an
 * organizational renewal policy and implies no requirement.
 */
export function expiryInfo(
  expiresOn: Date | null,
  today: Date = todayUtc(),
  windowDays = 30,
): ExpiryInfo {
  if (!expiresOn) return { state: "no_expiry", daysUntil: null };
  const daysUntil = daysBetween(today, expiresOn);
  if (daysUntil < 0) return { state: "expired", daysUntil };
  if (daysUntil <= windowDays) return { state: "expiring_soon", daysUntil };
  return { state: "current", daysUntil };
}

/**
 * Factual, non-evaluative label for a record's expiry — suitable for UI.
 * Never says "qualified"/"valid for duty"; states only date facts.
 */
export function expiryLabel(
  expiresOn: Date | null,
  today: Date = todayUtc(),
  windowDays = 30,
): string {
  const { state, daysUntil } = expiryInfo(expiresOn, today, windowDays);
  const formatted = expiresOn ? formatDateOnly(expiresOn) : null;
  switch (state) {
    case "no_expiry":
      return "No expiry recorded";
    case "expired":
      return `Expired ${formatted}`;
    case "expiring_soon":
      return daysUntil === 0
        ? `Expires today (${formatted})`
        : `Expires in ${daysUntil} day${daysUntil === 1 ? "" : "s"} (${formatted})`;
    case "current":
      return `Current through ${formatted}`;
  }
}

/* ------------------------------------------------------------------ */
/* Definition operations                                               */
/* ------------------------------------------------------------------ */

export function listQualificationDefinitions(
  organizationId: string,
  options: { includeInactive?: boolean } = {},
) {
  return prisma.qualificationDefinition.findMany({
    where: {
      organizationId,
      ...(options.includeInactive ? {} : { status: "ACTIVE" }),
    },
    orderBy: { name: "asc" },
    include: { _count: { select: { memberQualifications: true } } },
  });
}

export async function createQualificationDefinition(
  organizationId: string,
  input: QualificationDefinitionInput,
) {
  const definition = await prisma.qualificationDefinition.create({
    data: {
      organizationId,
      name: input.name,
      description: input.description ?? null,
    },
  });
  log({
    event: "qualification.definition_created",
    subsystem: "domain",
    entityType: "QualificationDefinition",
    entityId: definition.id,
    organizationId,
  });
  return definition;
}

export async function updateQualificationDefinition(
  id: string,
  input: QualificationDefinitionInput,
) {
  const definition = await prisma.qualificationDefinition.update({
    where: { id },
    data: { name: input.name, description: input.description ?? null },
  });
  log({
    event: "qualification.definition_updated",
    subsystem: "domain",
    entityType: "QualificationDefinition",
    entityId: definition.id,
    organizationId: definition.organizationId,
  });
  return definition;
}

/**
 * Activate/deactivate a definition. INACTIVE blocks new records but
 * preserves all history — nothing is deleted or hidden.
 */
export async function setQualificationDefinitionStatus(
  id: string,
  status: QualificationDefinitionStatusInput,
) {
  const definition = await prisma.qualificationDefinition.update({
    where: { id },
    data: { status },
  });
  log({
    event: "qualification.definition_status_changed",
    subsystem: "domain",
    entityType: "QualificationDefinition",
    entityId: definition.id,
    organizationId: definition.organizationId,
    definitionStatus: definition.status,
  });
  return definition;
}

/* ------------------------------------------------------------------ */
/* MemberQualification operations                                      */
/* ------------------------------------------------------------------ */

/**
 * Deterministic record ordering — "latest" is the most recently issued
 * record; records without an issue date sort after dated ones; createdAt
 * breaks all remaining ties. History is always retained and listed.
 */
const recordOrder: Prisma.MemberQualificationOrderByWithRelationInput[] = [
  { issuedOn: { sort: "desc", nulls: "last" } },
  { createdAt: "desc" },
];

const recordInclude = {
  definition: { select: { id: true, name: true, status: true } },
} as const;

export function listMemberQualifications(memberId: string) {
  return prisma.memberQualification.findMany({
    where: { memberId },
    orderBy: recordOrder,
    include: recordInclude,
  });
}

export function getMemberQualification(id: string) {
  return prisma.memberQualification.findUnique({
    where: { id },
    include: recordInclude,
  });
}

/**
 * Records expiring within `withinDays` of `today` (or already expired
 * when includeExpired). Org-scoped, deterministic — also the reusable
 * query the reminder work (issue #11) will build on.
 */
export function listExpiringQualifications(
  organizationId: string,
  options: { withinDays?: number; today?: Date; includeExpired?: boolean } = {},
) {
  const today = options.today ?? todayUtc();
  const horizon = new Date(
    today.getTime() + (options.withinDays ?? 30) * DAY_MS,
  );
  return prisma.memberQualification.findMany({
    where: {
      organizationId,
      expiresOn: {
        not: null,
        lte: horizon,
        ...(options.includeExpired ? {} : { gte: today }),
      },
    },
    orderBy: [{ expiresOn: "asc" }, { createdAt: "asc" }],
    include: {
      ...recordInclude,
      member: { select: { id: true, displayName: true, status: true } },
    },
  });
}

/**
 * Record a qualification for a member. The record's organizationId is
 * taken from the MEMBER record (never the caller); the definition must
 * belong to the same organization — enforced in-app for a clean error
 * and at the database level by the composite foreign keys.
 */
export async function createMemberQualification(
  memberId: string,
  input: MemberQualificationInput,
) {
  const member = await prisma.member.findUniqueOrThrow({
    where: { id: memberId },
    select: { id: true, organizationId: true },
  });
  const definition = await prisma.qualificationDefinition.findUniqueOrThrow({
    where: { id: input.definitionId },
    select: { organizationId: true, status: true },
  });
  if (definition.organizationId !== member.organizationId) {
    throw new CrossOrganizationQualificationError();
  }
  if (definition.status !== "ACTIVE") {
    throw new InactiveQualificationError();
  }

  const record = await prisma.memberQualification.create({
    data: {
      organizationId: member.organizationId,
      memberId,
      definitionId: input.definitionId,
      issuedOn: input.issuedOn ?? null,
      expiresOn: input.expiresOn ?? null,
      issuer: input.issuer ?? null,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
    },
  });
  log({
    event: "qualification.record_created",
    subsystem: "domain",
    entityType: "MemberQualification",
    entityId: record.id,
    organizationId: member.organizationId,
  });
  return record;
}

/**
 * Correct factual details on an existing record. Member and definition
 * are immutable on update — a record under a different definition is a
 * different fact (renewals are new records). Durable correction history
 * is deferred to the audit-history work; updatedAt changes.
 */
export async function updateMemberQualification(
  id: string,
  input: Omit<MemberQualificationInput, "definitionId">,
) {
  const record = await prisma.memberQualification.update({
    where: { id },
    data: {
      issuedOn: input.issuedOn ?? null,
      expiresOn: input.expiresOn ?? null,
      issuer: input.issuer ?? null,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
    },
  });
  log({
    event: "qualification.record_corrected",
    subsystem: "domain",
    entityType: "MemberQualification",
    entityId: record.id,
    organizationId: record.organizationId,
  });
  return record;
}
