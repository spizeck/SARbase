import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { log } from "@/lib/logging";
import { resolveActorLabels } from "@/lib/domain/actors";

import type { TrainingEventInput, TrainingEventStatusInput } from "./schemas";

/**
 * Training domain operations.
 *
 * PRODUCT BOUNDARY: training records are factual administrative records
 * ONLY. Nothing here computes competence, operational fitness, mission
 * eligibility, crew sufficiency, or readiness — SARbase states facts
 * ("attended on Nov 14", "last attended 83 days ago") and qualified SAR
 * personnel draw the conclusions. Attendance never creates or implies a
 * MemberQualification.
 *
 * Two record types:
 * - TrainingEvent — one training activity. `date` is the organization's
 *   local calendar date (@db.Date), `durationMinutes` the whole-event
 *   length (the future volunteer-hours source). Status is COMPLETED
 *   (it happened) or CANCELLED (it did not); a cancelled event keeps its
 *   rows for history but contributes nothing to participation views.
 * - TrainingAttendance — "this member was there". Row existence is the
 *   fact; there is no excused/unavailable taxonomy. Every add/remove
 *   appends an immutable TrainingAttendanceChange row naming the
 *   authenticated actor — the durable audit of attendance edits (a
 *   domain-specific record, not the deferred generic audit framework).
 */

export class CrossOrganizationTrainingError extends Error {
  constructor() {
    super("Training records can only reference same-organization records.");
    this.name = "CrossOrganizationTrainingError";
  }
}

export class CancelledTrainingError extends Error {
  constructor() {
    super(
      "This training event is cancelled — attendance cannot be changed on an event that did not happen.",
    );
    this.name = "CancelledTrainingError";
  }
}

const eventInclude = {
  unit: { select: { id: true, name: true } },
  leadMember: { select: { id: true, displayName: true } },
  topics: { orderBy: { label: "asc" as const } },
  _count: { select: { attendances: true } },
} satisfies Prisma.TrainingEventInclude;

async function assertSameOrgRefs(
  organizationId: string,
  input: { unitId?: string; leadMemberId?: string },
) {
  if (input.unitId) {
    const unit = await prisma.unit.findUnique({
      where: { id: input.unitId },
      select: { organizationId: true },
    });
    if (unit?.organizationId !== organizationId) {
      throw new CrossOrganizationTrainingError();
    }
  }
  if (input.leadMemberId) {
    const lead = await prisma.member.findUnique({
      where: { id: input.leadMemberId },
      select: { organizationId: true },
    });
    if (lead?.organizationId !== organizationId) {
      throw new CrossOrganizationTrainingError();
    }
  }
}

function dedupeTopics(topics: string[]) {
  // Case-insensitive dedupe preserving first-seen casing — the
  // organization's own vocabulary, not a normalized taxonomy.
  const seen = new Set<string>();
  return topics
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => {
      const key = t.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/* ------------------------------------------------------------------ */
/* TrainingEvent                                                      */
/* ------------------------------------------------------------------ */

/**
 * List an organization's training events, newest first.
 *
 * Filters (all optional, all additive):
 * - `unitId` — a unit id narrows to that unit's events; the explicit
 *   `null` selects organization-wide events only (unitId IS NULL);
 *   `undefined` means no unit filter. A unit id from another
 *   organization matches nothing — the composite FKs guarantee no
 *   event can carry it here, so filtering can never leak cross-org.
 * - `from` / `to` — inclusive bounds on the event's date-only `date`
 *   (@db.Date calendar semantics, same as qualification dates).
 * - `includeCancelled` — cancelled events are excluded unless set.
 */
export function listTrainingEvents(
  organizationId: string,
  options: {
    unitId?: string | null;
    from?: Date;
    to?: Date;
    includeCancelled?: boolean;
  } = {},
) {
  return prisma.trainingEvent.findMany({
    where: {
      organizationId,
      ...(options.includeCancelled ? {} : { status: "COMPLETED" }),
      ...(options.unitId === undefined ? {} : { unitId: options.unitId }),
      ...(options.from || options.to
        ? {
            date: {
              ...(options.from ? { gte: options.from } : {}),
              ...(options.to ? { lte: options.to } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    include: eventInclude,
  });
}

export function getTrainingEvent(id: string) {
  return prisma.trainingEvent.findUnique({
    where: { id },
    include: {
      ...eventInclude,
      attendances: {
        orderBy: { createdAt: "asc" },
        include: {
          member: { select: { id: true, displayName: true, status: true } },
        },
      },
    },
  });
}

export async function createTrainingEvent(
  organizationId: string,
  input: TrainingEventInput,
) {
  await assertSameOrgRefs(organizationId, input);
  const event = await prisma.trainingEvent.create({
    data: {
      organizationId,
      unitId: input.unitId ?? null,
      title: input.title,
      date: input.date,
      durationMinutes: input.durationMinutes ?? null,
      location: input.location ?? null,
      instructorName: input.instructorName ?? null,
      leadMemberId: input.leadMemberId ?? null,
      notes: input.notes ?? null,
      followUp: input.followUp ?? null,
      topics: {
        create: dedupeTopics(input.topics).map((label) => ({ label })),
      },
    },
  });
  log({
    event: "training.event_created",
    subsystem: "domain",
    entityType: "TrainingEvent",
    entityId: event.id,
    organizationId,
  });
  return event;
}

/**
 * Correct factual details on an existing event — the row's identity is
 * preserved (no replace-with-new-id). Topic labels are synced to the
 * provided set. Durable who/what/when change history is deferred.
 */
export async function updateTrainingEvent(
  id: string,
  input: TrainingEventInput,
) {
  const existing = await prisma.trainingEvent.findUniqueOrThrow({
    where: { id },
    select: { organizationId: true },
  });
  await assertSameOrgRefs(existing.organizationId, input);
  const labels = dedupeTopics(input.topics);

  const event = await prisma.$transaction(async (tx) => {
    await tx.trainingTopic.deleteMany({
      where: { trainingEventId: id, label: { notIn: labels } },
    });
    for (const label of labels) {
      await tx.trainingTopic.upsert({
        where: { trainingEventId_label: { trainingEventId: id, label } },
        create: {
          trainingEventId: id,
          organizationId: existing.organizationId,
          label,
        },
        update: {},
      });
    }
    return tx.trainingEvent.update({
      where: { id },
      data: {
        unitId: input.unitId ?? null,
        title: input.title,
        date: input.date,
        durationMinutes: input.durationMinutes ?? null,
        location: input.location ?? null,
        instructorName: input.instructorName ?? null,
        leadMemberId: input.leadMemberId ?? null,
        notes: input.notes ?? null,
        followUp: input.followUp ?? null,
      },
    });
  });
  log({
    event: "training.event_updated",
    subsystem: "domain",
    entityType: "TrainingEvent",
    entityId: event.id,
    organizationId: existing.organizationId,
  });
  return event;
}

/**
 * Mark an event cancelled (it did not happen — attendance rows are
 * preserved but excluded from participation views) or restore it to
 * COMPLETED. The row is never deleted.
 */
export async function setTrainingEventStatus(
  id: string,
  status: TrainingEventStatusInput,
) {
  const event = await prisma.trainingEvent.update({
    where: { id },
    data: { status },
  });
  log({
    event: "training.event_status_changed",
    subsystem: "domain",
    entityType: "TrainingEvent",
    entityId: event.id,
    organizationId: event.organizationId,
    eventStatus: event.status,
  });
  return event;
}

/* ------------------------------------------------------------------ */
/* TrainingAttendance                                                 */
/* ------------------------------------------------------------------ */

/**
 * Sync the attendee set for an event: members not in the list lose
 * their row, listed members gain one — rows for members already
 * present are untouched (per-attendee notes survive a re-sync).
 * All memberIds must belong to the event's organization; the composite
 * FKs enforce that at the database level as well.
 *
 * Every member actually added or removed appends an immutable
 * TrainingAttendanceChange row in the same transaction — durable
 * who/what/when audit for attendance edits. `actorAuthIdentityId` is
 * the authenticated caller's AuthIdentity id, derived from server-side
 * auth context — it must NEVER come from client input. No-op re-syncs
 * write no rows; removing and re-adding a member produces a second
 * ADDED row rather than rewriting history.
 */
export async function setTrainingAttendance(
  eventId: string,
  memberIds: string[],
  actorAuthIdentityId: string,
) {
  const event = await prisma.trainingEvent.findUniqueOrThrow({
    where: { id: eventId },
    select: { organizationId: true, status: true },
  });
  if (event.status !== "COMPLETED") throw new CancelledTrainingError();

  const uniqueIds = [...new Set(memberIds)];
  if (uniqueIds.length) {
    const sameOrgCount = await prisma.member.count({
      where: { id: { in: uniqueIds }, organizationId: event.organizationId },
    });
    if (sameOrgCount !== uniqueIds.length) {
      throw new CrossOrganizationTrainingError();
    }
  }

  await prisma.$transaction(async (tx) => {
    const before = new Set(
      (
        await tx.trainingAttendance.findMany({
          where: { trainingEventId: eventId },
          select: { memberId: true },
        })
      ).map((a) => a.memberId),
    );
    const wanted = new Set(uniqueIds);
    const added = uniqueIds.filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !wanted.has(id));

    await tx.trainingAttendance.deleteMany({
      where: { trainingEventId: eventId, memberId: { notIn: uniqueIds } },
    });
    for (const memberId of uniqueIds) {
      await tx.trainingAttendance.upsert({
        where: {
          trainingEventId_memberId: { trainingEventId: eventId, memberId },
        },
        create: {
          organizationId: event.organizationId,
          trainingEventId: eventId,
          memberId,
        },
        update: {},
      });
    }
    await tx.trainingAttendanceChange.createMany({
      data: [
        ...added.map(
          (memberId) =>
            ({
              organizationId: event.organizationId,
              trainingEventId: eventId,
              memberId,
              actorAuthIdentityId,
              action: "ADDED",
            }) as const,
        ),
        ...removed.map(
          (memberId) =>
            ({
              organizationId: event.organizationId,
              trainingEventId: eventId,
              memberId,
              actorAuthIdentityId,
              action: "REMOVED",
            }) as const,
        ),
      ],
    });
  });
  log({
    event: "training.attendance_set",
    subsystem: "domain",
    entityType: "TrainingEvent",
    entityId: eventId,
    organizationId: event.organizationId,
    attendeeCount: uniqueIds.length,
  });
}

/**
 * The immutable change history for one event's attendance, oldest
 * first — "who was added/removed, by whom, when". Actor display is
 * resolved best-effort: the member record linked to the acting
 * identity in this organization, else the identity's sign-in email,
 * else null (the caller renders a safe fallback — the raw
 * actorAuthIdentityId is always on the row).
 */
export async function listTrainingAttendanceChanges(trainingEventId: string) {
  const changes = await prisma.trainingAttendanceChange.findMany({
    where: { trainingEventId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      member: { select: { id: true, displayName: true } },
    },
  });
  const organizationId = changes[0]?.organizationId;
  const labels = organizationId
    ? await resolveActorLabels(
        organizationId,
        changes.map((c) => c.actorAuthIdentityId),
      )
    : new Map<string, string>();
  return changes.map((change) => ({
    ...change,
    actorDisplayName: labels.get(change.actorAuthIdentityId) ?? null,
  }));
}

/* ------------------------------------------------------------------ */
/* Member participation (factual views)                               */
/* ------------------------------------------------------------------ */

const attendedWhere = { event: { status: "COMPLETED" as const } };

/**
 * All attendance rows for a member — including rows on cancelled
 * events, flagged via the included event.status so callers can present
 * them honestly ("cancelled — did not occur"). Newest first.
 */
export function listMemberTraining(memberId: string) {
  return prisma.trainingAttendance.findMany({
    where: { memberId },
    orderBy: [{ event: { date: "desc" } }, { createdAt: "desc" }],
    include: {
      event: {
        select: {
          id: true,
          title: true,
          date: true,
          status: true,
          durationMinutes: true,
          location: true,
        },
      },
    },
  });
}

/**
 * Factual participation summary — last attended date and count of
 * completed events (optionally within a date window). No scoring,
 * ranking, or judgment is computed.
 */
export async function getMemberTrainingSummary(
  memberId: string,
  options: { from?: Date; to?: Date } = {},
) {
  const dateFilter =
    options.from || options.to
      ? {
          date: {
            ...(options.from ? { gte: options.from } : {}),
            ...(options.to ? { lte: options.to } : {}),
          },
        }
      : {};
  const [attendedCount, last] = await Promise.all([
    prisma.trainingAttendance.count({
      where: { memberId, event: { status: "COMPLETED", ...dateFilter } },
    }),
    prisma.trainingAttendance.findFirst({
      where: { memberId, ...attendedWhere },
      orderBy: [{ event: { date: "desc" } }, { createdAt: "desc" }],
      select: { event: { select: { date: true, title: true } } },
    }),
  ]);
  return {
    attendedCount,
    lastAttendedOn: last?.event.date ?? null,
    lastEventTitle: last?.event.title ?? null,
  };
}
