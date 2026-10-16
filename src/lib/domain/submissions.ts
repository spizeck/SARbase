import type {
  Member,
  MemberSubmission,
  MemberSubmissionStatus,
  Prisma,
} from "@prisma/client";

import { log } from "@/lib/logging";
import { prisma } from "@/lib/prisma";

import type { MemberSubmissionInput } from "./schemas";

/**
 * Member self-service submissions (issue #71).
 *
 * A MemberSubmission is something a signed-in member ASKED their
 * organization to record — a qualification claim with evidence, or a
 * correction to an existing record. Submissions are inert: a PENDING
 * row changes no verified state, feeds no readiness computation, and
 * carries an explicit self-reported label. Only an org ADMIN's review
 * can move it, and approval of a qualification claim is what creates
 * the verified MemberQualification — inside the same transaction, so
 * a submission can never be marked approved without producing (or
 * failing to produce) its record.
 *
 * Authorization stays with the callers:
 * - member side: the caller resolves their OWN linked member (with a
 *   current OrganizationAccess row) before calling create — the
 *   memberId arriving here is already proven.
 * - admin side: the caller holds ADMIN on the submission's
 *   organization (resolved from the row, never the supplied org id).
 *
 * Review is serialized by a row lock (SELECT … FOR UPDATE) — two
 * concurrent reviewers cannot both approve the same submission.
 */

/** The submission does not exist in the caller's organization. */
export class SubmissionNotFoundError extends Error {
  constructor() {
    super("Not found or not permitted.");
    this.name = "SubmissionNotFoundError";
  }
}

/** The submission was already reviewed (or raced with a review). */
export class SubmissionStateError extends Error {
  constructor() {
    super("This submission has already been reviewed.");
    this.name = "SubmissionStateError";
  }
}

/** A rejected review must carry feedback for the member. */
export class SubmissionReviewNoteRequiredError extends Error {
  constructor() {
    super("A note is required when rejecting a submission.");
    this.name = "SubmissionReviewNoteRequiredError";
  }
}

/** A claim/correction named a record that is not in scope. */
export class SubmissionTargetError extends Error {
  constructor() {
    super("The referenced record is not valid for this submission.");
    this.name = "SubmissionTargetError";
  }
}

/** The claimed definition was deactivated while the submission waited. */
export class SubmissionDefinitionInactiveError extends Error {
  constructor() {
    super(
      "This qualification definition is no longer active, so the claim cannot be approved. Reject the submission instead.",
    );
    this.name = "SubmissionDefinitionInactiveError";
  }
}

export const MEMBER_SUBMISSION_STATUS_LABELS: Record<
  MemberSubmissionStatus,
  string
> = {
  PENDING: "Pending review",
  APPROVED: "Verified",
  REJECTED: "Not accepted",
};

export const MEMBER_SUBMISSION_KIND_LABELS: Record<
  MemberSubmission["kind"],
  string
> = {
  QUALIFICATION_CLAIM: "Qualification or training evidence",
  RECORD_CORRECTION: "Record correction",
};

/**
 * File a submission on behalf of a member whose ownership the caller
 * has already proven (linked member + current OrganizationAccess).
 *
 * Payload checks beyond the input schema:
 * - QUALIFICATION_CLAIM: the named definition must be an ACTIVE
 *   definition of the member's organization (the composite FK enforces
 *   it structurally; this produces the clean error).
 * - RECORD_CORRECTION: the named qualification record must belong to
 *   THIS member — a member can only flag their own records.
 */
export async function createMemberSubmission(
  member: Pick<Member, "id" | "organizationId">,
  input: MemberSubmissionInput,
  submittedByAuthIdentityId: string,
): Promise<MemberSubmission> {
  const submission = await prisma.$transaction(async (tx) => {
    if (
      input.kind === "QUALIFICATION_CLAIM" &&
      input.qualificationDefinitionId
    ) {
      const definition = await tx.qualificationDefinition.findFirst({
        where: {
          id: input.qualificationDefinitionId,
          organizationId: member.organizationId,
          status: "ACTIVE",
        },
        select: { id: true },
      });
      if (!definition) throw new SubmissionTargetError();
    }
    if (
      input.kind === "RECORD_CORRECTION" &&
      input.targetMemberQualificationId
    ) {
      const target = await tx.memberQualification.findFirst({
        where: {
          id: input.targetMemberQualificationId,
          memberId: member.id,
          organizationId: member.organizationId,
        },
        select: { id: true },
      });
      if (!target) throw new SubmissionTargetError();
    }
    return tx.memberSubmission.create({
      data: {
        organizationId: member.organizationId,
        memberId: member.id,
        kind: input.kind,
        details: input.details,
        qualificationDefinitionId:
          input.kind === "QUALIFICATION_CLAIM"
            ? (input.qualificationDefinitionId ?? null)
            : null,
        issuedOn:
          input.kind === "QUALIFICATION_CLAIM"
            ? (input.issuedOn ?? null)
            : null,
        expiresOn:
          input.kind === "QUALIFICATION_CLAIM"
            ? (input.expiresOn ?? null)
            : null,
        issuer:
          input.kind === "QUALIFICATION_CLAIM" ? (input.issuer ?? null) : null,
        reference:
          input.kind === "QUALIFICATION_CLAIM"
            ? (input.reference ?? null)
            : null,
        targetMemberQualificationId:
          input.kind === "RECORD_CORRECTION"
            ? (input.targetMemberQualificationId ?? null)
            : null,
        submittedByAuthIdentityId,
      },
    });
  });
  log({
    event: "submission.created",
    subsystem: "domain",
    entityType: "MemberSubmission",
    entityId: submission.id,
    organizationId: member.organizationId,
    actorId: submittedByAuthIdentityId,
  });
  return submission;
}

/**
 * Review a pending submission — the ONLY way a member-submitted claim
 * becomes a verified record.
 *
 * - Row is locked FOR UPDATE; a non-PENDING row (already reviewed, or
 *   racing a concurrent review) fails with SubmissionStateError, so
 *   double-approval cannot double-create the qualification.
 * - APPROVED + QUALIFICATION_CLAIM creates the verified
 *   MemberQualification from the submitted details AND copies the
 *   submission's evidence links onto the record — atomically.
 * - APPROVED + RECORD_CORRECTION acknowledges the report; applying the
 *   fix to the record itself remains an explicit admin edit.
 * - REJECTED requires a note (enforced here so no caller can skip it).
 */
export async function reviewMemberSubmission(
  submissionId: string,
  decision: "APPROVED" | "REJECTED",
  reviewNote: string | null,
  reviewedByAuthIdentityId: string,
): Promise<MemberSubmission> {
  if (decision === "REJECTED" && !reviewNote?.trim()) {
    throw new SubmissionReviewNoteRequiredError();
  }

  const reviewed = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "MemberSubmission" WHERE id = ${submissionId}
      FOR UPDATE
    `;
    if (rows.length === 0) throw new SubmissionNotFoundError();
    const submission = await tx.memberSubmission.findUniqueOrThrow({
      where: { id: submissionId },
      include: { attachments: true },
    });
    if (submission.status !== "PENDING") throw new SubmissionStateError();

    let createdMemberQualificationId: string | null = null;
    if (
      decision === "APPROVED" &&
      submission.kind === "QUALIFICATION_CLAIM" &&
      submission.qualificationDefinitionId
    ) {
      // The ACTIVE check at submission time is not enough — the
      // definition may have been deactivated while the claim waited in
      // the queue. Approval must not mint a verified record under a
      // retired definition; the reviewer rejects instead.
      const definition = await tx.qualificationDefinition.findFirst({
        where: {
          id: submission.qualificationDefinitionId,
          organizationId: submission.organizationId,
          status: "ACTIVE",
        },
        select: { id: true },
      });
      if (!definition) throw new SubmissionDefinitionInactiveError();
      const record = await tx.memberQualification.create({
        data: {
          organizationId: submission.organizationId,
          memberId: submission.memberId,
          definitionId: submission.qualificationDefinitionId,
          issuedOn: submission.issuedOn,
          expiresOn: submission.expiresOn,
          issuer: submission.issuer,
          reference: submission.reference,
          notes: submission.details,
        },
      });
      createdMemberQualificationId = record.id;
      // Carry the evidence files onto the verified record. The
      // submission keeps its links too — it remains the record of
      // exactly what the member uploaded.
      if (submission.attachments.length > 0) {
        await tx.memberQualificationAttachment.createMany({
          data: submission.attachments.map((link) => ({
            organizationId: submission.organizationId,
            memberQualificationId: record.id,
            attachmentId: link.attachmentId,
            createdByAuthIdentityId: reviewedByAuthIdentityId,
          })),
        });
      }
    }

    return tx.memberSubmission.update({
      where: { id: submissionId },
      data: {
        status: decision,
        reviewedByAuthIdentityId,
        reviewedAt: new Date(),
        reviewNote: reviewNote?.trim() || null,
        createdMemberQualificationId,
      },
    });
  });

  log({
    event: "submission.reviewed",
    subsystem: "domain",
    entityType: "MemberSubmission",
    entityId: submissionId,
    organizationId: reviewed.organizationId,
    actorId: reviewedByAuthIdentityId,
    submissionStatus: reviewed.status,
  });
  return reviewed;
}

/** A member's own submissions, newest first — account-page list. */
export function listOwnMemberSubmissions(memberId: string) {
  return prisma.memberSubmission.findMany({
    where: { memberId },
    include: {
      qualificationDefinition: { select: { name: true } },
      targetMemberQualification: {
        select: { id: true, definition: { select: { name: true } } },
      },
      attachments: { include: { attachment: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * The admin review queue: pending first, then recently reviewed.
 * Caller has verified ADMIN on the organization.
 */
export async function listOrganizationSubmissions(organizationId: string) {
  const [pending, reviewed] = await Promise.all([
    prisma.memberSubmission.findMany({
      where: { organizationId, status: "PENDING" },
      include: submissionInclude,
      orderBy: { createdAt: "asc" },
    }),
    prisma.memberSubmission.findMany({
      where: { organizationId, status: { not: "PENDING" } },
      include: submissionInclude,
      orderBy: { reviewedAt: "desc" },
      take: 25,
    }),
  ]);
  return { pending, reviewed };
}

const submissionInclude = {
  member: { select: { id: true, displayName: true } },
  qualificationDefinition: { select: { name: true } },
  targetMemberQualification: {
    select: { id: true, definition: { select: { name: true } } },
  },
  attachments: { include: { attachment: true } },
} satisfies Prisma.MemberSubmissionInclude;

/** One submission with its review context — admin queue detail. */
export function getMemberSubmission(submissionId: string) {
  return prisma.memberSubmission.findUnique({
    where: { id: submissionId },
    include: submissionInclude,
  });
}
