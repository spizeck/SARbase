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
} from "@/lib/domain/schemas";
import {
  requireAuth,
  requireOrgAdmin,
  requireOrgAdminForMember,
  requireOrgAdminForUnit,
  requireOrgAdminForDefinition,
  requireOrgAdminForQualification,
} from "@/lib/auth/authorize";
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
