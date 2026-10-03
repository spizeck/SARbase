import type {
  AvailabilityStatus,
  MemberAvailabilityUpdate,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { log } from "@/lib/logging";
import { calendarDateInZone } from "@/lib/dates";
import { resolveActorLabels } from "@/lib/domain/actors";

import type {
  AvailabilityUpdateInput,
  ContactPreferenceInput,
} from "./schemas";

/**
 * Member availability and contact preferences (issue #12).
 *
 * PRODUCT BOUNDARY: availability is a recorded statement, never a
 * readiness judgment. Nothing here computes crew sufficiency, launch
 * readiness, qualification, or ranking — SARbase records "the member
 * (or an admin on their behalf) said X at time T" and derived facts
 * about whether that statement is still in effect. The organization
 * and qualified personnel decide what it means operationally.
 *
 * Model — append-only MemberAvailabilityUpdate rows:
 * - The CURRENT status is derived at read time from the latest row by
 *   (createdAt, id). Rows are never updated or deleted through the
 *   application surface, so history cannot be silently rewritten.
 * - `until` is a calendar date in the ORGANIZATION'S timezone
 *   (@db.Date), inclusive: the statement applies through the end of
 *   that local day. Once the org's local today is later than `until`,
 *   the row remains as history but the computed status falls back to
 *   UNKNOWN — elapsed time is never inferred as AVAILABLE.
 * - `selfReported` is captured at write time: it answers "self-service
 *   or admin-entered" durably even if identity↔member links change.
 *
 * Contact preferences (MemberNotificationPreference) are a single
 * mutable row per member: willingness per channel only — never proof
 * of delivery and never a notification being sent. Destinations stay
 * on Member (email/phone); push records willingness ahead of any
 * device registration.
 */

/** An availability input violates a rule the schema cannot see. */
export class AvailabilityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvailabilityInputError";
  }
}

/** A notification channel was enabled without its destination. */
export class ContactPreferenceDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactPreferenceDestinationError";
  }
}

export const AVAILABILITY_STATUS_LABELS: Record<AvailabilityStatus, string> = {
  AVAILABLE: "Available",
  UNAVAILABLE: "Unavailable",
  OFF_ISLAND: "Off island",
  UNKNOWN: "Unknown",
};

export interface CurrentAvailability {
  /** The computed current status — UNKNOWN when unrecorded or expired. */
  status: AvailabilityStatus;
  /**
   * The latest recorded statement (provenance), or null when the member
   * has never recorded one. It may itself be expired — check `expired`.
   */
  latest: MemberAvailabilityUpdate | null;
  /** True when the latest statement's `until` date has passed. */
  expired: boolean;
}

/**
 * Derive the current status from the latest recorded statement. Pure —
 * callers pass the organization's local calendar "today" so expiry is
 * identical regardless of server timezone. An expired statement is
 * honest history: it falls back to UNKNOWN, never AVAILABLE.
 */
export function computeAvailability(
  latest: MemberAvailabilityUpdate | null,
  orgToday: Date,
): CurrentAvailability {
  if (!latest) {
    return { status: "UNKNOWN", latest: null, expired: false };
  }
  const expired = latest.until != null && latest.until < orgToday;
  return {
    status: expired ? "UNKNOWN" : latest.status,
    latest,
    expired,
  };
}

/** The organization's local calendar date for availability expiry. */
async function memberOrgToday(memberId: string) {
  const member = await prisma.member.findUniqueOrThrow({
    where: { id: memberId },
    select: { organization: { select: { timezone: true } } },
  });
  return calendarDateInZone(member.organization.timezone);
}

/**
 * Record a new availability statement for a member. Authorization is
 * the caller's job — this function assumes the caller already resolved
 * the member (self-service via a linked member + org access, or admin
 * via requireOrgAdminForMember).
 *
 * `until`, when present, must not be before the organization's local
 * today — a statement cannot be recorded already expired.
 * `actorAuthIdentityId` comes from server-side auth context, never from
 * client input; `selfReported` is true when the actor is updating their
 * own linked member record.
 */
export async function recordMemberAvailability(
  memberId: string,
  input: AvailabilityUpdateInput,
  actorAuthIdentityId: string,
  options: { selfReported: boolean },
) {
  const member = await prisma.member.findUniqueOrThrow({
    where: { id: memberId },
    select: {
      organizationId: true,
      organization: { select: { timezone: true } },
    },
  });
  const orgToday = calendarDateInZone(member.organization.timezone);
  if (input.until && input.until < orgToday) {
    throw new AvailabilityInputError("The end date cannot be in the past.");
  }

  const update = await prisma.memberAvailabilityUpdate.create({
    data: {
      organizationId: member.organizationId,
      memberId,
      status: input.status,
      until: input.until ?? null,
      note: input.note ?? null,
      selfReported: options.selfReported,
      actorAuthIdentityId,
    },
  });
  log({
    event: "availability.recorded",
    subsystem: "domain",
    entityType: "Member",
    entityId: memberId,
    organizationId: member.organizationId,
    actorId: actorAuthIdentityId,
    availabilityStatus: update.status,
    selfReported: update.selfReported,
  });
  return update;
}

/** The member's latest recorded statement plus the computed status. */
export async function getMemberAvailability(memberId: string) {
  const [latest, orgToday] = await Promise.all([
    prisma.memberAvailabilityUpdate.findFirst({
      where: { memberId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    memberOrgToday(memberId),
  ]);
  return computeAvailability(latest, orgToday);
}

/**
 * A member's availability statement history, newest first — "what was
 * recorded, when, by whom, self-service or admin-entered". Actor display
 * is resolved best-effort (the member record linked to the acting
 * identity in this organization, else the identity's sign-in email) —
 * the raw actorAuthIdentityId always remains on the row.
 */
export async function listMemberAvailabilityHistory(
  memberId: string,
  limit = 20,
) {
  const updates = await prisma.memberAvailabilityUpdate.findMany({
    where: { memberId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  const organizationId = updates[0]?.organizationId;
  const labels = organizationId
    ? await resolveActorLabels(
        organizationId,
        updates.map((u) => u.actorAuthIdentityId),
      )
    : new Map<string, string>();
  return updates.map((update) => ({
    ...update,
    // Falls back to the raw identity id — actorAuthIdentityId is a
    // scalar (no FK), so a deleted identity still leaves a stable
    // forensic reference rather than an unattributed row.
    actorDisplayName:
      labels.get(update.actorAuthIdentityId) ?? update.actorAuthIdentityId,
  }));
}

/**
 * Current computed availability for every member of an organization —
 * the admin overview. One query reads the latest statement per member
 * (DISTINCT ON memberId, newest first); expiry is computed against the
 * organization's local today. Informational only — callers must not
 * turn this into sufficiency or readiness.
 */
export async function listOrganizationAvailability(
  organizationId: string,
  orgToday: Date,
): Promise<Map<string, CurrentAvailability>> {
  const latest = await prisma.memberAvailabilityUpdate.findMany({
    where: { organizationId },
    orderBy: [{ memberId: "asc" }, { createdAt: "desc" }, { id: "desc" }],
    distinct: ["memberId"],
  });
  return new Map(
    latest.map((row) => [row.memberId, computeAvailability(row, orgToday)]),
  );
}

/* ------------------------------------------------------------------ */
/* Contact preferences                                                 */
/* ------------------------------------------------------------------ */

/** The member's preference row, or null when never configured. */
export function getMemberContactPreference(memberId: string) {
  // memberId is globally unique (the compound unique makes a second row
  // impossible), so a plain first-match is a single-row read.
  return prisma.memberNotificationPreference.findFirst({
    where: { memberId },
  });
}

/**
 * Set a member's notification-channel willingness. Channel → destination
 * rules: email requires Member.email; SMS/WhatsApp require Member.phone;
 * push requires nothing yet (willingness is recorded before any device
 * registration exists). Preference is not deliverability — an enabled
 * channel with a stale destination simply never answers "willing AND
 * addressable" downstream.
 */
export async function setMemberContactPreference(
  memberId: string,
  input: ContactPreferenceInput,
) {
  const member = await prisma.member.findUniqueOrThrow({
    where: { id: memberId },
    select: { organizationId: true, email: true, phone: true },
  });
  if (input.notifyEmail && !member.email) {
    throw new ContactPreferenceDestinationError(
      "Email notifications need an email address on the member record.",
    );
  }
  if ((input.notifySms || input.notifyWhatsapp) && !member.phone) {
    throw new ContactPreferenceDestinationError(
      "SMS and WhatsApp notifications need a phone number on the member record.",
    );
  }

  const preference = await prisma.memberNotificationPreference.upsert({
    where: {
      memberId_organizationId: {
        memberId,
        organizationId: member.organizationId,
      },
    },
    create: {
      organizationId: member.organizationId,
      memberId,
      ...input,
    },
    update: input,
  });
  log({
    event: "contact_preference.updated",
    subsystem: "domain",
    entityType: "Member",
    entityId: memberId,
    organizationId: member.organizationId,
  });
  return preference;
}
