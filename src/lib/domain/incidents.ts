import { Prisma } from "@prisma/client";
import type {
  Incident,
  IncidentNoteKind,
  IncidentStatus,
  IncidentTimelineEventType,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { log } from "@/lib/logging";
import { instantInZone } from "@/lib/dates";
import { resolveActorLabels } from "@/lib/domain/actors";

import type {
  IncidentAssetInput,
  IncidentCreateInput,
  IncidentMemberInput,
  IncidentNoteCorrectionInput,
  IncidentNoteInput,
  IncidentUpdateInput,
} from "./schemas";

/**
 * Incident records, timeline, notes, and audit history (issue #15).
 *
 * PRODUCT BOUNDARY: an incident is the durable ADMINISTRATIVE record of
 * what an organization recorded — the report, factual timestamps, who
 * was recorded as participating, which assets were recorded as used,
 * human-authored notes, and what was later corrected. A Callout is the
 * notification/response event; an Incident is the record. At most one
 * incident links to a callout (unique constraint), an incident may have
 * no callout, and a callout never requires an incident. Participation
 * is an explicit recorded fact — it is NEVER inferred from callout
 * RSVP state.
 *
 * SARbase records incident facts and human-authored notes. It does not
 * provide search planning, navigation, tactics, readiness judgments, or
 * operational recommendations — there is no severity, priority,
 * sufficiency, verdict, or command state anywhere in this module.
 *
 * Audit model:
 * - Lifecycle transitions and participant changes write
 *   IncidentTimelineEvent rows (system facts) in the same transaction.
 * - Material field edits write a typed before/after IncidentChange in
 *   the same transaction — the original report is always recoverable.
 * - Note corrections append IncidentNoteCorrection rows; note bodies
 *   are never silently overwritten.
 * - On a CLOSED incident the material-field edit path requires a
 *   correction reason; every mutation is audited regardless of status.
 *   Closing never makes the record immutable, only slower to change.
 *
 * Actor attribution follows the scalar-ID policy: every history row
 * stores a plain `actorAuthIdentityId` (no FK) so history survives
 * identity deletion; display resolves best-effort (member display name
 * in this org → identity email → raw id). All audit-history tables
 * share this policy (issue #32 aligned the older FK-pinned ones).
 *
 * SENSITIVE DATA: incidents may contain casualty and personal details.
 * The entire surface is ADMIN-only — there is no member-facing or
 * token-accessible incident read path, and the public /respond route
 * never touches these tables.
 */

/** A selector named a record outside the incident's organization. */
export class CrossOrganizationIncidentError extends Error {
  constructor() {
    super("A selected record belongs to another organization.");
    this.name = "CrossOrganizationIncidentError";
  }
}

/** A lifecycle transition that is not allowed from the current status. */
export class IncidentTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncidentTransitionError";
  }
}

/** The incident or callout already carries a link — links don't move. */
export class IncidentLinkedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncidentLinkedError";
  }
}

/** A CLOSED incident's material fields require a correction reason. */
export class IncidentCorrectionReasonError extends Error {
  constructor() {
    super("A correction reason is required for a closed incident record.");
    this.name = "IncidentCorrectionReasonError";
  }
}

/** The member/asset is already recorded on this incident. */
export class IncidentDuplicateParticipantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncidentDuplicateParticipantError";
  }
}

/** Input that is shaped correctly but cannot become a fact. */
export class IncidentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncidentInputError";
  }
}

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  DRAFT: "Draft",
  OPEN: "Open",
  CLOSED: "Closed",
};

export const INCIDENT_NOTE_KIND_LABELS: Record<IncidentNoteKind, string> = {
  GENERAL: "Note",
  AFTER_ACTION: "After-action",
  CLOSING: "Closing",
};

/* ------------------------------------------------------------------ */
/* Timeline event rendering                                            */
/* ------------------------------------------------------------------ */

/** Narrow, type-bound metadata payload shapes for timeline events. */
interface TimelineMetadata {
  from?: string;
  to?: string;
  calloutId?: string;
  memberId?: string;
  memberName?: string;
  assetId?: string;
  assetName?: string;
  changeId?: string;
  noteId?: string;
  attachmentId?: string;
  reason?: string;
}

/**
 * Human-readable sentence for a system timeline event. Names come from
 * the snapshotted metadata, so the sentence stays accurate even if the
 * member/asset is renamed later.
 */
export function describeIncidentTimelineEvent(event: {
  type: IncidentTimelineEventType;
  metadata: Prisma.JsonValue | null;
}): string {
  const meta = (event.metadata ?? {}) as TimelineMetadata;
  switch (event.type) {
    case "INCIDENT_CREATED":
      return "Incident record created";
    case "STATUS_CHANGED":
      return `Status changed from ${INCIDENT_STATUS_LABELS[meta.from as IncidentStatus] ?? meta.from} to ${INCIDENT_STATUS_LABELS[meta.to as IncidentStatus] ?? meta.to}`;
    case "CALLOUT_LINKED":
      return "Linked to callout";
    case "MEMBER_ADDED":
      return `Participant recorded: ${meta.memberName ?? "member"}`;
    case "MEMBER_REMOVED":
      return `Participant removed: ${meta.memberName ?? "member"}`;
    case "ASSET_ADDED":
      return `Asset recorded: ${meta.assetName ?? "asset"}`;
    case "ASSET_REMOVED":
      return `Asset removed: ${meta.assetName ?? "asset"}`;
    case "CORRECTION_RECORDED":
      return "Incident record corrected";
    case "ATTACHMENT_ADDED":
      return "File added to the incident record";
    case "ATTACHMENT_REMOVED":
      return "File removed from the incident record";
    default:
      return event.type;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/** Lock the incident row so serialized mutations chain correctly. */
async function lockIncident(tx: Prisma.TransactionClient, incidentId: string) {
  await tx.$executeRaw`SELECT id FROM "Incident" WHERE id = ${incidentId} FOR UPDATE`;
  const incident = await tx.incident.findUnique({ where: { id: incidentId } });
  if (!incident) {
    // Authz resolves targets first, so a missing row here is a raced
    // delete or a fabricated id — opaque either way.
    throw new CrossOrganizationIncidentError();
  }
  return incident;
}

async function timelineEvent(
  tx: Prisma.TransactionClient,
  incident: { id: string; organizationId: string },
  type: IncidentTimelineEventType,
  actorAuthIdentityId: string,
  metadata?: TimelineMetadata,
  occurredAt?: Date,
) {
  const now = new Date();
  return tx.incidentTimelineEvent.create({
    data: {
      organizationId: incident.organizationId,
      incidentId: incident.id,
      type,
      // For system events the only honest occurrence time is the moment
      // of the action; occurredAt stays distinct from createdAt so the
      // semantic survives for events that ever carry a source time.
      occurredAt: occurredAt ?? now,
      createdAt: now,
      actorAuthIdentityId,
      metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/** Convert an optional datetime-local string to an instant in the org zone. */
function toInstant(
  timeZone: string,
  value: string | undefined,
  field: string,
): Date | null {
  if (value == null) return null;
  const instant = instantInZone(timeZone, value);
  if (!instant) {
    throw new IncidentInputError(`Enter a real date and time for ${field}.`);
  }
  return instant;
}

async function organizationTimeZone(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<string> {
  const org = await tx.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { timezone: true },
  });
  return org.timezone;
}

/** org timezone lookup outside a transaction. */
async function organizationTimeZoneDirect(
  organizationId: string,
): Promise<string> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { timezone: true },
  });
  return org.timezone;
}

/* ------------------------------------------------------------------ */
/* Creation                                                            */
/* ------------------------------------------------------------------ */

/**
 * Create an incident record — manual, or linked to a same-organization
 * callout. The org-scoped reference ("INC-7") comes from the atomic
 * IncidentSequence counter inside the same transaction, so concurrent
 * creations can never mint the same reference. A callout link is
 * one-to-one; a second incident on the same callout hits the unique
 * constraint → IncidentLinkedError.
 *
 * Creation writes an INCIDENT_CREATED timeline event (plus
 * CALLOUT_LINKED when linked). Nothing about callout invitations or
 * responses is copied — the callout remains the standalone
 * notification/response record.
 */
export async function createIncident(
  organizationId: string,
  input: IncidentCreateInput,
  actorAuthIdentityId: string,
) {
  const timeZone = await organizationTimeZoneDirect(organizationId);
  const incident = await prisma.$transaction(async (tx) => {
    let calloutId: string | null = null;
    if (input.calloutId) {
      const callout = await tx.callout.findUnique({
        where: { id: input.calloutId },
        select: { organizationId: true },
      });
      if (!callout || callout.organizationId !== organizationId) {
        // Opaque — a foreign or fabricated callout id must not leak.
        throw new CrossOrganizationIncidentError();
      }
      calloutId = input.calloutId;
    }

    const seq = await tx.incidentSequence.upsert({
      where: { organizationId },
      update: { nextNumber: { increment: 1 } },
      create: { organizationId, nextNumber: 1 },
      select: { nextNumber: true },
    });

    let incident: Incident;
    try {
      incident = await tx.incident.create({
        data: {
          organizationId,
          calloutId,
          sequence: seq.nextNumber,
          reference: `INC-${seq.nextNumber}`,
          title: input.title,
          summary: input.summary ?? null,
          reportedAt: toInstant(
            timeZone,
            input.reportedAt,
            "the reported time",
          ),
          departedAt: toInstant(
            timeZone,
            input.departedAt,
            "the departed time",
          ),
          onSceneAt: toInstant(timeZone, input.onSceneAt, "the on-scene time"),
          returnedAt: toInstant(
            timeZone,
            input.returnedAt,
            "the returned time",
          ),
          createdByAuthIdentityId: actorAuthIdentityId,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new IncidentLinkedError(
          "An incident record already exists for that callout.",
        );
      }
      throw error;
    }

    await timelineEvent(tx, incident, "INCIDENT_CREATED", actorAuthIdentityId, {
      calloutId: calloutId ?? undefined,
    });
    if (calloutId) {
      await timelineEvent(tx, incident, "CALLOUT_LINKED", actorAuthIdentityId, {
        calloutId,
      });
    }
    return incident;
  });
  log({
    event: "incident.created",
    subsystem: "incidents",
    entityType: "Incident",
    entityId: incident.id,
    organizationId,
    actorId: actorAuthIdentityId,
  });
  return incident;
}

/**
 * Link an unlinked incident to a same-organization callout. The link is
 * set once and never moved — a wrong link is corrected by a human
 * through the audit trail, not by silent retargeting.
 */
export async function linkIncidentCallout(
  incidentId: string,
  calloutId: string,
  actorAuthIdentityId: string,
) {
  const incident = await prisma.$transaction(async (tx) => {
    const incident = await lockIncident(tx, incidentId);
    if (incident.calloutId) {
      throw new IncidentLinkedError(
        "This incident is already linked to a callout.",
      );
    }
    const callout = await tx.callout.findUnique({
      where: { id: calloutId },
      select: { organizationId: true },
    });
    if (!callout || callout.organizationId !== incident.organizationId) {
      throw new CrossOrganizationIncidentError();
    }
    let updated;
    try {
      updated = await tx.incident.update({
        where: { id: incident.id },
        data: { calloutId },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new IncidentLinkedError(
          "An incident record already exists for that callout.",
        );
      }
      throw error;
    }
    await timelineEvent(tx, incident, "CALLOUT_LINKED", actorAuthIdentityId, {
      calloutId,
    });
    return updated;
  });
  log({
    event: "incident.callout_linked",
    subsystem: "incidents",
    entityType: "Incident",
    entityId: incident.id,
    actorId: actorAuthIdentityId,
  });
  return incident;
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

/**
 * Transition the incident lifecycle. Allowed: DRAFT→OPEN, DRAFT→CLOSED
 * (record-only entry), OPEN→CLOSED, CLOSED→OPEN (explicit human
 * reopen). Transitioning to the current status is a quiet no-op so a
 * double-submit cannot write duplicate history. The row is locked so
 * concurrent transitions serialize and each STATUS_CHANGED event
 * records the actual before/after.
 */
export async function transitionIncidentStatus(
  incidentId: string,
  target: "OPEN" | "CLOSED",
  actorAuthIdentityId: string,
) {
  const incident = await prisma.$transaction(async (tx) => {
    const incident = await lockIncident(tx, incidentId);
    if (incident.status === target) {
      return { incident, changed: false };
    }
    const allowed =
      (incident.status === "DRAFT" &&
        (target === "OPEN" || target === "CLOSED")) ||
      (incident.status === "OPEN" && target === "CLOSED") ||
      (incident.status === "CLOSED" && target === "OPEN");
    if (!allowed) {
      throw new IncidentTransitionError(
        `An incident cannot move from ${incident.status} to ${target}.`,
      );
    }
    const now = new Date();
    const reopening = incident.status === "CLOSED" && target === "OPEN";
    const updated = await tx.incident.update({
      where: { id: incident.id },
      data: {
        status: target,
        // Reopen restores the OPEN recordkeeping state — the earlier
        // close remains in the timeline as history.
        ...(target === "OPEN" && !reopening ? { openedAt: now } : {}),
        ...(reopening ? { closedAt: null, closedByAuthIdentityId: null } : {}),
        ...(target === "CLOSED"
          ? { closedAt: now, closedByAuthIdentityId: actorAuthIdentityId }
          : {}),
      },
    });
    await timelineEvent(tx, incident, "STATUS_CHANGED", actorAuthIdentityId, {
      from: incident.status,
      to: target,
    });
    return { incident: updated, changed: true };
  });
  if (incident.changed) {
    log({
      event: "incident.status_changed",
      subsystem: "incidents",
      entityType: "Incident",
      entityId: incident.incident.id,
      actorId: actorAuthIdentityId,
    });
  }
  return incident.incident;
}

/* ------------------------------------------------------------------ */
/* Material field corrections                                          */
/* ------------------------------------------------------------------ */

/**
 * Correct the incident's material fields in place — and append a typed
 * before/after IncidentChange in the same transaction, so a correction
 * cannot commit without its audit snapshot. On a CLOSED incident a
 * reason is required; on DRAFT/OPEN it is optional. A submission that
 * changes nothing writes no history and no timeline noise. The incident
 * row is locked so concurrent corrections chain before/after correctly.
 */
export async function updateIncident(
  incidentId: string,
  input: IncidentUpdateInput,
  actorAuthIdentityId: string,
) {
  const result = await prisma.$transaction(async (tx) => {
    const incident = await lockIncident(tx, incidentId);
    const timeZone = await organizationTimeZone(tx, incident.organizationId);
    const next = {
      title: input.title,
      summary: input.summary ?? null,
      reportedAt: toInstant(timeZone, input.reportedAt, "the reported time"),
      departedAt: toInstant(timeZone, input.departedAt, "the departed time"),
      onSceneAt: toInstant(timeZone, input.onSceneAt, "the on-scene time"),
      returnedAt: toInstant(timeZone, input.returnedAt, "the returned time"),
    };
    const materiallyChanged =
      incident.title !== next.title ||
      incident.summary !== next.summary ||
      !sameInstant(incident.reportedAt, next.reportedAt) ||
      !sameInstant(incident.departedAt, next.departedAt) ||
      !sameInstant(incident.onSceneAt, next.onSceneAt) ||
      !sameInstant(incident.returnedAt, next.returnedAt);
    if (!materiallyChanged) {
      return { incident, changeId: null };
    }
    if (incident.status === "CLOSED" && !input.reason) {
      throw new IncidentCorrectionReasonError();
    }
    const change = await tx.incidentChange.create({
      data: {
        organizationId: incident.organizationId,
        incidentId: incident.id,
        reason: input.reason ?? null,
        beforeTitle: incident.title,
        beforeSummary: incident.summary,
        beforeReportedAt: incident.reportedAt,
        beforeDepartedAt: incident.departedAt,
        beforeOnSceneAt: incident.onSceneAt,
        beforeReturnedAt: incident.returnedAt,
        afterTitle: next.title,
        afterSummary: next.summary,
        afterReportedAt: next.reportedAt,
        afterDepartedAt: next.departedAt,
        afterOnSceneAt: next.onSceneAt,
        afterReturnedAt: next.returnedAt,
        actorAuthIdentityId,
      },
    });
    const updated = await tx.incident.update({
      where: { id: incident.id },
      data: next,
    });
    await timelineEvent(
      tx,
      incident,
      "CORRECTION_RECORDED",
      actorAuthIdentityId,
      { changeId: change.id },
    );
    return { incident: updated, changeId: change.id };
  });
  if (result.changeId) {
    log({
      event: "incident.corrected",
      subsystem: "incidents",
      entityType: "Incident",
      entityId: result.incident.id,
      actorId: actorAuthIdentityId,
    });
  }
  return result.incident;
}

/* ------------------------------------------------------------------ */
/* Participants — explicit facts, never inferred from RSVP             */
/* ------------------------------------------------------------------ */

/**
 * Record a member as participating in the incident. Same-org enforced
 * on the member id; the unique (incidentId, memberId) constraint makes
 * concurrent or repeated adds converge to one row — a duplicate is a
 * loud domain error, never a silent second fact.
 */
export async function addIncidentMember(
  incidentId: string,
  input: IncidentMemberInput,
  actorAuthIdentityId: string,
) {
  const participation = await prisma.$transaction(async (tx) => {
    const incident = await tx.incident.findUnique({
      where: { id: incidentId },
    });
    if (!incident) throw new CrossOrganizationIncidentError();
    const member = await tx.member.findUnique({
      where: { id: input.memberId },
      select: { organizationId: true, displayName: true },
    });
    if (!member || member.organizationId !== incident.organizationId) {
      throw new CrossOrganizationIncidentError();
    }
    let row;
    try {
      row = await tx.incidentMember.create({
        data: {
          organizationId: incident.organizationId,
          incidentId: incident.id,
          memberId: input.memberId,
          roleNote: input.roleNote ?? null,
          recordedByAuthIdentityId: actorAuthIdentityId,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new IncidentDuplicateParticipantError(
          "That member is already recorded as a participant.",
        );
      }
      throw error;
    }
    await timelineEvent(tx, incident, "MEMBER_ADDED", actorAuthIdentityId, {
      memberId: input.memberId,
      memberName: member.displayName,
    });
    return row;
  });
  log({
    event: "incident.member_added",
    subsystem: "incidents",
    entityType: "IncidentMember",
    entityId: participation.id,
    organizationId: participation.organizationId,
    actorId: actorAuthIdentityId,
  });
  return participation;
}

/**
 * Remove a participation row — the record of "currently recorded as
 * participating" — and append a MEMBER_REMOVED timeline event so the
 * fact that they were once recorded (and when/by whom they were
 * removed) is preserved.
 */
export async function removeIncidentMember(
  participationId: string,
  actorAuthIdentityId: string,
) {
  await prisma.$transaction(async (tx) => {
    const row = await tx.incidentMember.findUnique({
      where: { id: participationId },
      include: {
        member: { select: { displayName: true } },
        incident: { select: { id: true, organizationId: true } },
      },
    });
    if (!row) throw new CrossOrganizationIncidentError();
    await tx.incidentMember.delete({ where: { id: row.id } });
    await timelineEvent(
      tx,
      row.incident,
      "MEMBER_REMOVED",
      actorAuthIdentityId,
      {
        memberId: row.memberId,
        memberName: row.member.displayName,
      },
    );
  });
  log({
    event: "incident.member_removed",
    subsystem: "incidents",
    entityType: "IncidentMember",
    entityId: participationId,
    actorId: actorAuthIdentityId,
  });
}

/** Same contract as addIncidentMember, for durable assets. */
export async function addIncidentAsset(
  incidentId: string,
  input: IncidentAssetInput,
  actorAuthIdentityId: string,
) {
  const participation = await prisma.$transaction(async (tx) => {
    const incident = await tx.incident.findUnique({
      where: { id: incidentId },
    });
    if (!incident) throw new CrossOrganizationIncidentError();
    const asset = await tx.asset.findUnique({
      where: { id: input.assetId },
      select: { organizationId: true, name: true },
    });
    if (!asset || asset.organizationId !== incident.organizationId) {
      throw new CrossOrganizationIncidentError();
    }
    let row;
    try {
      row = await tx.incidentAsset.create({
        data: {
          organizationId: incident.organizationId,
          incidentId: incident.id,
          assetId: input.assetId,
          note: input.note ?? null,
          recordedByAuthIdentityId: actorAuthIdentityId,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new IncidentDuplicateParticipantError(
          "That asset is already recorded on this incident.",
        );
      }
      throw error;
    }
    await timelineEvent(tx, incident, "ASSET_ADDED", actorAuthIdentityId, {
      assetId: input.assetId,
      assetName: asset.name,
    });
    return row;
  });
  log({
    event: "incident.asset_added",
    subsystem: "incidents",
    entityType: "IncidentAsset",
    entityId: participation.id,
    organizationId: participation.organizationId,
    actorId: actorAuthIdentityId,
  });
  return participation;
}

export async function removeIncidentAsset(
  participationId: string,
  actorAuthIdentityId: string,
) {
  await prisma.$transaction(async (tx) => {
    const row = await tx.incidentAsset.findUnique({
      where: { id: participationId },
      include: {
        asset: { select: { name: true } },
        incident: { select: { id: true, organizationId: true } },
      },
    });
    if (!row) throw new CrossOrganizationIncidentError();
    await tx.incidentAsset.delete({ where: { id: row.id } });
    await timelineEvent(
      tx,
      row.incident,
      "ASSET_REMOVED",
      actorAuthIdentityId,
      {
        assetId: row.assetId,
        assetName: row.asset.name,
      },
    );
  });
  log({
    event: "incident.asset_removed",
    subsystem: "incidents",
    entityType: "IncidentAsset",
    entityId: participationId,
    actorId: actorAuthIdentityId,
  });
}

/* ------------------------------------------------------------------ */
/* Human-authored notes                                                */
/* ------------------------------------------------------------------ */

/**
 * Add a human-authored note. `occurredAt` is an optional manual instant
 * for a past observation; when absent the note's fact time is simply
 * when it was written (`createdAt`). Notes are allowed on any status —
 * after-action narrative typically arrives after closing.
 */
export async function addIncidentNote(
  incidentId: string,
  input: IncidentNoteInput,
  actorAuthIdentityId: string,
) {
  const incident = await prisma.incident.findUnique({
    where: { id: incidentId },
    select: { id: true, organizationId: true },
  });
  if (!incident) throw new CrossOrganizationIncidentError();
  const timeZone = (
    await prisma.organization.findUniqueOrThrow({
      where: { id: incident.organizationId },
      select: { timezone: true },
    })
  ).timezone;
  const note = await prisma.incidentNote.create({
    data: {
      organizationId: incident.organizationId,
      incidentId: incident.id,
      authorAuthIdentityId: actorAuthIdentityId,
      kind: input.kind,
      body: input.body,
      occurredAt: toInstant(timeZone, input.occurredAt, "the note time"),
    },
  });
  log({
    event: "incident.note_added",
    subsystem: "incidents",
    entityType: "IncidentNote",
    entityId: note.id,
    organizationId: note.organizationId,
    actorId: actorAuthIdentityId,
  });
  return note;
}

/**
 * Correct a note's text: the row's `body` updates and an
 * IncidentNoteCorrection preserves before/after + reason + actor in the
 * same transaction — the original wording is always recoverable.
 * A same-body submission writes no history. The note row is locked so
 * concurrent amendments chain correctly.
 */
export async function correctIncidentNote(
  noteId: string,
  input: IncidentNoteCorrectionInput,
  actorAuthIdentityId: string,
) {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "IncidentNote" WHERE id = ${noteId} FOR UPDATE`;
    const note = await tx.incidentNote.findUnique({ where: { id: noteId } });
    if (!note) throw new CrossOrganizationIncidentError();
    if (note.body === input.body) {
      return { note, corrected: false };
    }
    await tx.incidentNoteCorrection.create({
      data: {
        organizationId: note.organizationId,
        noteId: note.id,
        incidentId: note.incidentId,
        beforeBody: note.body,
        afterBody: input.body,
        reason: input.reason ?? null,
        actorAuthIdentityId,
      },
    });
    const updated = await tx.incidentNote.update({
      where: { id: note.id },
      data: { body: input.body },
    });
    return { note: updated, corrected: true };
  });
  if (result.corrected) {
    log({
      event: "incident.note_corrected",
      subsystem: "incidents",
      entityType: "IncidentNote",
      entityId: result.note.id,
      organizationId: result.note.organizationId,
      actorId: actorAuthIdentityId,
    });
  }
  return result.note;
}

/* ------------------------------------------------------------------ */
/* Read models                                                         */
/* ------------------------------------------------------------------ */

/** Organization incident list — newest first, factual summary fields. */
export function listOrganizationIncidents(organizationId: string) {
  return prisma.incident.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: {
      callout: { select: { id: true, title: true, status: true } },
      _count: {
        select: { members: true, assets: true, notes: true },
      },
    },
  });
}

/**
 * One incident with its full administrative detail for the admin
 * surface: material fields, linked callout, participants, notes with
 * correction counts, timeline events, and the correction audit — plus a
 * merged chronological `feed` (system events + human notes, in
 * occurredAt order) so a reviewer reads one coherent record.
 *
 * Actor display resolves best-effort (member display name in this org →
 * identity email → raw scalar id) — the same policy as callouts.
 */
export async function getIncidentForAdmin(incidentId: string) {
  const incident = await prisma.incident.findUnique({
    where: { id: incidentId },
    include: {
      organization: { select: { id: true, name: true, timezone: true } },
      callout: {
        select: { id: true, title: true, status: true, activatedAt: true },
      },
      members: {
        orderBy: { recordedAt: "asc" },
        include: { member: { select: { id: true, displayName: true } } },
      },
      assets: {
        orderBy: { recordedAt: "asc" },
        include: { asset: { select: { id: true, name: true } } },
      },
      notes: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: {
          corrections: { orderBy: { createdAt: "asc" } },
        },
      },
      timeline: { orderBy: [{ occurredAt: "asc" }, { id: "asc" }] },
      changes: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] },
    },
  });
  if (!incident) return null;

  const actorIds = [
    ...new Set(
      [
        incident.createdByAuthIdentityId,
        incident.closedByAuthIdentityId,
        ...incident.members.map((m) => m.recordedByAuthIdentityId),
        ...incident.assets.map((a) => a.recordedByAuthIdentityId),
        ...incident.notes.map((n) => n.authorAuthIdentityId),
        ...incident.notes.flatMap((n) =>
          n.corrections.map((c) => c.actorAuthIdentityId),
        ),
        ...incident.timeline.map((e) => e.actorAuthIdentityId),
        ...incident.changes.map((c) => c.actorAuthIdentityId),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  const labels = await resolveActorLabels(incident.organizationId, actorIds);
  const actorName = (id: string | null) => (id ? (labels.get(id) ?? id) : null);

  const notes = incident.notes.map((note) => ({
    ...note,
    authorDisplay: actorName(note.authorAuthIdentityId),
    corrections: note.corrections.map((c) => ({
      ...c,
      actorDisplay: actorName(c.actorAuthIdentityId),
    })),
  }));
  const timeline = incident.timeline.map((event) => ({
    ...event,
    actorDisplay: actorName(event.actorAuthIdentityId),
    text: describeIncidentTimelineEvent(event),
  }));

  // One chronological feed: system events and human notes interleaved
  // by fact time (note.occurredAt ?? createdAt; event.occurredAt), so a
  // reviewer reconstructs "what was recorded, when" in a single view.
  const feed = [
    ...timeline.map((event) => ({
      kind: "event" as const,
      sortAt: event.occurredAt,
      createdAt: event.createdAt,
      id: event.id,
      event,
    })),
    ...notes.map((note) => ({
      kind: "note" as const,
      sortAt: note.occurredAt ?? note.createdAt,
      createdAt: note.createdAt,
      id: note.id,
      note,
    })),
  ].sort(
    (a, b) =>
      a.sortAt.getTime() - b.sortAt.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );

  return {
    ...incident,
    createdByDisplay: actorName(incident.createdByAuthIdentityId),
    closedByDisplay: actorName(incident.closedByAuthIdentityId),
    members: incident.members.map((m) => ({
      ...m,
      recordedByDisplay: actorName(m.recordedByAuthIdentityId),
    })),
    assets: incident.assets.map((a) => ({
      ...a,
      recordedByDisplay: actorName(a.recordedByAuthIdentityId),
    })),
    notes,
    timeline,
    changes: incident.changes.map((c) => ({
      ...c,
      actorDisplay: actorName(c.actorAuthIdentityId),
    })),
    feed,
  };
}
