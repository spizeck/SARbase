"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";

import {
  createOrganization,
  updateOrganization,
} from "@/lib/domain/organization";
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
} from "@/lib/domain/schemas";
import { assertAdminEnabled } from "@/lib/admin-gate";

/**
 * Server actions for the internal administration surface.
 *
 * SECURITY NOTE — intentionally unauthenticated for now: issue #5 ships
 * the domain and its admin UI; issue #6 adds authentication and
 * centralized server-side authorization. Until then every action calls
 * the temporary `assertAdminEnabled()` gate FIRST — it throws in any
 * production build (deployed environments always run NODE_ENV=
 * production), so a crafted request cannot invoke mutations even though
 * no login exists yet. Issue #6 replaces this module with real authz.
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

function mapDomainError(error: unknown): ActionState | null {
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
  return null;
}

export async function createOrganizationAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  assertAdminEnabled();
  const parsed = organizationInputSchema.safeParse({
    name: formData.get("name"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  const organization = await createOrganization(parsed.data);
  redirect(`/admin/organizations/${organization.id}`);
}

export async function updateOrganizationAction(
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  assertAdminEnabled();
  const parsed = organizationInputSchema.safeParse({
    name: formData.get("name"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await updateOrganization(organizationId, parsed.data);
  } catch (error) {
    const mapped = mapDomainError(error);
    if (mapped) return mapped;
    throw error;
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
  assertAdminEnabled();
  const parsed = unitInputSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await createUnit(organizationId, parsed.data);
  } catch (error) {
    const mapped = mapDomainError(error);
    if (mapped) {
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
    throw error;
  }
  revalidatePath(`/admin/organizations/${organizationId}`);
  return {};
}

export async function updateUnitAction(
  unitId: string,
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  assertAdminEnabled();
  const parsed = unitInputSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await updateUnit(unitId, parsed.data);
  } catch (error) {
    const mapped = mapDomainError(error);
    if (mapped) {
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
    throw error;
  }
  revalidatePath(`/admin/organizations/${organizationId}`);
  return {};
}

export async function createMemberAction(
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  assertAdminEnabled();
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
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  assertAdminEnabled();
  const parsed = memberInputSchema.safeParse({
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    phone: formData.get("phone"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await updateMember(memberId, parsed.data);
  } catch (error) {
    const mapped = mapDomainError(error);
    if (mapped) return mapped;
    throw error;
  }
  revalidatePath(`/admin/members/${memberId}`);
  revalidatePath(`/admin/organizations/${organizationId}`);
  return {};
}

export async function setMemberStatusAction(
  memberId: string,
  organizationId: string,
  status: string,
): Promise<void> {
  assertAdminEnabled();
  const parsed = memberStatusSchema.safeParse(status);
  if (!parsed.success) return;

  await setMemberStatus(memberId, parsed.data);
  revalidatePath(`/admin/members/${memberId}`);
  revalidatePath(`/admin/organizations/${organizationId}`);
}

export async function setMemberUnitsAction(
  memberId: string,
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  assertAdminEnabled();
  const parsed = memberUnitsSchema.safeParse({
    unitIds: formData.getAll("unitIds"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await setMemberUnits(memberId, parsed.data.unitIds);
  } catch (error) {
    const mapped = mapDomainError(error);
    if (mapped) return mapped;
    throw error;
  }
  revalidatePath(`/admin/members/${memberId}`);
  revalidatePath(`/admin/organizations/${organizationId}`);
  return {};
}
