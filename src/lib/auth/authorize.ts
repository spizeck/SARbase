import { notFound, redirect } from "next/navigation";
import { OrgCapability } from "@prisma/client";

import { log } from "@/lib/logging";
import { prisma } from "@/lib/prisma";

import { ORG_CAPABILITIES } from "./capabilities";
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

/**
 * Delegated-capability checks (issue #84). ADMIN holds every
 * capability implicitly; MANAGER holds exactly the capabilities on its
 * current OrganizationAccess row; MEMBER holds none. Grants are read
 * from the verified session's access rows — evaluated against current
 * database state on every request, so revocations apply immediately.
 */
export function hasOrgCapability(
  ctx: AuthContext,
  organizationId: string,
  capability: OrgCapability,
): boolean {
  return ctx.access.some(
    (a) =>
      a.organizationId === organizationId &&
      (a.role === "ADMIN" ||
        (a.role === "MANAGER" && a.capabilities.includes(capability))),
  );
}

/**
 * Whether the caller can see the admin workspace at all — ADMIN or
 * MANAGER. This only gates the shell; every destination enforces its
 * own capability, and a MANAGER with no grants sees an empty shell.
 */
export function isOrgStaff(ctx: AuthContext, organizationId: string): boolean {
  return ctx.access.some(
    (a) =>
      a.organizationId === organizationId &&
      (a.role === "ADMIN" || a.role === "MANAGER"),
  );
}

/** Effective capability set for UI/nav filtering. ADMIN → all. */
export function orgCapabilities(
  ctx: AuthContext,
  organizationId: string,
): OrgCapability[] {
  const grant = ctx.access.find((a) => a.organizationId === organizationId);
  if (!grant) return [];
  if (grant.role === "ADMIN") return ORG_CAPABILITIES.slice();
  if (grant.role === "MANAGER") return grant.capabilities;
  return [];
}

/**
 * Require an explicit capability grant (or ADMIN) in the given
 * organization. `organizationId` remains an untrusted selector — it
 * only selects WHICH grant must carry the capability.
 */
export function requireOrgCapability(
  ctx: AuthContext,
  organizationId: string,
  capability: OrgCapability,
): void {
  if (!hasOrgCapability(ctx, organizationId, capability)) {
    logDenial("authz.org_capability_denied", ctx, {
      organizationId,
      capability,
    });
    throw new AuthorizationError();
  }
}

/** notFound() variant for pages — no existence disclosure. */
export async function requireOrgCapabilityOrNotFound(
  organizationId: string,
  capability: OrgCapability,
): Promise<AuthContext> {
  const ctx = await requireAuth();
  if (!hasOrgCapability(ctx, organizationId, capability)) {
    logDenial("authz.org_capability_denied", ctx, {
      organizationId,
      capability,
    });
    notFound();
  }
  return ctx;
}

/**
 * Staff-workspace gate (admin layout): ADMIN or MANAGER of the org.
 * Member visitors get the same opaque 404 as an inaccessible org.
 */
export async function requireOrgStaffOrNotFound(
  organizationId: string,
): Promise<AuthContext> {
  const ctx = await requireAuth();
  if (!isOrgStaff(ctx, organizationId)) {
    logDenial("authz.org_staff_denied", ctx, { organizationId });
    notFound();
  }
  return ctx;
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
 * Any-role variant for the shared organization dashboard — an org
 * the caller cannot access is indistinguishable from a missing one.
 */
export async function requireOrgAccessOrNotFound(
  organizationId: string,
): Promise<AuthContext> {
  const ctx = await requireAuth();
  if (!hasOrgAccess(ctx, organizationId)) {
    logDenial("authz.org_access_denied", ctx, { organizationId });
    notFound();
  }
  return ctx;
}

/**
 * Resolve a Member by the caller-supplied id, derive its REAL
 * organizationId from the record, and require the caller to hold the
 * governing capability on that org (members.manage by default;
 * callers from another domain pass theirs, e.g. QUALIFICATIONS_MANAGE
 * for member-qualification writes). The supplied organizationId (if
 * any) is never consulted.
 */
export async function requireOrgCapabilityForMember(
  ctx: AuthContext,
  memberId: string,
  capability: OrgCapability = OrgCapability.MEMBERS_MANAGE,
) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
  });
  if (!member || !hasOrgCapability(ctx, member.organizationId, capability)) {
    logDenial("authz.member_scope_denied", ctx, { entityId: memberId });
    throw new AuthorizationError();
  }
  return member;
}

/**
 * The ADMIN-only member resolver — for operations that are never
 * delegable: identity linking/unlinking and member invitations
 * (account administration, issue #84). Same untrusted-selector rule,
 * but the required grant is ADMIN, not a capability.
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

export async function requireOrgCapabilityForUnit(
  ctx: AuthContext,
  unitId: string,
) {
  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  if (
    !unit ||
    !hasOrgCapability(ctx, unit.organizationId, OrgCapability.MEMBERS_MANAGE)
  ) {
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

export async function requireOrgCapabilityForQualificationDefinition(
  ctx: AuthContext,
  definitionId: string,
) {
  const definition = await prisma.qualificationDefinition.findUnique({
    where: { id: definitionId },
  });
  if (
    !definition ||
    !hasOrgCapability(
      ctx,
      definition.organizationId,
      OrgCapability.QUALIFICATIONS_MANAGE,
    )
  ) {
    logDenial("authz.definition_scope_denied", ctx, { entityId: definitionId });
    throw new AuthorizationError();
  }
  return definition;
}

export async function requireOrgCapabilityForQualification(
  ctx: AuthContext,
  qualificationId: string,
) {
  const record = await prisma.memberQualification.findUnique({
    where: { id: qualificationId },
  });
  if (
    !record ||
    !hasOrgCapability(
      ctx,
      record.organizationId,
      OrgCapability.QUALIFICATIONS_MANAGE,
    )
  ) {
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
export async function requireOrgCapabilityForTrainingEvent(
  ctx: AuthContext,
  eventId: string,
) {
  const event = await prisma.trainingEvent.findUnique({
    where: { id: eventId },
  });
  if (
    !event ||
    !hasOrgCapability(ctx, event.organizationId, OrgCapability.TRAINING_MANAGE)
  ) {
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
export async function requireOrgCapabilityForStorageLocation(
  ctx: AuthContext,
  locationId: string,
) {
  const location = await prisma.storageLocation.findUnique({
    where: { id: locationId },
  });
  if (
    !location ||
    !hasOrgCapability(
      ctx,
      location.organizationId,
      OrgCapability.EQUIPMENT_MANAGE,
    )
  ) {
    logDenial("authz.location_scope_denied", ctx, { entityId: locationId });
    throw new AuthorizationError();
  }
  return location;
}

export async function requireOrgCapabilityForAsset(
  ctx: AuthContext,
  assetId: string,
) {
  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (
    !asset ||
    !hasOrgCapability(ctx, asset.organizationId, OrgCapability.EQUIPMENT_MANAGE)
  ) {
    logDenial("authz.asset_scope_denied", ctx, { entityId: assetId });
    throw new AuthorizationError();
  }
  return asset;
}

export async function requireOrgCapabilityForInventoryItem(
  ctx: AuthContext,
  itemId: string,
) {
  const item = await prisma.inventoryItem.findUnique({
    where: { id: itemId },
  });
  if (
    !item ||
    !hasOrgCapability(ctx, item.organizationId, OrgCapability.EQUIPMENT_MANAGE)
  ) {
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
export async function requireOrgCapabilityForInspectionDefinition(
  ctx: AuthContext,
  definitionId: string,
) {
  const definition = await prisma.inspectionDefinition.findUnique({
    where: { id: definitionId },
  });
  if (
    !definition ||
    !hasOrgCapability(
      ctx,
      definition.organizationId,
      OrgCapability.EQUIPMENT_MANAGE,
    )
  ) {
    logDenial("authz.inspection_definition_scope_denied", ctx, {
      entityId: definitionId,
    });
    throw new AuthorizationError();
  }
  return definition;
}

export async function requireOrgCapabilityForInspectionRecord(
  ctx: AuthContext,
  recordId: string,
) {
  const record = await prisma.inspectionRecord.findUnique({
    where: { id: recordId },
  });
  if (
    !record ||
    !hasOrgCapability(
      ctx,
      record.organizationId,
      OrgCapability.EQUIPMENT_MANAGE,
    )
  ) {
    logDenial("authz.inspection_record_scope_denied", ctx, {
      entityId: recordId,
    });
    throw new AuthorizationError();
  }
  return record;
}

export async function requireOrgCapabilityForMaintenancePlan(
  ctx: AuthContext,
  planId: string,
) {
  const plan = await prisma.maintenancePlan.findUnique({
    where: { id: planId },
  });
  if (
    !plan ||
    !hasOrgCapability(ctx, plan.organizationId, OrgCapability.EQUIPMENT_MANAGE)
  ) {
    logDenial("authz.maintenance_plan_scope_denied", ctx, {
      entityId: planId,
    });
    throw new AuthorizationError();
  }
  return plan;
}

export async function requireOrgCapabilityForMaintenanceRecord(
  ctx: AuthContext,
  recordId: string,
) {
  const record = await prisma.maintenanceRecord.findUnique({
    where: { id: recordId },
  });
  if (
    !record ||
    !hasOrgCapability(
      ctx,
      record.organizationId,
      OrgCapability.EQUIPMENT_MANAGE,
    )
  ) {
    logDenial("authz.maintenance_record_scope_denied", ctx, {
      entityId: recordId,
    });
    throw new AuthorizationError();
  }
  return record;
}

export async function requireOrgCapabilityForDefect(
  ctx: AuthContext,
  defectId: string,
) {
  const defect = await prisma.defect.findUnique({ where: { id: defectId } });
  if (
    !defect ||
    !hasOrgCapability(
      ctx,
      defect.organizationId,
      OrgCapability.EQUIPMENT_MANAGE,
    )
  ) {
    logDenial("authz.defect_scope_denied", ctx, { entityId: defectId });
    throw new AuthorizationError();
  }
  return defect;
}

export async function requireOrgCapabilityForAssetMeter(
  ctx: AuthContext,
  meterId: string,
) {
  const meter = await prisma.assetMeter.findUnique({ where: { id: meterId } });
  if (
    !meter ||
    !hasOrgCapability(ctx, meter.organizationId, OrgCapability.EQUIPMENT_MANAGE)
  ) {
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
export async function requireOrgCapabilityForNotification(
  ctx: AuthContext,
  notificationId: string,
) {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
  });
  if (
    !notification ||
    !hasOrgCapability(
      ctx,
      notification.organizationId,
      OrgCapability.NOTIFICATIONS_MANAGE,
    )
  ) {
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
export async function requireOrgCapabilityForCallout(
  ctx: AuthContext,
  calloutId: string,
) {
  const callout = await prisma.callout.findUnique({
    where: { id: calloutId },
  });
  if (
    !callout ||
    !hasOrgCapability(
      ctx,
      callout.organizationId,
      OrgCapability.OPERATIONS_MANAGE,
    )
  ) {
    logDenial("authz.callout_scope_denied", ctx, { entityId: calloutId });
    throw new AuthorizationError();
  }
  return callout;
}

/**
 * Member-invitation lookup — same rule: the caller-supplied id is an
 * untrusted selector; the invitation's own organizationId decides which
 * grant must exist.
 */
export async function requireOrgAdminForMemberInvitation(
  ctx: AuthContext,
  invitationId: string,
) {
  const invitation = await prisma.memberInvitation.findUnique({
    where: { id: invitationId },
  });
  if (!invitation || !isOrgAdmin(ctx, invitation.organizationId)) {
    logDenial("authz.member_invitation_scope_denied", ctx, {
      entityId: invitationId,
    });
    throw new AuthorizationError();
  }
  return invitation;
}

export async function requireOrgCapabilityForCalloutInvitation(
  ctx: AuthContext,
  invitationId: string,
) {
  const invitation = await prisma.calloutInvitation.findUnique({
    where: { id: invitationId },
  });
  if (
    !invitation ||
    !hasOrgCapability(
      ctx,
      invitation.organizationId,
      OrgCapability.OPERATIONS_MANAGE,
    )
  ) {
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
 * incident surface is staff-only — there is deliberately no member-role
 * variant. Participant/note rows resolve through their denormalized
 * organizationId (composite-FK guaranteed).
 */
export async function requireOrgCapabilityForIncident(
  ctx: AuthContext,
  incidentId: string,
) {
  const incident = await prisma.incident.findUnique({
    where: { id: incidentId },
  });
  if (
    !incident ||
    !hasOrgCapability(
      ctx,
      incident.organizationId,
      OrgCapability.OPERATIONS_MANAGE,
    )
  ) {
    logDenial("authz.incident_scope_denied", ctx, { entityId: incidentId });
    throw new AuthorizationError();
  }
  return incident;
}

export async function requireOrgCapabilityForIncidentMember(
  ctx: AuthContext,
  participationId: string,
) {
  const row = await prisma.incidentMember.findUnique({
    where: { id: participationId },
  });
  if (
    !row ||
    !hasOrgCapability(ctx, row.organizationId, OrgCapability.OPERATIONS_MANAGE)
  ) {
    logDenial("authz.incident_member_scope_denied", ctx, {
      entityId: participationId,
    });
    throw new AuthorizationError();
  }
  return row;
}

export async function requireOrgCapabilityForIncidentAsset(
  ctx: AuthContext,
  participationId: string,
) {
  const row = await prisma.incidentAsset.findUnique({
    where: { id: participationId },
  });
  if (
    !row ||
    !hasOrgCapability(ctx, row.organizationId, OrgCapability.OPERATIONS_MANAGE)
  ) {
    logDenial("authz.incident_asset_scope_denied", ctx, {
      entityId: participationId,
    });
    throw new AuthorizationError();
  }
  return row;
}

export async function requireOrgCapabilityForIncidentNote(
  ctx: AuthContext,
  noteId: string,
) {
  const note = await prisma.incidentNote.findUnique({
    where: { id: noteId },
  });
  if (
    !note ||
    !hasOrgCapability(ctx, note.organizationId, OrgCapability.OPERATIONS_MANAGE)
  ) {
    logDenial("authz.incident_note_scope_denied", ctx, { entityId: noteId });
    throw new AuthorizationError();
  }
  return note;
}

/**
 * Issue #16 lookups — same rule: the caller-supplied id is an untrusted
 * selector; the record's own organizationId decides which grant must
 * exist. Attachment mutations and organization documents require the
 * domain's capability (DOCUMENTS_MANAGE for file-level control, or the
 * target's domain capability for uploads/downloads) — knowing an
 * attachment id discloses nothing, and every read/mutation passes
 * through one of these helpers first.
 */
export async function requireOrgCapabilityForAttachment(
  ctx: AuthContext,
  attachmentId: string,
) {
  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId },
  });
  if (
    !attachment ||
    !hasOrgCapability(
      ctx,
      attachment.organizationId,
      OrgCapability.DOCUMENTS_MANAGE,
    )
  ) {
    logDenial("authz.attachment_scope_denied", ctx, {
      entityId: attachmentId,
    });
    throw new AuthorizationError();
  }
  return attachment;
}

/**
 * Which staff capability governs an attachment's linked target — the
 * download gate follows the record the file belongs to (issue #84).
 * DOCUMENTS_MANAGE also grants file-level control everywhere.
 */
const ATTACHMENT_LINK_CAPABILITIES = [
  ["incidentLinks", OrgCapability.OPERATIONS_MANAGE],
  ["incidentNoteLinks", OrgCapability.OPERATIONS_MANAGE],
  ["qualificationLinks", OrgCapability.QUALIFICATIONS_MANAGE],
  ["submissionLinks", OrgCapability.QUALIFICATIONS_VERIFY],
  ["trainingLinks", OrgCapability.TRAINING_MANAGE],
  ["assetLinks", OrgCapability.EQUIPMENT_MANAGE],
  ["inspectionLinks", OrgCapability.EQUIPMENT_MANAGE],
  ["maintenanceLinks", OrgCapability.EQUIPMENT_MANAGE],
  ["defectLinks", OrgCapability.EQUIPMENT_MANAGE],
  ["expenseLinks", OrgCapability.FINANCE_MANAGE],
  ["documentVersions", OrgCapability.DOCUMENTS_MANAGE],
] as const;

/**
 * Issue #71 member-scope attachment access — evidence files on the
 * caller's OWN records — extended for issue #84: staff download an
 * attachment when they hold the capability governing a record the file
 * is linked to (or DOCUMENTS_MANAGE). A non-staff member may download
 * only when the file is linked to a MemberSubmission they filed or a
 * MemberQualification on their own linked member record, in an
 * organization they currently hold access to. Same opaque denial as
 * every other scope check.
 */
export async function requireAttachmentForStaffOrOwner(
  ctx: AuthContext,
  attachmentId: string,
) {
  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId },
    include: {
      submissionLinks: {
        select: {
          memberSubmission: { select: { memberId: true } },
        },
      },
      qualificationLinks: {
        select: {
          memberQualification: { select: { memberId: true } },
        },
      },
      // One row per other link table — presence, not content, drives
      // the capability set the caller may hold. submissionLinks and
      // qualificationLinks already load member ids above.
      ...Object.fromEntries(
        ATTACHMENT_LINK_CAPABILITIES.filter(
          ([key]) => key !== "submissionLinks" && key !== "qualificationLinks",
        ).map(([key]) => [key, { select: { attachmentId: true }, take: 1 }]),
      ),
    },
  });
  if (!attachment) {
    logDenial("authz.attachment_scope_denied", ctx, {
      entityId: attachmentId,
    });
    throw new AuthorizationError();
  }
  const targetCapabilities = new Set<OrgCapability>([
    OrgCapability.DOCUMENTS_MANAGE,
    ...ATTACHMENT_LINK_CAPABILITIES.filter(
      ([key]) =>
        (attachment[key as keyof typeof attachment] as unknown[]).length > 0,
    ).map(([, capability]) => capability),
  ]);
  if (
    [...targetCapabilities].some((capability) =>
      hasOrgCapability(ctx, attachment.organizationId, capability),
    )
  ) {
    return attachment;
  }

  const ownMemberIds = new Set(linkedMembersWithAccess(ctx).map((m) => m.id));
  const isOwn =
    attachment.submissionLinks.some((l) =>
      ownMemberIds.has(l.memberSubmission.memberId),
    ) ||
    attachment.qualificationLinks.some((l) =>
      ownMemberIds.has(l.memberQualification.memberId),
    );
  if (!isOwn) {
    logDenial("authz.attachment_scope_denied", ctx, {
      entityId: attachmentId,
    });
    throw new AuthorizationError();
  }
  return attachment;
}

/**
 * Member-submission lookup — same rule: the caller-supplied id is an
 * untrusted selector; the submission's own organizationId decides which
 * grant must exist.
 */
export async function requireOrgCapabilityForMemberSubmission(
  ctx: AuthContext,
  submissionId: string,
) {
  const submission = await prisma.memberSubmission.findUnique({
    where: { id: submissionId },
    include: { member: { select: { displayName: true } } },
  });
  if (
    !submission ||
    !hasOrgCapability(
      ctx,
      submission.organizationId,
      OrgCapability.QUALIFICATIONS_VERIFY,
    )
  ) {
    logDenial("authz.submission_scope_denied", ctx, {
      entityId: submissionId,
    });
    throw new AuthorizationError();
  }
  return submission;
}

export async function requireOrgCapabilityForOrganizationDocument(
  ctx: AuthContext,
  documentId: string,
) {
  const document = await prisma.organizationDocument.findUnique({
    where: { id: documentId },
  });
  if (
    !document ||
    !hasOrgCapability(
      ctx,
      document.organizationId,
      OrgCapability.DOCUMENTS_MANAGE,
    )
  ) {
    logDenial("authz.document_scope_denied", ctx, { entityId: documentId });
    throw new AuthorizationError();
  }
  return document;
}

/**
 * Issue #17 lookups — same rule: the caller-supplied id is an untrusted
 * selector; the record's own organizationId decides which grant must
 * exist. Financial records are sensitive — vendor/expense surfaces
 * require FINANCE_MANAGE (or FINANCE_APPROVE for review decisions), and
 * a foreign or fabricated id is indistinguishable from a missing one.
 */
export async function requireOrgCapabilityForVendor(
  ctx: AuthContext,
  vendorId: string,
) {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  if (
    !vendor ||
    !hasOrgCapability(ctx, vendor.organizationId, OrgCapability.FINANCE_MANAGE)
  ) {
    logDenial("authz.vendor_scope_denied", ctx, { entityId: vendorId });
    throw new AuthorizationError();
  }
  return vendor;
}

export async function requireOrgCapabilityForExpense(
  ctx: AuthContext,
  expenseId: string,
  capability: OrgCapability = OrgCapability.FINANCE_MANAGE,
) {
  const expense = await prisma.expense.findUnique({
    where: { id: expenseId },
  });
  if (!expense || !hasOrgCapability(ctx, expense.organizationId, capability)) {
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
export async function requireOrgCapabilityForExpenseContextLink(
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
  if (
    !link ||
    !hasOrgCapability(ctx, link.organizationId, OrgCapability.FINANCE_MANAGE)
  ) {
    logDenial("authz.expense_link_scope_denied", ctx, { entityId: linkId });
    throw new AuthorizationError();
  }
  return link;
}

/**
 * Upload/unlink target resolution. `entityType` arrives from the client
 * and selects WHICH record helper verifies the grant — the grant is
 * still derived from the record's own organizationId, never from the
 * selector, and each entity type requires that domain's capability.
 * Unknown types fail closed.
 */
export async function requireOrgCapabilityForAttachmentTarget(
  ctx: AuthContext,
  entityType: string,
  entityId: string,
) {
  switch (entityType) {
    case "INCIDENT":
      return await requireOrgCapabilityForIncident(ctx, entityId);
    case "INCIDENT_NOTE":
      return await requireOrgCapabilityForIncidentNote(ctx, entityId);
    case "MEMBER_QUALIFICATION":
      return await requireOrgCapabilityForQualification(ctx, entityId);
    case "MEMBER_SUBMISSION":
      return await requireOrgCapabilityForMemberSubmission(ctx, entityId);
    case "TRAINING_EVENT":
      return await requireOrgCapabilityForTrainingEvent(ctx, entityId);
    case "ASSET":
      return await requireOrgCapabilityForAsset(ctx, entityId);
    case "INSPECTION_RECORD":
      return await requireOrgCapabilityForInspectionRecord(ctx, entityId);
    case "MAINTENANCE_RECORD":
      return await requireOrgCapabilityForMaintenanceRecord(ctx, entityId);
    case "DEFECT":
      return await requireOrgCapabilityForDefect(ctx, entityId);
    case "EXPENSE":
      return await requireOrgCapabilityForExpense(ctx, entityId);
    default:
      logDenial("authz.attachment_target_denied", ctx, { entityId });
      throw new AuthorizationError();
  }
}
