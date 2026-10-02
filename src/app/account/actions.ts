"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";

import {
  getAuthContextOrThrow,
  linkedMembersWithAccess,
} from "@/lib/auth/authorize";
import {
  AuthenticationError,
  AuthorizationError,
  type AuthContext,
} from "@/lib/auth/context";
import { prisma } from "@/lib/prisma";
import {
  recordMemberAvailability,
  setMemberContactPreference,
  AvailabilityInputError,
  ContactPreferenceDestinationError,
} from "@/lib/domain/availability";
import {
  recordInvitationResponse,
  CalloutClosedError,
  CalloutTokenInvalidError,
} from "@/lib/domain/callouts";
import {
  availabilityUpdateSchema,
  calloutResponseSchema,
  contactPreferenceSchema,
} from "@/lib/domain/schemas";

import type { ActionState } from "../admin/actions";

/**
 * Member self-service server actions (issue #12).
 *
 * The memberId arriving from the form is an UNTRUSTED SELECTOR — it
 * only narrows which of the caller's own linked member records is being
 * updated. `resolveOwnMember` intersects it with
 * linkedMembersWithAccess(ctx): the member must both link to this
 * identity AND sit in an organization the identity currently has
 * OrganizationAccess for. Submitting another member's id — same org or
 * foreign — produces the same opaque "Not found." (no existence leak,
 * no IDOR path).
 */

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

function mapError(error: unknown): ActionState {
  if (
    error instanceof AuthorizationError ||
    error instanceof AuthenticationError
  ) {
    return { message: "Not found." };
  }
  if (
    error instanceof AvailabilityInputError ||
    error instanceof ContactPreferenceDestinationError
  ) {
    return { message: error.message };
  }
  if (error instanceof CalloutTokenInvalidError) {
    // The invitation vanished between lookup and write — opaque.
    return { message: "Not found." };
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2025") {
      return { message: "Record not found. It may have been removed." };
    }
  }
  throw error;
}

/**
 * The caller's own linked member record matching the supplied id, or an
 * opaque denial. A Member link without current OrganizationAccess — and
 * an access grant without a member link — each grant nothing.
 */
function resolveOwnMember(ctx: AuthContext, memberId: string) {
  const member = linkedMembersWithAccess(ctx).find((m) => m.id === memberId);
  if (!member) {
    throw new AuthorizationError();
  }
  return member;
}

export async function updateMyAvailabilityAction(
  memberId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let ctx: AuthContext;
  let member;
  try {
    ctx = await getAuthContextOrThrow();
    member = resolveOwnMember(ctx, memberId);
  } catch (error) {
    return mapError(error);
  }

  const parsed = availabilityUpdateSchema.safeParse({
    status: formData.get("status"),
    until: formData.get("until"),
    note: formData.get("note"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await recordMemberAvailability(member.id, parsed.data, ctx.identity.id, {
      selfReported: true,
    });
  } catch (error) {
    return mapError(error);
  }
  revalidatePath("/account");
  return {};
}

export async function updateMyContactPreferencesAction(
  memberId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let member;
  try {
    const ctx = await getAuthContextOrThrow();
    member = resolveOwnMember(ctx, memberId);
  } catch (error) {
    return mapError(error);
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
    return mapError(error);
  }
  revalidatePath("/account");
  return {};
}

/* ------------------------------------------------------------------ */
/* Callout responses (issue #14)                                       */
/*                                                                     */
/* The invitationId arriving from the form is an UNTRUSTED SELECTOR —  */
/* it only selects which invitation to look at. The response is        */
/* recorded only when the invitation's memberId is one of the caller's */
/* own linked member records in an organization they currently hold   */
/* OrganizationAccess for. Anything else is the same opaque "Not       */
/* found."                                                             */
/* ------------------------------------------------------------------ */

export async function respondToMyInvitationAction(
  invitationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let ctx: AuthContext;
  try {
    ctx = await getAuthContextOrThrow();
  } catch (error) {
    return mapError(error);
  }

  const invitation = await prisma.calloutInvitation.findUnique({
    where: { id: invitationId },
    select: { memberId: true },
  });
  const ownsInvitation =
    invitation != null &&
    linkedMembersWithAccess(ctx).some((m) => m.id === invitation.memberId);
  if (!ownsInvitation) {
    return mapError(new AuthorizationError());
  }

  const parsed = calloutResponseSchema.safeParse(formData.get("response"));
  if (!parsed.success) {
    return { message: "Choose a response." };
  }

  try {
    await recordInvitationResponse(
      invitationId,
      parsed.data,
      "ACCOUNT",
      ctx.identity.id,
    );
  } catch (error) {
    if (error instanceof CalloutClosedError) {
      return { message: error.message };
    }
    return mapError(error);
  }
  revalidatePath("/account");
  return {};
}
