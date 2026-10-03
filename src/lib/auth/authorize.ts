import { notFound, redirect } from "next/navigation";

import { log } from "@/lib/logging";
import { prisma } from "@/lib/prisma";

import {
  AuthenticationError,
  AuthorizationError,
  getAuthContext,
  type AuthContext,
} from "./context";

/**
 * Centralized server-side authorization for the authenticated surface.
 *
 * THE RULE: an organizationId/memberId/unitId arriving from a URL, form,
 * server-action binding, hidden input, or query parameter is an
 * UNTRUSTED SELECTOR. Authorization is always derived here — from the
 * verified session's OrganizationAccess rows — never from the supplied
 * id itself. For member/unit targets the real organizationId is
 * resolved from the record, then checked against the caller's grants.
 *
 * Every helper fails closed; every denial is logged without PII.
 * Pages use the `*OrNotFound` variants so inaccessible resources are
 * indistinguishable from nonexistent ones (no existence disclosure).
 * Actions let the typed errors propagate to mapDomainError/ActionState
 * mapping which returns the same opaque "not found" message.
 */

function logDenial(event: string, ctx: AuthContext | null, detail?: object) {
  log({
    event,
    level: "warn",
    outcome: "expected_failure",
    subsystem: "authz",
    actorId: ctx?.identity.id,
    ...detail,
  });
}

/**
 * Require any authenticated, ACTIVE identity. Pages should use the
 * redirecting default; actions can catch AuthenticationError.
 */
export async function requireAuth(): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) {
    redirect("/login");
  }
  return ctx;
}

/** Non-redirecting variant for actions/tests. */
export async function getAuthContextOrThrow(): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) {
    throw new AuthenticationError("unauthenticated");
  }
  return ctx;
}

export function isOrgAdmin(ctx: AuthContext, organizationId: string): boolean {
  return ctx.access.some(
    (a) => a.organizationId === organizationId && a.role === "ADMIN",
  );
}

export function hasOrgAccess(
  ctx: AuthContext,
  organizationId: string,
): boolean {
  return ctx.access.some((a) => a.organizationId === organizationId);
}

/** Organizations this identity administers — for listing scoping. */
export function adminOrganizationIds(ctx: AuthContext): string[] {
  return ctx.access
    .filter((a) => a.role === "ADMIN")
    .map((a) => a.organizationId);
}

/**
 * Require ADMIN access to the given organization. `organizationId` is
 * still an untrusted selector — it only selects WHICH grant must exist.
 */
export function requireOrgAdmin(
  ctx: AuthContext,
  organizationId: string,
): void {
  if (!isOrgAdmin(ctx, organizationId)) {
    logDenial("authz.org_admin_denied", ctx, { organizationId });
    throw new AuthorizationError();
  }
}

export function requireOrgAccess(
  ctx: AuthContext,
  organizationId: string,
): void {
  if (!hasOrgAccess(ctx, organizationId)) {
    logDenial("authz.org_access_denied", ctx, { organizationId });
    throw new AuthorizationError();
  }
}

/** notFound() variant for pages — no existence disclosure. */
export async function requireOrgAdminOrNotFound(
  organizationId: string,
): Promise<AuthContext> {
  const ctx = await requireAuth();
  if (!isOrgAdmin(ctx, organizationId)) {
    logDenial("authz.org_admin_denied", ctx, { organizationId });
    notFound();
  }
  return ctx;
}

/**
 * Resolve a Member by the caller-supplied id, derive its REAL
 * organizationId from the record, and require ADMIN access to that
 * org. The supplied organizationId (if any) is never consulted.
 */
export async function requireOrgAdminForMember(
  ctx: AuthContext,
  memberId: string,
) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
  });
  if (!member || !isOrgAdmin(ctx, member.organizationId)) {
    logDenial("authz.member_scope_denied", ctx, { entityId: memberId });
    throw new AuthorizationError();
  }
  return member;
}

export async function requireOrgAdminForUnit(ctx: AuthContext, unitId: string) {
  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!unit || !isOrgAdmin(ctx, unit.organizationId)) {
    logDenial("authz.unit_scope_denied", ctx, { entityId: unitId });
    throw new AuthorizationError();
  }
  return unit;
}

/**
 * QualificationDefinition/MemberQualification lookups — same rule: the
 * caller-supplied id selects the record; the record's own
 * organizationId (denormalized + composite-FK-guaranteed on
 * MemberQualification) decides which grant must exist.
 */
/**
 * The linked member records this identity may actually see. A
 * Member.authIdentityId link answers "which person is this login?" —
 * it is NOT an access grant. A member record (and everything derived
 * from it — qualifications, future self-service data) is visible only
 * when the caller also holds a current OrganizationAccess row for the
 * member's organization. Stale links are left in place — access can be
 * re-granted — but expose nothing while it is absent.
 */
export function linkedMembersWithAccess(ctx: AuthContext) {
  const orgIds = new Set(ctx.access.map((a) => a.organizationId));
  return ctx.members.filter((m) => orgIds.has(m.organizationId));
}

export async function requireOrgAdminForDefinition(
  ctx: AuthContext,
  definitionId: string,
) {
  const definition = await prisma.qualificationDefinition.findUnique({
    where: { id: definitionId },
  });
  if (!definition || !isOrgAdmin(ctx, definition.organizationId)) {
    logDenial("authz.definition_scope_denied", ctx, { entityId: definitionId });
    throw new AuthorizationError();
  }
  return definition;
}

export async function requireOrgAdminForQualification(
  ctx: AuthContext,
  qualificationId: string,
) {
  const record = await prisma.memberQualification.findUnique({
    where: { id: qualificationId },
  });
  if (!record || !isOrgAdmin(ctx, record.organizationId)) {
    logDenial("authz.qualification_scope_denied", ctx, {
      entityId: qualificationId,
    });
    throw new AuthorizationError();
  }
  return record;
}

/**
 * TrainingEvent lookup — the event id is an untrusted selector; the
 * event's own organizationId decides which grant must exist. Attendance
 * is managed through the event, so this covers it too.
 */
export async function requireOrgAdminForTrainingEvent(
  ctx: AuthContext,
  eventId: string,
) {
  const event = await prisma.trainingEvent.findUnique({
    where: { id: eventId },
  });
  if (!event || !isOrgAdmin(ctx, event.organizationId)) {
    logDenial("authz.training_scope_denied", ctx, { entityId: eventId });
    throw new AuthorizationError();
  }
  return event;
}

/**
 * Issue #10 asset/inventory/location lookups — same rule: the
 * caller-supplied id selects the record; the record's own
 * organizationId decides which grant must exist.
 */
export async function requireOrgAdminForStorageLocation(
  ctx: AuthContext,
  locationId: string,
) {
  const location = await prisma.storageLocation.findUnique({
    where: { id: locationId },
  });
  if (!location || !isOrgAdmin(ctx, location.organizationId)) {
    logDenial("authz.location_scope_denied", ctx, { entityId: locationId });
    throw new AuthorizationError();
  }
  return location;
}

export async function requireOrgAdminForAsset(
  ctx: AuthContext,
  assetId: string,
) {
  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset || !isOrgAdmin(ctx, asset.organizationId)) {
    logDenial("authz.asset_scope_denied", ctx, { entityId: assetId });
    throw new AuthorizationError();
  }
  return asset;
}

export async function requireOrgAdminForInventoryItem(
  ctx: AuthContext,
  itemId: string,
) {
  const item = await prisma.inventoryItem.findUnique({
    where: { id: itemId },
  });
  if (!item || !isOrgAdmin(ctx, item.organizationId)) {
    logDenial("authz.item_scope_denied", ctx, { entityId: itemId });
    throw new AuthorizationError();
  }
  return item;
}

/**
 * Issue #11 lookups — same rule: the caller-supplied id is an untrusted
 * selector; the record's own organizationId decides which grant must
 * exist. Every issue #11 record carries a denormalized organizationId
 * guaranteed by composite FKs, so each of these is a single-row lookup.
 */
export async function requireOrgAdminForInspectionDefinition(
  ctx: AuthContext,
  definitionId: string,
) {
  const definition = await prisma.inspectionDefinition.findUnique({
    where: { id: definitionId },
  });
  if (!definition || !isOrgAdmin(ctx, definition.organizationId)) {
    logDenial("authz.inspection_definition_scope_denied", ctx, {
      entityId: definitionId,
    });
    throw new AuthorizationError();
  }
  return definition;
}

export async function requireOrgAdminForInspectionRecord(
  ctx: AuthContext,
  recordId: string,
) {
  const record = await prisma.inspectionRecord.findUnique({
    where: { id: recordId },
  });
  if (!record || !isOrgAdmin(ctx, record.organizationId)) {
    logDenial("authz.inspection_record_scope_denied", ctx, {
      entityId: recordId,
    });
    throw new AuthorizationError();
  }
  return record;
}

export async function requireOrgAdminForMaintenancePlan(
  ctx: AuthContext,
  planId: string,
) {
  const plan = await prisma.maintenancePlan.findUnique({
    where: { id: planId },
  });
  if (!plan || !isOrgAdmin(ctx, plan.organizationId)) {
    logDenial("authz.maintenance_plan_scope_denied", ctx, {
      entityId: planId,
    });
    throw new AuthorizationError();
  }
  return plan;
}

export async function requireOrgAdminForMaintenanceRecord(
  ctx: AuthContext,
  recordId: string,
) {
  const record = await prisma.maintenanceRecord.findUnique({
    where: { id: recordId },
  });
  if (!record || !isOrgAdmin(ctx, record.organizationId)) {
    logDenial("authz.maintenance_record_scope_denied", ctx, {
      entityId: recordId,
    });
    throw new AuthorizationError();
  }
  return record;
}

export async function requireOrgAdminForDefect(
  ctx: AuthContext,
  defectId: string,
) {
  const defect = await prisma.defect.findUnique({ where: { id: defectId } });
  if (!defect || !isOrgAdmin(ctx, defect.organizationId)) {
    logDenial("authz.defect_scope_denied", ctx, { entityId: defectId });
    throw new AuthorizationError();
  }
  return defect;
}

export async function requireOrgAdminForAssetMeter(
  ctx: AuthContext,
  meterId: string,
) {
  const meter = await prisma.assetMeter.findUnique({ where: { id: meterId } });
  if (!meter || !isOrgAdmin(ctx, meter.organizationId)) {
    logDenial("authz.meter_scope_denied", ctx, { entityId: meterId });
    throw new AuthorizationError();
  }
  return meter;
}

/**
 * Issue #13 notification lookup — same rule: the caller-supplied id is
 * an untrusted selector; the record's own organizationId decides which
 * grant must exist.
 */
export async function requireOrgAdminForNotification(
  ctx: AuthContext,
  notificationId: string,
) {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
  });
  if (!notification || !isOrgAdmin(ctx, notification.organizationId)) {
    logDenial("authz.notification_scope_denied", ctx, {
      entityId: notificationId,
    });
    throw new AuthorizationError();
  }
  return notification;
}

/**
 * Issue #14 callout lookups — same rule: the caller-supplied id is an
 * untrusted selector; the record's own organizationId decides which
 * grant must exist. Invitations are managed through their callout, so
 * the invitation variant resolves via the invitation's denormalized
 * organizationId.
 */
export async function requireOrgAdminForCallout(
  ctx: AuthContext,
  calloutId: string,
) {
  const callout = await prisma.callout.findUnique({
    where: { id: calloutId },
  });
  if (!callout || !isOrgAdmin(ctx, callout.organizationId)) {
    logDenial("authz.callout_scope_denied", ctx, { entityId: calloutId });
    throw new AuthorizationError();
  }
  return callout;
}

export async function requireOrgAdminForCalloutInvitation(
  ctx: AuthContext,
  invitationId: string,
) {
  const invitation = await prisma.calloutInvitation.findUnique({
    where: { id: invitationId },
  });
  if (!invitation || !isOrgAdmin(ctx, invitation.organizationId)) {
    logDenial("authz.callout_invitation_scope_denied", ctx, {
      entityId: invitationId,
    });
    throw new AuthorizationError();
  }
  return invitation;
}

/**
 * Issue #15 incident lookups — same rule: the caller-supplied id is an
 * untrusted selector; the record's own organizationId decides which
 * grant must exist. Incidents may carry sensitive data, so every
 * incident surface is ADMIN-only — there is deliberately no member-role
 * variant. Participant/note rows resolve through their denormalized
 * organizationId (composite-FK guaranteed).
 */
export async function requireOrgAdminForIncident(
  ctx: AuthContext,
  incidentId: string,
) {
  const incident = await prisma.incident.findUnique({
    where: { id: incidentId },
  });
  if (!incident || !isOrgAdmin(ctx, incident.organizationId)) {
    logDenial("authz.incident_scope_denied", ctx, { entityId: incidentId });
    throw new AuthorizationError();
  }
  return incident;
}

export async function requireOrgAdminForIncidentMember(
  ctx: AuthContext,
  participationId: string,
) {
  const row = await prisma.incidentMember.findUnique({
    where: { id: participationId },
  });
  if (!row || !isOrgAdmin(ctx, row.organizationId)) {
    logDenial("authz.incident_member_scope_denied", ctx, {
      entityId: participationId,
    });
    throw new AuthorizationError();
  }
  return row;
}

export async function requireOrgAdminForIncidentAsset(
  ctx: AuthContext,
  participationId: string,
) {
  const row = await prisma.incidentAsset.findUnique({
    where: { id: participationId },
  });
  if (!row || !isOrgAdmin(ctx, row.organizationId)) {
    logDenial("authz.incident_asset_scope_denied", ctx, {
      entityId: participationId,
    });
    throw new AuthorizationError();
  }
  return row;
}

export async function requireOrgAdminForIncidentNote(
  ctx: AuthContext,
  noteId: string,
) {
  const note = await prisma.incidentNote.findUnique({
    where: { id: noteId },
  });
  if (!note || !isOrgAdmin(ctx, note.organizationId)) {
    logDenial("authz.incident_note_scope_denied", ctx, { entityId: noteId });
    throw new AuthorizationError();
  }
  return note;
}

/**
 * Issue #16 lookups — same rule: the caller-supplied id is an untrusted
 * selector; the record's own organizationId decides which grant must
 * exist. Attachment metadata, downloads, and organization documents are
 * all ADMIN-only — knowing an attachment id discloses nothing, and
 * every read/mutation passes through one of these helpers first.
 */
export async function requireOrgAdminForAttachment(
  ctx: AuthContext,
  attachmentId: string,
) {
  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId },
  });
  if (!attachment || !isOrgAdmin(ctx, attachment.organizationId)) {
    logDenial("authz.attachment_scope_denied", ctx, {
      entityId: attachmentId,
    });
    throw new AuthorizationError();
  }
  return attachment;
}

export async function requireOrgAdminForOrganizationDocument(
  ctx: AuthContext,
  documentId: string,
) {
  const document = await prisma.organizationDocument.findUnique({
    where: { id: documentId },
  });
  if (!document || !isOrgAdmin(ctx, document.organizationId)) {
    logDenial("authz.document_scope_denied", ctx, { entityId: documentId });
    throw new AuthorizationError();
  }
  return document;
}

/**
 * Issue #17 lookups — same rule: the caller-supplied id is an untrusted
 * selector; the record's own organizationId decides which grant must
 * exist. Financial records are sensitive — every vendor/expense surface
 * is ADMIN-only, and a foreign or fabricated id is indistinguishable
 * from a missing one.
 */
export async function requireOrgAdminForVendor(
  ctx: AuthContext,
  vendorId: string,
) {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor || !isOrgAdmin(ctx, vendor.organizationId)) {
    logDenial("authz.vendor_scope_denied", ctx, { entityId: vendorId });
    throw new AuthorizationError();
  }
  return vendor;
}

export async function requireOrgAdminForExpense(
  ctx: AuthContext,
  expenseId: string,
) {
  const expense = await prisma.expense.findUnique({
    where: { id: expenseId },
  });
  if (!expense || !isOrgAdmin(ctx, expense.organizationId)) {
    logDenial("authz.expense_scope_denied", ctx, { entityId: expenseId });
    throw new AuthorizationError();
  }
  return expense;
}

/**
 * Context-link rows are removed by their own id — the denormalized
 * organizationId on the link row decides the grant. `kind` selects
 * which typed link table holds the row.
 */
export async function requireOrgAdminForExpenseContextLink(
  ctx: AuthContext,
  kind: string,
  linkId: string,
) {
  const where = { id: linkId };
  const link =
    kind === "INCIDENT"
      ? await prisma.expenseIncident.findUnique({ where })
      : kind === "TRAINING_EVENT"
        ? await prisma.expenseTrainingEvent.findUnique({ where })
        : kind === "ASSET"
          ? await prisma.expenseAsset.findUnique({ where })
          : kind === "MAINTENANCE_RECORD"
            ? await prisma.expenseMaintenanceRecord.findUnique({ where })
            : kind === "INVENTORY_ITEM"
              ? await prisma.expenseInventoryItem.findUnique({ where })
              : null;
  if (!link || !isOrgAdmin(ctx, link.organizationId)) {
    logDenial("authz.expense_link_scope_denied", ctx, { entityId: linkId });
    throw new AuthorizationError();
  }
  return link;
}

/**
 * Upload/unlink target resolution. `entityType` arrives from the client
 * and selects WHICH record helper verifies the grant — the grant is
 * still derived from the record's own organizationId, never from the
 * selector. Unknown types fail closed.
 */
export async function requireOrgAdminForAttachmentTarget(
  ctx: AuthContext,
  entityType: string,
  entityId: string,
) {
  switch (entityType) {
    case "INCIDENT":
      return await requireOrgAdminForIncident(ctx, entityId);
    case "INCIDENT_NOTE":
      return await requireOrgAdminForIncidentNote(ctx, entityId);
    case "MEMBER_QUALIFICATION":
      return await requireOrgAdminForQualification(ctx, entityId);
    case "TRAINING_EVENT":
      return await requireOrgAdminForTrainingEvent(ctx, entityId);
    case "ASSET":
      return await requireOrgAdminForAsset(ctx, entityId);
    case "INSPECTION_RECORD":
      return await requireOrgAdminForInspectionRecord(ctx, entityId);
    case "MAINTENANCE_RECORD":
      return await requireOrgAdminForMaintenanceRecord(ctx, entityId);
    case "DEFECT":
      return await requireOrgAdminForDefect(ctx, entityId);
    case "EXPENSE":
      return await requireOrgAdminForExpense(ctx, entityId);
    default:
      logDenial("authz.attachment_target_denied", ctx, { entityId });
      throw new AuthorizationError();
  }
}
