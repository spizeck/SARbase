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
import { AuthenticationError, AuthorizationError } from "@/lib/auth/context";
import { emailSchema } from "@/lib/domain/schemas";
import { log } from "@/lib/logging";

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
