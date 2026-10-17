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
  memberContactDetailsSchema,
  memberSubmissionInputSchema,
  attachmentMutationSchema,
  attachmentUploadSchema,
} from "@/lib/domain/schemas";
import { updateMemberContactDetails } from "@/lib/domain/member";
import {
  createMemberSubmission,
  SubmissionNotFoundError,
  SubmissionStateError,
  SubmissionTargetError,
} from "@/lib/domain/submissions";
import {
  finalizeAttachmentUpload,
  prepareAttachmentUpload,
  unlinkAttachment,
  uploadAttachment,
  AttachmentInputError,
  AttachmentUploadGrantError,
  CrossOrganizationAttachmentError,
  type AttachmentFileInput,
} from "@/lib/domain/attachments";
import { checkRateLimit } from "@/lib/rate-limit/rate-limit";
import { rateLimitKey } from "@/lib/rate-limit/keys";
import { getRateLimitStore } from "@/lib/rate-limit/default-store";
import { StorageConfigError, StorageError } from "@/lib/storage/provider";

import type {
  ActionState,
  DirectUploadCompletion,
  DirectUploadDeclared,
  PreparedUploadResult,
} from "../admin/actions";

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
  if (
    error instanceof SubmissionNotFoundError ||
    error instanceof CrossOrganizationAttachmentError
  ) {
    // Opaque — another member's or org's records must not leak.
    return { message: "Not found." };
  }
  if (
    error instanceof SubmissionStateError ||
    error instanceof SubmissionTargetError ||
    error instanceof AttachmentInputError ||
    error instanceof AttachmentUploadGrantError
  ) {
    // Facts about the member's own submission/files — safe to surface.
    return { message: error.message };
  }
  if (error instanceof StorageConfigError) {
    return {
      message:
        "File storage is not configured for this deployment. Contact the operator.",
    };
  }
  if (error instanceof StorageError) {
    if (error.code === "object_not_found") {
      return { message: "Not found." };
    }
    return {
      message:
        "File storage could not complete the operation. Please try again.",
    };
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

/* ------------------------------------------------------------------ */
/* Member self-service — contact details and submissions (issue #71)  */
/*                                                                     */
/* Same untrusted-selector rule as above: memberId narrows which of    */
/* the caller's own linked members is being edited. A submissionId     */
/* resolves through its memberId the same way — a submission is only   */
/* reachable when its member is one of the caller's own linked         */
/* member records. Anything else is the opaque "Not found.".           */
/* ------------------------------------------------------------------ */

/**
 * The caller's own submission, resolved through member ownership — the
 * id is an untrusted selector, never proof of access.
 */
async function resolveOwnSubmission(ctx: AuthContext, submissionId: string) {
  const submission = await prisma.memberSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, memberId: true, organizationId: true },
  });
  const owns =
    submission != null &&
    linkedMembersWithAccess(ctx).some((m) => m.id === submission.memberId);
  if (!owns) {
    throw new AuthorizationError();
  }
  return submission;
}

export async function updateMyContactDetailsAction(
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

  const parsed = memberContactDetailsSchema.safeParse({
    email: formData.get("email"),
    phone: formData.get("phone"),
    phoneRegion: formData.get("phoneRegion"),
    emergencyContactName: formData.get("emergencyContactName"),
    emergencyContactPhone: formData.get("emergencyContactPhone"),
    emergencyContactPhoneRegion: formData.get("emergencyContactPhoneRegion"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await updateMemberContactDetails(member.id, parsed.data, ctx.identity.id);
  } catch (error) {
    return mapError(error);
  }
  revalidatePath("/account");
  return {};
}

export async function createMySubmissionAction(
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

  const parsed = memberSubmissionInputSchema.safeParse({
    kind: formData.get("kind"),
    details: formData.get("details"),
    qualificationDefinitionId: formData.get("qualificationDefinitionId"),
    issuedOn: formData.get("issuedOn"),
    expiresOn: formData.get("expiresOn"),
    issuer: formData.get("issuer"),
    reference: formData.get("reference"),
    targetMemberQualificationId: formData.get("targetMemberQualificationId"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  let submission;
  try {
    submission = await createMemberSubmission(
      member,
      parsed.data,
      ctx.identity.id,
    );
  } catch (error) {
    return mapError(error);
  }
  revalidatePath("/account");
  return { submissionId: submission.id };
}

/* -------- Submission evidence uploads (member-scoped) -------- */

/** Member evidence uploads share the per-(org, actor) write budget. */
const memberAttachmentStore = getRateLimitStore();

async function checkMemberAttachmentRateLimit(
  ctx: AuthContext,
  organizationId: string,
): Promise<ActionState | null> {
  const result = await checkRateLimit(
    memberAttachmentStore,
    rateLimitKey("attachment.write", organizationId, ctx.identity.id),
    { limit: 60, windowMs: 60 * 60 * 1000 },
  );
  if (result.allowed) return null;
  return {
    message: "Too many file changes. Please wait a moment and try again.",
  };
}

/** Extract the uploaded file — browser-declared fields stay untrusted. */
async function fileFromFormData(
  formData: FormData,
): Promise<AttachmentFileInput | null> {
  const file = formData.get("file");
  if (!(file instanceof File) || (!file.name && file.size === 0)) {
    return null;
  }
  return {
    name: file.name,
    mediaType: file.type || "application/octet-stream",
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}

/**
 * Server-mediated upload onto the caller's own pending submission. The
 * domain re-resolves the target inside its transaction and rejects the
 * write once the submission has been reviewed.
 */
export async function uploadMySubmissionAttachmentAction(
  submissionId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let ctx: AuthContext;
  let submission;
  try {
    ctx = await getAuthContextOrThrow();
    submission = await resolveOwnSubmission(ctx, submissionId);
  } catch (error) {
    return mapError(error);
  }
  const limited = await checkMemberAttachmentRateLimit(
    ctx,
    submission.organizationId,
  );
  if (limited) return limited;

  const file = await fileFromFormData(formData);
  if (!file) {
    return { fieldErrors: { file: ["Choose a file to upload."] } };
  }
  const parsed = attachmentUploadSchema.safeParse({
    description: formData.get("description"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await uploadAttachment(
      { type: "MEMBER_SUBMISSION", id: submission.id },
      file,
      parsed.data,
      ctx.identity.id,
    );
  } catch (error) {
    return mapError(error);
  }
  revalidatePath("/account");
  return {};
}

/** Authorize a direct upload onto the caller's own pending submission. */
export async function prepareMySubmissionUploadAction(
  submissionId: string,
  input: DirectUploadDeclared & { reason?: string | null },
): Promise<PreparedUploadResult> {
  let ctx: AuthContext;
  let submission;
  try {
    ctx = await getAuthContextOrThrow();
    submission = await resolveOwnSubmission(ctx, submissionId);
  } catch (error) {
    return { status: "error", error: mapError(error) };
  }
  const limited = await checkMemberAttachmentRateLimit(
    ctx,
    submission.organizationId,
  );
  if (limited) return { status: "error", error: limited };

  const parsed = attachmentMutationSchema.safeParse({
    reason: input.reason,
  });
  if (!parsed.success) {
    return { status: "error", error: zodErrors(parsed.error) };
  }

  try {
    const upload = await prepareAttachmentUpload(
      { type: "MEMBER_SUBMISSION", id: submission.id },
      input,
      parsed.data,
      ctx.identity.id,
    );
    return upload ? { status: "direct", upload } : { status: "proxied" };
  } catch (error) {
    return { status: "error", error: mapError(error) };
  }
}

/** Record a completed direct upload onto the caller's own submission. */
export async function finalizeMySubmissionUploadAction(
  submissionId: string,
  completion: DirectUploadCompletion & {
    description?: string | null;
    reason?: string | null;
  },
): Promise<ActionState> {
  let ctx: AuthContext;
  let submission;
  try {
    ctx = await getAuthContextOrThrow();
    submission = await resolveOwnSubmission(ctx, submissionId);
  } catch (error) {
    return mapError(error);
  }
  const limited = await checkMemberAttachmentRateLimit(
    ctx,
    submission.organizationId,
  );
  if (limited) return limited;

  const parsed = attachmentUploadSchema.safeParse({
    description: completion.description,
    reason: completion.reason,
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await finalizeAttachmentUpload(
      { type: "MEMBER_SUBMISSION", id: submission.id },
      completion,
      completion,
      parsed.data,
      ctx.identity.id,
    );
  } catch (error) {
    return mapError(error);
  }
  revalidatePath("/account");
  return {};
}

/**
 * Remove an evidence file the caller attached to their own pending
 * submission. The tombstone + event history survive — this is unlink,
 * not destruction.
 */
export async function unlinkMySubmissionAttachmentAction(
  submissionId: string,
  attachmentId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let ctx: AuthContext;
  let submission;
  try {
    ctx = await getAuthContextOrThrow();
    submission = await resolveOwnSubmission(ctx, submissionId);
  } catch (error) {
    return mapError(error);
  }
  const limited = await checkMemberAttachmentRateLimit(
    ctx,
    submission.organizationId,
  );
  if (limited) return limited;

  const parsed = attachmentMutationSchema.safeParse({
    reason: formData.get("reason"),
  });
  if (!parsed.success) return zodErrors(parsed.error);

  try {
    await unlinkAttachment(
      { type: "MEMBER_SUBMISSION", id: submission.id },
      attachmentId,
      parsed.data,
      ctx.identity.id,
    );
  } catch (error) {
    return mapError(error);
  }
  revalidatePath("/account");
  return {};
}
