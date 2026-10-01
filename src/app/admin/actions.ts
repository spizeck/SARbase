"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { updateOrganization } from "@/lib/domain/organization";
import { createUnit, updateUnit } from "@/lib/domain/unit";
import {
  createMember,
  updateMember,
  setMemberStatus,
  setMemberUnits,
  CrossOrganizationAssignmentError,
} from "@/lib/domain/member";
import {
  organizationInputSchema,
  unitInputSchema,
  memberInputSchema,
  memberStatusSchema,
  memberUnitsSchema,
  qualificationDefinitionInputSchema,
  qualificationDefinitionStatusSchema,
  memberQualificationInputSchema,
  trainingEventInputSchema,
  trainingEventStatusSchema,
  trainingAttendanceSchema,
  storageLocationInputSchema,
  assetInputSchema,
  inventoryItemInputSchema,
  inspectionDefinitionInputSchema,
  inspectionDefinitionStatusSchema,
  inspectionRecordInputSchema,
  inspectionRecordUpdateSchema,
  maintenancePlanInputSchema,
  maintenancePlanStatusSchema,
  maintenanceRecordInputSchema,
  maintenanceRecordUpdateSchema,
  defectInputSchema,
  defectTransitionSchema,
  assetMeterInputSchema,
  assetMeterStatusSchema,
  meterReadingInputSchema,
  availabilityUpdateSchema,
  contactPreferenceSchema,
  adminNotificationSendSchema,
  calloutActivationSchema,
  adminCalloutResponseSchema,
} from "@/lib/domain/schemas";
import {
  requireAuth,
  requireOrgAdmin,
  requireOrgAdminForMember,
  requireOrgAdminForUnit,
  requireOrgAdminForDefinition,
  requireOrgAdminForQualification,
  requireOrgAdminForTrainingEvent,
  requireOrgAdminForStorageLocation,
  requireOrgAdminForAsset,
  requireOrgAdminForInventoryItem,
  requireOrgAdminForInspectionDefinition,
  requireOrgAdminForInspectionRecord,
  requireOrgAdminForMaintenancePlan,
  requireOrgAdminForMaintenanceRecord,
  requireOrgAdminForDefect,
  requireOrgAdminForAssetMeter,
  requireOrgAdminForNotification,
  requireOrgAdminForCallout,
  requireOrgAdminForCalloutInvitation,
} from "@/lib/auth/authorize";
import {
  createTrainingEvent,
  updateTrainingEvent,
  setTrainingEventStatus,
  setTrainingAttendance,
  CrossOrganizationTrainingError,
  CancelledTrainingError,
} from "@/lib/domain/training";
import {
  createStorageLocation,
  updateStorageLocation,
  createAsset,
  updateAsset,
  createInventoryItem,
  updateInventoryItem,
  CrossOrganizationAssetError,
  AssetHierarchyError,
} from "@/lib/domain/assets";
import {
  createQualificationDefinition,
  updateQualificationDefinition,
  setQualificationDefinitionStatus,
  createMemberQualification,
  updateMemberQualification,
  CrossOrganizationQualificationError,
  InactiveQualificationError,
} from "@/lib/domain/qualification";
import {
  createInspectionDefinition,
  updateInspectionDefinition,
  setInspectionDefinitionStatus,
  recordInspection,
  updateInspectionRecord,
  createMaintenancePlan,
  updateMaintenancePlan,
  setMaintenancePlanStatus,
  recordMaintenance,
  updateMaintenanceRecord,
  reportDefect,
  updateDefect,
  transitionDefect,
  createAssetMeter,
  updateAssetMeter,
  setAssetMeterStatus,
  recordMeterReading,
  CrossOrganizationMaintenanceError,
  InactiveInspectionDefinitionError,
  InactiveMaintenancePlanError,
  ArchivedMeterError,
  MeterReadingDecreaseError,
  DefectTransitionError,
} from "@/lib/domain/maintenance";
import {
  recordMemberAvailability,
  setMemberContactPreference,
  AvailabilityInputError,
  ContactPreferenceDestinationError,
} from "@/lib/domain/availability";
import {
  requestNotification,
  retryNotification,
  NotificationIdempotencyConflictError,
  NotificationConcurrentDispatchError,
  NotificationRecipientError,
  NotificationRetryError,
} from "@/lib/domain/notifications";
import { NotificationConfigError } from "@/lib/notifications/provider";
import {
  activateCallout,
  closeCallout,
  recordInvitationResponse,
  CalloutAudienceError,
  CalloutClosedError,
  CalloutIdempotencyConflictError,
  CalloutTokenInvalidError,
  CrossOrganizationCalloutError,
} from "@/lib/domain/callouts";
import { checkRateLimit } from "@/lib/rate-limit/rate-limit";
import { rateLimitKey } from "@/lib/rate-limit/keys";
import { InMemoryRateLimitStore } from "@/lib/rate-limit/memory-store";
import { AuthenticationError, AuthorizationError } from "@/lib/auth/context";
import { emailSchema } from "@/lib/domain/schemas";
import { log, logExpected } from "@/lib/logging";

/**
 * Server actions for the internal administration surface.
 *
 * AUTHORIZATION MODEL (issue #6): every action resolves the caller's
 * auth context from the verified session, then checks an explicit
 * OrganizationAccess ADMIN row for the REAL organization of the target.
 * organizationId/memberId/unitId parameters are untrusted selectors —
 * they choose which record to act on, never which grant to honor. Where
 * an org id used to come from the caller, the record's own
 * organizationId is used instead.
 *
 * Failures are deliberately opaque: AuthorizationError maps to a generic
 * "Not found." so probes cannot distinguish "record doesn't exist" from
 * "record exists outside your scope".
 */

export interface ActionState {
  fieldErrors?: Record<string, string[]>;
  message?: string;
}

function zodErrors(error: {
  issues: { path: PropertyKey[]; message: string }[];
}) {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "_form");
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return { fieldErrors } satisfies ActionState;
}

function mapDomainError(error: unknown): ActionState {
  if (
    error instanceof AuthorizationError ||
    error instanceof AuthenticationError
  ) {
    return { message: "Not found." };
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      return { message: "A record with that name already exists." };
    }
    if (error.code === "P2025") {
      return { message: "Record not found. It may have been removed." };
    }
    if (error.code === "P2034") {
      // Transaction-level write conflict. Containment writes serialize
      // on the org advisory lock, so this is a raced placement — safe,
      // retryable, and not a leak.
      return {
        message:
          "That change conflicted with another update in progress. Please try again.",
      };
    }
  }
  if (error instanceof CrossOrganizationAssignmentError) {
    return { message: error.message };
  }
  if (error instanceof CrossOrganizationQualificationError) {
    // Deliberately opaque — a foreign-org definition id must not leak
    // that the definition exists.
    return { message: "Not found." };
  }
  if (error instanceof InactiveQualificationError) {
    return { message: error.message };
  }
  if (error instanceof CancelledTrainingError) {
    return { message: error.message };
  }
  if (error instanceof CrossOrganizationTrainingError) {
    // Opaque — foreign-org unit/member ids must not leak existence.
    return { message: "Not found." };
  }
  if (error instanceof AssetHierarchyError) {
    // Hierarchy violations (cycles, self-parenting, dual container) are
    // configuration errors inside the caller's own organization — the
    // message is safe to surface.
    return { message: error.message };
  }
  if (error instanceof CrossOrganizationAssetError) {
    // Opaque — foreign-org location/asset/unit ids must not leak.
    return { message: "Not found." };
  }
  if (error instanceof CrossOrganizationMaintenanceError) {
    // Opaque — foreign-org asset/definition/plan/meter/member ids must
    // not leak existence.
    return { message: "Not found." };
  }
  if (
    error instanceof InactiveInspectionDefinitionError ||
    error instanceof InactiveMaintenancePlanError ||
    error instanceof ArchivedMeterError ||
    error instanceof MeterReadingDecreaseError ||
    error instanceof DefectTransitionError
  ) {
    // Configuration facts about the caller's own organization — safe.
    return { message: error.message };
  }
  if (
    error instanceof AvailabilityInputError ||
    error instanceof ContactPreferenceDestinationError
  ) {
    // Input rules about the caller's own organization — safe to surface.
    return { message: error.message };
  }
  if (error instanceof NotificationRecipientError) {
    // Opaque — a member id outside this organization must not leak.
    return { message: "Not found." };
  }
  if (error instanceof NotificationIdempotencyConflictError) {
    return { message: error.message };
  }
  if (error instanceof NotificationConcurrentDispatchError) {
    return { message: error.message };
  }
  if (error instanceof NotificationRetryError) {
    return { message: error.message };
  }
  if (error instanceof NotificationConfigError) {
    // Env var names are fine for operators; values never surface.
    return {
      message:
        "Email delivery is not configured for this deployment. Contact the operator.",
    };
  }
  if (error instanceof CrossOrganizationCalloutError) {
    // Opaque — foreign-org unit/member ids must not leak existence.
    return { message: "Not found." };
  }
  if (
    error instanceof CalloutAudienceError ||
    error instanceof CalloutIdempotencyConflictError ||
    error instanceof CalloutClosedError
  ) {
    // Facts about the caller's own organization — safe to surface.
    return { message: error.message };
  }
  if (error instanceof CalloutTokenInvalidError) {
    // Admin surface: an invitation id that no longer resolves is "not
    // found" — the token-specific wording belongs to the public route.
    return { message: "Not found." };
  }
  throw error;
}

// There is deliberately NO createOrganizationAction: creating an
// organization and granting its first ADMIN is an explicit operator
// act via `npm run admin:provision` — never an authenticated
// self-service path (see docs/authentication.md).

export async function updateOrganizationAction(
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    requireOrgAdmin(ctx, organizationId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = organizationInputSchema.safeParse({
    name: formData.get("name"),
    timezone: formData.get("timezone"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await updateOrganization(organizationId, parsed.data);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(`/admin/organizations/${organizationId}`);
  revalidatePath("/admin");
  return {};
}

export async function createUnitAction(
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    requireOrgAdmin(ctx, organizationId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = unitInputSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await createUnit(organizationId, parsed.data);
  } catch (error) {
    const mapped = mapDomainError(error);
    return mapped.message?.includes("already exists")
      ? {
          fieldErrors: {
            name: [
              "A unit with this name already exists in this organization.",
            ],
          },
        }
      : mapped;
  }
  revalidatePath(`/admin/organizations/${organizationId}`);
  return {};
}

export async function updateUnitAction(
  unitId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let unit;
  try {
    unit = await requireOrgAdminForUnit(ctx, unitId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = unitInputSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await updateUnit(unitId, parsed.data);
  } catch (error) {
    const mapped = mapDomainError(error);
    return mapped.message?.includes("already exists")
      ? {
          fieldErrors: {
            name: [
              "A unit with this name already exists in this organization.",
            ],
          },
        }
      : mapped;
  }
  revalidatePath(`/admin/organizations/${unit.organizationId}`);
  return {};
}

export async function createMemberAction(
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    requireOrgAdmin(ctx, organizationId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = memberInputSchema.safeParse({
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    phone: formData.get("phone"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  const member = await createMember(organizationId, parsed.data);
  redirect(`/admin/members/${member.id}`);
}

export async function updateMemberAction(
  memberId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let member;
  try {
    member = await requireOrgAdminForMember(ctx, memberId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = memberInputSchema.safeParse({
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    phone: formData.get("phone"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await updateMember(memberId, parsed.data);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(`/admin/members/${memberId}`);
  revalidatePath(`/admin/organizations/${member.organizationId}`);
  return {};
}

export async function setMemberStatusAction(
  memberId: string,
  status: string,
): Promise<void> {
  const ctx = await requireAuth();
  // Propagates the opaque AuthorizationError — a void action has no
  // error state to return.
  const member = await requireOrgAdminForMember(ctx, memberId);

  const parsed = memberStatusSchema.safeParse(status);
  if (!parsed.success) return;

  await setMemberStatus(memberId, parsed.data);
  revalidatePath(`/admin/members/${memberId}`);
  revalidatePath(`/admin/organizations/${member.organizationId}`);
}

export async function setMemberUnitsAction(
  memberId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let member;
  try {
    member = await requireOrgAdminForMember(ctx, memberId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = memberUnitsSchema.safeParse({
    unitIds: formData.getAll("unitIds"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await setMemberUnits(memberId, parsed.data.unitIds);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(`/admin/members/${memberId}`);
  revalidatePath(`/admin/organizations/${member.organizationId}`);
  return {};
}

/**
 * Link an existing sign-in account (AuthIdentity, resolved by its
 * normalized sign-in email) to this Member record. Explicit admin
 * action — an email match alone never grants identity ownership, and
 * the account must already exist (the person signed in at least once,
 * or an operator provisioned it). Linking also ensures a MEMBER-level
 * OrganizationAccess row in the member's organization so the account
 * has a deterministic access context.
 */
export async function linkIdentityToMemberAction(
  memberId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let member;
  try {
    member = await requireOrgAdminForMember(ctx, memberId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = emailSchema.safeParse(formData.get("email"));
  if (!parsed.success || !parsed.data) {
    return { fieldErrors: { email: ["Enter the account's sign-in email."] } };
  }

  // AuthIdentity.email is deliberately non-unique — it is a lookup
  // convenience, not an identity key. Linking is only permitted when the
  // email resolves to EXACTLY ONE active identity; ambiguous matches
  // refuse the link rather than silently picking one (mirrors
  // scripts/provision-admin.ts).
  const matches = await prisma.authIdentity.findMany({
    where: { email: parsed.data, status: "ACTIVE" },
  });
  if (matches.length === 0) {
    return {
      fieldErrors: {
        email: [
          "No active sign-in account with that email. The account must exist first.",
        ],
      },
    };
  }
  if (matches.length > 1) {
    return {
      fieldErrors: {
        email: [
          "Multiple sign-in accounts share that email. Linking must use an unambiguous identity — contact the operator.",
        ],
      },
    };
  }
  const identity = matches[0]!;

  try {
    await prisma.$transaction([
      prisma.member.update({
        where: { id: memberId },
        data: { authIdentityId: identity.id },
      }),
      prisma.organizationAccess.upsert({
        where: {
          authIdentityId_organizationId: {
            authIdentityId: identity.id,
            organizationId: member.organizationId,
          },
        },
        update: {},
        create: {
          authIdentityId: identity.id,
          organizationId: member.organizationId,
          role: "MEMBER",
        },
      }),
    ]);
  } catch (error) {
    // @@unique([organizationId, authIdentityId]): this identity is
    // already linked to a member record in this organization.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return {
        fieldErrors: {
          email: [
            "This account is already linked to a member record in this organization.",
          ],
        },
      };
    }
    throw error;
  }
  log({
    event: "auth.identity_linked",
    subsystem: "auth",
    actorId: ctx.identity.id,
    entityType: "Member",
    entityId: memberId,
    organizationId: member.organizationId,
    authIdentityId: identity.id,
  });

  revalidatePath(`/admin/members/${memberId}`);
  return {};
}

export async function unlinkIdentityFromMemberAction(
  memberId: string,
): Promise<void> {
  const ctx = await requireAuth();
  const member = await requireOrgAdminForMember(ctx, memberId);

  await prisma.member.update({
    where: { id: memberId },
    data: { authIdentityId: null },
  });
  log({
    event: "auth.identity_unlinked",
    subsystem: "auth",
    actorId: ctx.identity.id,
    entityType: "Member",
    entityId: memberId,
    organizationId: member.organizationId,
  });
  revalidatePath(`/admin/members/${memberId}`);
}

/* ------------------------------------------------------------------ */
/* Qualifications — same model: ids are untrusted selectors; the real  */
/* organization is resolved server-side from the target record.        */
/* ------------------------------------------------------------------ */

export async function createQualificationDefinitionAction(
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    requireOrgAdmin(ctx, organizationId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = qualificationDefinitionInputSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await createQualificationDefinition(organizationId, parsed.data);
  } catch (error) {
    const mapped = mapDomainError(error);
    return mapped.message?.includes("already exists")
      ? {
          fieldErrors: {
            name: [
              "A qualification with this name already exists in this organization.",
            ],
          },
        }
      : mapped;
  }
  revalidatePath(`/admin/organizations/${organizationId}`);
  return {};
}

export async function updateQualificationDefinitionAction(
  definitionId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let definition;
  try {
    definition = await requireOrgAdminForDefinition(ctx, definitionId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = qualificationDefinitionInputSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await updateQualificationDefinition(definitionId, parsed.data);
  } catch (error) {
    const mapped = mapDomainError(error);
    return mapped.message?.includes("already exists")
      ? {
          fieldErrors: {
            name: [
              "A qualification with this name already exists in this organization.",
            ],
          },
        }
      : mapped;
  }
  revalidatePath(`/admin/organizations/${definition.organizationId}`);
  return {};
}

export async function setQualificationDefinitionStatusAction(
  definitionId: string,
  status: string,
): Promise<void> {
  const ctx = await requireAuth();
  // Propagates the opaque AuthorizationError — a void action has no
  // error state to return.
  const definition = await requireOrgAdminForDefinition(ctx, definitionId);

  const parsed = qualificationDefinitionStatusSchema.safeParse(status);
  if (!parsed.success) return;

  await setQualificationDefinitionStatus(definitionId, parsed.data);
  revalidatePath(`/admin/organizations/${definition.organizationId}`);
}

export async function createMemberQualificationAction(
  memberId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    await requireOrgAdminForMember(ctx, memberId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = memberQualificationInputSchema.safeParse({
    definitionId: formData.get("definitionId"),
    issuedOn: formData.get("issuedOn"),
    expiresOn: formData.get("expiresOn"),
    issuer: formData.get("issuer"),
    reference: formData.get("reference"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await createMemberQualification(memberId, parsed.data);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(`/admin/members/${memberId}`);
  return {};
}

export async function updateMemberQualificationAction(
  qualificationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let record;
  try {
    record = await requireOrgAdminForQualification(ctx, qualificationId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = memberQualificationInputSchema
    .omit({ definitionId: true })
    .safeParse({
      issuedOn: formData.get("issuedOn"),
      expiresOn: formData.get("expiresOn"),
      issuer: formData.get("issuer"),
      reference: formData.get("reference"),
      notes: formData.get("notes"),
    });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await updateMemberQualification(qualificationId, parsed.data);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(`/admin/members/${record.memberId}`);
  return {};
}

/* ------------------------------------------------------------------ */
/* Training — same model: ids are untrusted selectors; the real        */
/* organization is resolved server-side from the target record.        */
/* ------------------------------------------------------------------ */

function parseTrainingForm(formData: FormData) {
  return trainingEventInputSchema.safeParse({
    title: formData.get("title"),
    date: formData.get("date"),
    unitId: formData.get("unitId"),
    durationMinutes: formData.get("durationMinutes"),
    location: formData.get("location"),
    instructorName: formData.get("instructorName"),
    leadMemberId: formData.get("leadMemberId"),
    notes: formData.get("notes"),
    followUp: formData.get("followUp"),
    topics: formData.getAll("topics").flatMap((v) => String(v).split(",")),
  });
}

export async function createTrainingEventAction(
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    requireOrgAdmin(ctx, organizationId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = parseTrainingForm(formData);
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await createTrainingEvent(organizationId, parsed.data);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(`/admin/organizations/${organizationId}`);
  return {};
}

export async function updateTrainingEventAction(
  eventId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let event;
  try {
    event = await requireOrgAdminForTrainingEvent(ctx, eventId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = parseTrainingForm(formData);
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await updateTrainingEvent(eventId, parsed.data);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(`/admin/training/${eventId}`);
  revalidatePath(`/admin/organizations/${event.organizationId}`);
  return {};
}

export async function setTrainingEventStatusAction(
  eventId: string,
  status: string,
): Promise<void> {
  const ctx = await requireAuth();
  // Propagates the opaque AuthorizationError — a void action has no
  // error state to return.
  const event = await requireOrgAdminForTrainingEvent(ctx, eventId);

  const parsed = trainingEventStatusSchema.safeParse(status);
  if (!parsed.success) return;

  await setTrainingEventStatus(eventId, parsed.data);
  revalidatePath(`/admin/training/${eventId}`);
  revalidatePath(`/admin/organizations/${event.organizationId}`);
}

export async function setTrainingAttendanceAction(
  eventId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    await requireOrgAdminForTrainingEvent(ctx, eventId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = trainingAttendanceSchema.safeParse({
    memberIds: formData.getAll("memberIds"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    // The audit actor is the verified session's AuthIdentity — derived
    // here from server auth context, never accepted as client input.
    await setTrainingAttendance(
      eventId,
      parsed.data.memberIds,
      ctx.identity.id,
    );
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(`/admin/training/${eventId}`);
  return {};
}

/* ------------------------------------------------------------------ */
/* Assets, inventory, storage (issue #10) — ids are untrusted          */
/* selectors; the real organization is resolved server-side from the   */
/* target record. ADMIN-only: no member self-service exists here.      */
/* ------------------------------------------------------------------ */

/**
 * A location's single container arrives as one select value:
 * "" (top level) | "location:<id>" | "asset:<id>" — the model's
 * XOR is physically unrepresentable in the form.
 */
function parseContainerRef(raw: FormDataEntryValue | null) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.startsWith("location:")) {
    return { parentLocationId: value.slice(9) };
  }
  if (value.startsWith("asset:")) {
    return { containingAssetId: value.slice(6) };
  }
  return {};
}

function parseLocationForm(formData: FormData) {
  return storageLocationInputSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description"),
    status: formData.get("status") ?? undefined,
    ...parseContainerRef(formData.get("container")),
  });
}

export async function createStorageLocationAction(
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    requireOrgAdmin(ctx, organizationId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = parseLocationForm(formData);
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await createStorageLocation(organizationId, parsed.data);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(`/admin/organizations/${organizationId}/locations`);
  return {};
}

export async function updateStorageLocationAction(
  locationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let location;
  try {
    location = await requireOrgAdminForStorageLocation(ctx, locationId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = parseLocationForm(formData);
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await updateStorageLocation(locationId, parsed.data);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(`/admin/organizations/${location.organizationId}/locations`);
  revalidatePath(`/admin/organizations/${location.organizationId}/assets`);
  return {};
}

function parseAssetForm(formData: FormData) {
  return assetInputSchema.safeParse({
    name: formData.get("name"),
    category: formData.get("category"),
    manufacturer: formData.get("manufacturer"),
    model: formData.get("model"),
    serialNumber: formData.get("serialNumber"),
    assetTag: formData.get("assetTag"),
    purchaseDate: formData.get("purchaseDate"),
    vendor: formData.get("vendor"),
    unitId: formData.get("unitId"),
    parentAssetId: formData.get("parentAssetId"),
    storageLocationId: formData.get("storageLocationId"),
    condition: formData.get("condition") ?? undefined,
    status: formData.get("status") ?? undefined,
    notes: formData.get("notes"),
  });
}

/** The only unique constraint an asset can violate is (org, assetTag). */
function mapAssetError(error: unknown): ActionState {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    return {
      fieldErrors: {
        assetTag: ["That asset tag is already in use in this organization."],
      },
    };
  }
  return mapDomainError(error);
}

export async function createAssetAction(
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    requireOrgAdmin(ctx, organizationId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = parseAssetForm(formData);
  if (!parsed.success) return zodErrors(parsed.error);

  let asset;
  try {
    asset = await createAsset(organizationId, parsed.data);
  } catch (error) {
    return mapAssetError(error);
  }
  redirect(`/admin/assets/${asset.id}`);
}

export async function updateAssetAction(
  assetId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let asset;
  try {
    asset = await requireOrgAdminForAsset(ctx, assetId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = parseAssetForm(formData);
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await updateAsset(assetId, parsed.data);
  } catch (error) {
    return mapAssetError(error);
  }
  revalidatePath(`/admin/assets/${assetId}`);
  revalidatePath(`/admin/organizations/${asset.organizationId}/assets`);
  return {};
}

function parseItemForm(formData: FormData) {
  return inventoryItemInputSchema.safeParse({
    name: formData.get("name"),
    category: formData.get("category"),
    quantity: formData.get("quantity"),
    unitOfMeasure: formData.get("unitOfMeasure"),
    vendor: formData.get("vendor"),
    unitId: formData.get("unitId"),
    storageLocationId: formData.get("storageLocationId"),
    condition: formData.get("condition") ?? undefined,
    status: formData.get("status") ?? undefined,
    notes: formData.get("notes"),
  });
}

export async function createInventoryItemAction(
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    requireOrgAdmin(ctx, organizationId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = parseItemForm(formData);
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await createInventoryItem(organizationId, parsed.data);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(`/admin/organizations/${organizationId}/inventory`);
  return {};
}

export async function updateInventoryItemAction(
  itemId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let item;
  try {
    item = await requireOrgAdminForInventoryItem(ctx, itemId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = parseItemForm(formData);
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await updateInventoryItem(itemId, parsed.data);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(`/admin/organizations/${item.organizationId}/inventory`);
  return {};
}

/* ------------------------------------------------------------------ */
/* Issue #11 — inspections, maintenance, defects, meters               */
/*                                                                     */
/* Same authorization contract as everything above: caller-supplied    */
/* ids are untrusted selectors, the record's own organizationId        */
/* decides the required grant, and cross-organization failures are     */
/* opaque "Not found." responses.                                      */
/* ------------------------------------------------------------------ */

function revalidateMaintenance(orgId: string, assetId?: string) {
  revalidatePath(`/admin/organizations/${orgId}/maintenance`);
  revalidatePath(`/admin/organizations/${orgId}`);
  if (assetId) revalidatePath(`/admin/assets/${assetId}`);
}

export async function createInspectionDefinitionAction(
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    requireOrgAdmin(ctx, organizationId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = inspectionDefinitionInputSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description"),
    recurrenceType: formData.get("recurrenceType") ?? "NONE",
    intervalValue: formData.get("intervalValue"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await createInspectionDefinition(organizationId, parsed.data);
  } catch (error) {
    const mapped = mapDomainError(error);
    return mapped.message?.includes("already exists")
      ? {
          fieldErrors: {
            name: [
              "An inspection type with this name already exists in this organization.",
            ],
          },
        }
      : mapped;
  }
  revalidateMaintenance(organizationId);
  return {};
}

export async function updateInspectionDefinitionAction(
  definitionId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let definition;
  try {
    definition = await requireOrgAdminForInspectionDefinition(
      ctx,
      definitionId,
    );
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = inspectionDefinitionInputSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description"),
    recurrenceType: formData.get("recurrenceType") ?? "NONE",
    intervalValue: formData.get("intervalValue"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await updateInspectionDefinition(definitionId, parsed.data);
  } catch (error) {
    const mapped = mapDomainError(error);
    return mapped.message?.includes("already exists")
      ? {
          fieldErrors: {
            name: [
              "An inspection type with this name already exists in this organization.",
            ],
          },
        }
      : mapped;
  }
  revalidateMaintenance(definition.organizationId);
  return {};
}

export async function setInspectionDefinitionStatusAction(
  definitionId: string,
  status: string,
): Promise<void> {
  const ctx = await requireAuth();
  const definition = await requireOrgAdminForInspectionDefinition(
    ctx,
    definitionId,
  );
  const parsed = inspectionDefinitionStatusSchema.safeParse(status);
  if (!parsed.success) return;
  await setInspectionDefinitionStatus(definitionId, parsed.data);
  revalidateMaintenance(definition.organizationId);
}

export async function recordInspectionAction(
  assetId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let asset;
  try {
    asset = await requireOrgAdminForAsset(ctx, assetId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = inspectionRecordInputSchema.safeParse({
    definitionId: formData.get("definitionId"),
    performedOn: formData.get("performedOn"),
    inspectorMemberId: formData.get("inspectorMemberId"),
    inspectorName: formData.get("inspectorName"),
    conditionObserved: formData.get("conditionObserved"),
    nextDueOn: formData.get("nextDueOn"),
    meterId: formData.get("meterId"),
    meterReading: formData.get("meterReading"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await recordInspection(assetId, parsed.data);
  } catch (error) {
    const mapped = mapDomainError(error);
    return mapped.message?.includes("meter")
      ? { fieldErrors: { meterReading: [mapped.message!] } }
      : mapped;
  }
  revalidateMaintenance(asset.organizationId, assetId);
  return {};
}

export async function updateInspectionRecordAction(
  recordId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let record;
  try {
    record = await requireOrgAdminForInspectionRecord(ctx, recordId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = inspectionRecordUpdateSchema.safeParse({
    performedOn: formData.get("performedOn"),
    inspectorMemberId: formData.get("inspectorMemberId"),
    inspectorName: formData.get("inspectorName"),
    conditionObserved: formData.get("conditionObserved"),
    nextDueOn: formData.get("nextDueOn"),
    notes: formData.get("notes"),
    correctionNote: formData.get("correctionNote"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    // The correction-history actor is the server-side identity — never
    // a client-supplied value.
    await updateInspectionRecord(recordId, parsed.data, ctx.identity.id);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidateMaintenance(record.organizationId, record.assetId);
  return {};
}

export async function createMaintenancePlanAction(
  assetId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let asset;
  try {
    asset = await requireOrgAdminForAsset(ctx, assetId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = maintenancePlanInputSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description"),
    intervalType: formData.get("intervalType") ?? "NONE",
    intervalValue: formData.get("intervalValue"),
    meterId: formData.get("meterId"),
    meterInterval: formData.get("meterInterval"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await createMaintenancePlan(assetId, parsed.data);
  } catch (error) {
    const mapped = mapDomainError(error);
    if (mapped.message?.includes("already exists")) {
      return {
        fieldErrors: {
          name: ["A plan with this name already exists on this asset."],
        },
      };
    }
    return mapped.message?.includes("meter")
      ? { fieldErrors: { meterId: [mapped.message!] } }
      : mapped;
  }
  revalidateMaintenance(asset.organizationId, assetId);
  return {};
}

export async function updateMaintenancePlanAction(
  planId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let plan;
  try {
    plan = await requireOrgAdminForMaintenancePlan(ctx, planId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = maintenancePlanInputSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description"),
    intervalType: formData.get("intervalType") ?? "NONE",
    intervalValue: formData.get("intervalValue"),
    meterId: formData.get("meterId"),
    meterInterval: formData.get("meterInterval"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await updateMaintenancePlan(planId, parsed.data);
  } catch (error) {
    const mapped = mapDomainError(error);
    if (mapped.message?.includes("already exists")) {
      return {
        fieldErrors: {
          name: ["A plan with this name already exists on this asset."],
        },
      };
    }
    return mapped.message?.includes("meter")
      ? { fieldErrors: { meterId: [mapped.message!] } }
      : mapped;
  }
  revalidateMaintenance(plan.organizationId, plan.assetId);
  return {};
}

export async function setMaintenancePlanStatusAction(
  planId: string,
  status: string,
): Promise<void> {
  const ctx = await requireAuth();
  const plan = await requireOrgAdminForMaintenancePlan(ctx, planId);
  const parsed = maintenancePlanStatusSchema.safeParse(status);
  if (!parsed.success) return;
  await setMaintenancePlanStatus(planId, parsed.data);
  revalidateMaintenance(plan.organizationId, plan.assetId);
}

export async function recordMaintenanceAction(
  assetId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let asset;
  try {
    asset = await requireOrgAdminForAsset(ctx, assetId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = maintenanceRecordInputSchema.safeParse({
    planId: formData.get("planId"),
    title: formData.get("title"),
    performedOn: formData.get("performedOn"),
    workPerformed: formData.get("workPerformed"),
    providerName: formData.get("providerName"),
    performedByMemberId: formData.get("performedByMemberId"),
    meterId: formData.get("meterId"),
    meterReading: formData.get("meterReading"),
    nextDueOn: formData.get("nextDueOn"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await recordMaintenance(assetId, parsed.data);
  } catch (error) {
    const mapped = mapDomainError(error);
    return mapped.message?.includes("meter")
      ? { fieldErrors: { meterReading: [mapped.message!] } }
      : mapped;
  }
  revalidateMaintenance(asset.organizationId, assetId);
  return {};
}

export async function updateMaintenanceRecordAction(
  recordId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let record;
  try {
    record = await requireOrgAdminForMaintenanceRecord(ctx, recordId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = maintenanceRecordUpdateSchema.safeParse({
    title: formData.get("title"),
    performedOn: formData.get("performedOn"),
    workPerformed: formData.get("workPerformed"),
    providerName: formData.get("providerName"),
    performedByMemberId: formData.get("performedByMemberId"),
    nextDueOn: formData.get("nextDueOn"),
    notes: formData.get("notes"),
    correctionNote: formData.get("correctionNote"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    // The correction-history actor is the server-side identity — never
    // a client-supplied value.
    await updateMaintenanceRecord(recordId, parsed.data, ctx.identity.id);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidateMaintenance(record.organizationId, record.assetId);
  return {};
}

export async function reportDefectAction(
  assetId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let asset;
  try {
    asset = await requireOrgAdminForAsset(ctx, assetId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = defectInputSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description"),
    reportedOn: formData.get("reportedOn"),
    reportedByMemberId: formData.get("reportedByMemberId"),
    reporterName: formData.get("reporterName"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await reportDefect(assetId, parsed.data, ctx.identity.id, {
      markOutOfService: formData.get("markOutOfService") === "on",
    });
  } catch (error) {
    return mapDomainError(error);
  }
  revalidateMaintenance(asset.organizationId, assetId);
  return {};
}

export async function updateDefectAction(
  defectId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let defect;
  try {
    defect = await requireOrgAdminForDefect(ctx, defectId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = defectInputSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description"),
    reportedOn: formData.get("reportedOn"),
    reportedByMemberId: formData.get("reportedByMemberId"),
    reporterName: formData.get("reporterName"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await updateDefect(defectId, parsed.data);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidateMaintenance(defect.organizationId, defect.assetId);
  return {};
}

export async function transitionDefectAction(
  defectId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let defect;
  try {
    defect = await requireOrgAdminForDefect(ctx, defectId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = defectTransitionSchema.safeParse({
    status: formData.get("status"),
    resolvedOn: formData.get("resolvedOn"),
    resolutionNotes: formData.get("resolutionNotes"),
    note: formData.get("note"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await transitionDefect(defectId, parsed.data, ctx.identity.id);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidateMaintenance(defect.organizationId, defect.assetId);
  return {};
}

export async function createAssetMeterAction(
  assetId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let asset;
  try {
    asset = await requireOrgAdminForAsset(ctx, assetId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = assetMeterInputSchema.safeParse({
    name: formData.get("name"),
    unit: formData.get("unit"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await createAssetMeter(assetId, parsed.data);
  } catch (error) {
    const mapped = mapDomainError(error);
    return mapped.message?.includes("already exists")
      ? {
          fieldErrors: {
            name: ["A meter with this name already exists on this asset."],
          },
        }
      : mapped;
  }
  revalidateMaintenance(asset.organizationId, assetId);
  return {};
}

export async function updateAssetMeterAction(
  meterId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let meter;
  try {
    meter = await requireOrgAdminForAssetMeter(ctx, meterId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = assetMeterInputSchema.safeParse({
    name: formData.get("name"),
    unit: formData.get("unit"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await updateAssetMeter(meterId, parsed.data);
  } catch (error) {
    const mapped = mapDomainError(error);
    return mapped.message?.includes("already exists")
      ? {
          fieldErrors: {
            name: ["A meter with this name already exists on this asset."],
          },
        }
      : mapped;
  }
  revalidateMaintenance(meter.organizationId, meter.assetId);
  return {};
}

export async function setAssetMeterStatusAction(
  meterId: string,
  status: string,
): Promise<void> {
  const ctx = await requireAuth();
  const meter = await requireOrgAdminForAssetMeter(ctx, meterId);
  const parsed = assetMeterStatusSchema.safeParse(status);
  if (!parsed.success) return;
  await setAssetMeterStatus(meterId, parsed.data);
  revalidateMaintenance(meter.organizationId, meter.assetId);
}

export async function recordMeterReadingAction(
  meterId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let meter;
  try {
    meter = await requireOrgAdminForAssetMeter(ctx, meterId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = meterReadingInputSchema.safeParse({
    reading: formData.get("reading"),
    recordedOn: formData.get("recordedOn"),
    recordedByMemberId: formData.get("recordedByMemberId"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await recordMeterReading(meterId, parsed.data);
  } catch (error) {
    const mapped = mapDomainError(error);
    return error instanceof MeterReadingDecreaseError
      ? { fieldErrors: { reading: [mapped.message!] } }
      : mapped;
  }
  revalidateMaintenance(meter.organizationId, meter.assetId);
  return {};
}

/* ------------------------------------------------------------------ */
/* Availability and contact preferences (issue #12)                    */
/*                                                                     */
/* Admin records availability statements on a member's behalf and      */
/* edits their contact preferences. memberId is an untrusted selector  */
/* — requireOrgAdminForMember resolves the record's real               */
/* organizationId and demands an ADMIN grant there. Statements are     */
/* append-only; admins create new rows, never rewrite history.         */
/* ------------------------------------------------------------------ */

export async function setMemberAvailabilityAction(
  memberId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let member;
  try {
    member = await requireOrgAdminForMember(ctx, memberId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = availabilityUpdateSchema.safeParse({
    status: formData.get("status"),
    until: formData.get("until"),
    note: formData.get("note"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await recordMemberAvailability(member.id, parsed.data, ctx.identity.id, {
      selfReported: false,
    });
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(`/admin/members/${member.id}`);
  revalidatePath(`/admin/organizations/${member.organizationId}`);
  return {};
}

export async function updateMemberContactPreferenceAction(
  memberId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let member;
  try {
    member = await requireOrgAdminForMember(ctx, memberId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = contactPreferenceSchema.safeParse({
    notifyEmail: formData.get("notifyEmail"),
    notifySms: formData.get("notifySms"),
    notifyWhatsapp: formData.get("notifyWhatsapp"),
    notifyPush: formData.get("notifyPush"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await setMemberContactPreference(member.id, parsed.data);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(`/admin/members/${member.id}`);
  return {};
}

/* ------------------------------------------------------------------ */
/* Notifications (issue #13)                                           */
/*                                                                     */
/* A compact admin surface: send one administrative test notification  */
/* and retry failed requests. ADMIN-only; organizationId from the page */
/* binding is still an untrusted selector checked against              */
/* OrganizationAccess. This is administrative/testing tooling — it is  */
/* deliberately NOT a callout or dispatch interface.                   */
/*                                                                     */
/* Rate limiting uses the existing fixed-window foundation with opaque */
/* hashed keys (org id + actor id — never an email or member id). The */
/* in-memory store is a per-process best-effort throttle; see          */
/* src/lib/rate-limit/rate-limit.ts for its documented limits.         */
/* ------------------------------------------------------------------ */

const notificationRateLimitStore = new InMemoryRateLimitStore();
const NOTIFICATION_RATE_LIMIT = { limit: 10, windowMs: 60_000 };

async function checkNotificationRateLimit(
  scope: "notification.send" | "notification.retry",
  organizationId: string,
  actorId: string,
): Promise<ActionState | null> {
  const result = await checkRateLimit(
    notificationRateLimitStore,
    rateLimitKey(scope, organizationId, actorId),
    NOTIFICATION_RATE_LIMIT,
  );
  if (result.allowed) {
    return null;
  }
  logExpected({
    event: "notification.rate_limited",
    subsystem: "notifications",
    actorId,
    organizationId,
    rateLimitScope: scope,
  });
  return {
    message:
      "Too many notification requests. Please wait a moment and try again.",
  };
}

/**
 * Send one administrative test notification — a member target (whose
 * channel preferences are enforced) or a one-off destination address.
 * The request is idempotent on the hidden form-render key: resubmitting
 * the same form returns the existing request instead of sending twice.
 */
export async function sendAdminNotificationAction(
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    requireOrgAdmin(ctx, organizationId);
  } catch (error) {
    return mapDomainError(error);
  }

  const limited = await checkNotificationRateLimit(
    "notification.send",
    organizationId,
    ctx.identity.id,
  );
  if (limited) return limited;

  const parsed = adminNotificationSendSchema.safeParse({
    memberId: formData.get("memberId"),
    destination: formData.get("destination"),
    subject: formData.get("subject"),
    body: formData.get("body"),
    idempotencyKey: formData.get("idempotencyKey"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await requestNotification(
      {
        organizationId,
        channel: "EMAIL",
        memberId: parsed.data.memberId,
        destination: parsed.data.destination,
        template: "admin_test",
        subject: parsed.data.subject,
        bodyText: `${parsed.data.body}\n\n—\nThis is an administrative test notification sent via SARbase. It is not an operational alert.`,
        metadata: { source: "admin_test_send" },
        idempotencyKey: parsed.data.idempotencyKey,
      },
      ctx.identity.id,
    );
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(`/admin/organizations/${organizationId}/notifications`);
  return {};
}

/**
 * Explicitly re-dispatch a failed/stuck notification — appends a new
 * attempt row; the domain refuses terminal or non-retryable states.
 */
export async function retryNotificationAction(
  notificationId: string,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let notification;
  try {
    notification = await requireOrgAdminForNotification(ctx, notificationId);
  } catch (error) {
    return mapDomainError(error);
  }

  const limited = await checkNotificationRateLimit(
    "notification.retry",
    notification.organizationId,
    ctx.identity.id,
  );
  if (limited) return limited;

  try {
    await retryNotification(notification.id);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(
    `/admin/organizations/${notification.organizationId}/notifications`,
  );
  return {};
}

/* ------------------------------------------------------------------ */
/* Callouts (issue #14)                                                */
/*                                                                     */
/* ADMIN-only activation/close/recording of factual volunteer          */
/* responses. Every id arriving via a binding is an untrusted          */
/* selector — authorization resolves the record's real organization.   */
/* Nothing here judges sufficiency, readiness, or crew fitness: a      */
/* callout is an invitation record plus its responses.                 */
/* ------------------------------------------------------------------ */

const calloutRateLimitStore = new InMemoryRateLimitStore();
const CALLOUT_RATE_LIMIT = { limit: 10, windowMs: 60_000 };

/**
 * Activate a callout: materialize the invited audience, mint secure
 * response links, and dispatch one email notification per invitee via
 * the notification foundation. Idempotent on the hidden per-render
 * activationKey — a double-submit returns the existing callout and
 * resumes any undispatched invitations rather than duplicating.
 */
export async function activateCalloutAction(
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    requireOrgAdmin(ctx, organizationId);
  } catch (error) {
    return mapDomainError(error);
  }

  const limited = await checkCalloutRateLimit(organizationId, ctx.identity.id);
  if (limited) return limited;

  const parsed = calloutActivationSchema.safeParse({
    title: formData.get("title"),
    message: formData.get("message"),
    audience: formData.get("audience"),
    unitId: formData.get("unitId"),
    memberIds: formData.getAll("memberIds"),
    activationKey: formData.get("activationKey"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  let result;
  try {
    result = await activateCallout(
      organizationId,
      parsed.data,
      ctx.identity.id,
    );
  } catch (error) {
    return mapDomainError(error);
  }
  redirect(
    `/admin/organizations/${organizationId}/callouts/${result.callout.id}`,
  );
}

async function checkCalloutRateLimit(
  organizationId: string,
  actorId: string,
): Promise<ActionState | null> {
  const result = await checkRateLimit(
    calloutRateLimitStore,
    rateLimitKey("callout.activate", organizationId, actorId),
    CALLOUT_RATE_LIMIT,
  );
  if (result.allowed) {
    return null;
  }
  logExpected({
    event: "callout.rate_limited",
    subsystem: "callouts",
    actorId,
    organizationId,
    rateLimitScope: "callout.activate",
  });
  return {
    message: "Too many callout requests. Please wait a moment and try again.",
  };
}

/** Close a callout — preserves history; tokens stop accepting responses. */
export async function closeCalloutAction(
  calloutId: string,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let callout;
  try {
    callout = await requireOrgAdminForCallout(ctx, calloutId);
    await closeCallout(callout.id, ctx.identity.id);
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(
    `/admin/organizations/${callout.organizationId}/callouts/${callout.id}`,
  );
  revalidatePath(`/admin/organizations/${callout.organizationId}/callouts`);
  return {};
}

/**
 * Record a member's response on their behalf — e.g. the member phoned
 * the duty officer. The history row's source is ADMIN and the actor is
 * the acting admin's identity, so it never masquerades as a token
 * response.
 */
export async function recordCalloutResponseAction(
  invitationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireAuth();
  let invitation;
  try {
    invitation = await requireOrgAdminForCalloutInvitation(ctx, invitationId);
  } catch (error) {
    return mapDomainError(error);
  }

  const parsed = adminCalloutResponseSchema.safeParse({
    response: formData.get("response"),
    note: formData.get("note"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await recordInvitationResponse(
      invitation.id,
      parsed.data.response,
      "ADMIN",
      ctx.identity.id,
      parsed.data.note ?? null,
    );
  } catch (error) {
    return mapDomainError(error);
  }
  revalidatePath(
    `/admin/organizations/${invitation.organizationId}/callouts/${invitation.calloutId}`,
  );
  return {};
}
