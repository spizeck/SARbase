import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Database-backed tests for issue #71 member self-service — contact
 * detail auditing, submission lifecycle, and evidence attachment
 * authorization. They run only via `npm run test:db` (DATABASE_URL
 * present); storage goes through the in-memory provider. Fixture rows
 * are prefixed `sub71test-` for cleanup.
 */

import { prisma } from "@/lib/prisma";
import { InMemoryFileStorageProvider } from "@/lib/storage/memory";
import {
  requireAttachmentForAdminOrOwner,
  requireOrgAdminForMemberSubmission,
} from "@/lib/auth/authorize";
import { AuthorizationError, type AuthContext } from "@/lib/auth/context";

import {
  listEntityAttachments,
  unlinkAttachment,
  uploadAttachment,
  AttachmentInputError,
  type AttachmentFileInput,
} from "./attachments";
import { updateMember, updateMemberContactDetails } from "./member";
import {
  createMemberSubmission,
  reviewMemberSubmission,
  SubmissionDefinitionInactiveError,
  SubmissionNotFoundError,
  SubmissionReviewNoteRequiredError,
  SubmissionStateError,
  SubmissionTargetError,
} from "./submissions";
import type { MemberSubmissionInput } from "./schemas";

const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = `sub71test-${Date.now().toString(36)}-`;

let counter = 0;
function uniq(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

const PDF_FILE: AttachmentFileInput = {
  name: "certificate.pdf",
  mediaType: "application/pdf",
  bytes: new TextEncoder().encode("%PDF-1.4 synthetic test fixture"),
};

let storage: InMemoryFileStorageProvider;

let orgA: { id: string };
let orgB: { id: string };
let adminA: { id: string }; // ADMIN on orgA
let adminB: { id: string }; // ADMIN on orgB — cross-org probe
let memberIdentityA: { id: string }; // MEMBER access on orgA, linked to memberA
let memberA: { id: string; organizationId: string };
let otherMemberA: { id: string; organizationId: string };
let definitionA: { id: string };
let foreignDefinition: { id: string };

function ctxFor(
  identityId: string,
  access: { organizationId: string; role: "ADMIN" | "MEMBER" }[],
  members: { id: string; organizationId: string }[] = [],
): AuthContext {
  return {
    identity: { id: identityId } as AuthContext["identity"],
    access: access as AuthContext["access"],
    members: members as AuthContext["members"],
  };
}

const claim: MemberSubmissionInput = {
  kind: "QUALIFICATION_CLAIM",
  details: "I completed the course in June.",
  qualificationDefinitionId: undefined,
  issuedOn: new Date("2026-06-01T00:00:00Z"),
  expiresOn: new Date("2028-06-01T00:00:00Z"),
  issuer: "KNRM",
  reference: "CERT-123",
  targetMemberQualificationId: undefined,
};

async function makeClaim(
  member: { id: string; organizationId: string },
  definitionId: string,
) {
  return createMemberSubmission(
    member,
    { ...claim, qualificationDefinitionId: definitionId },
    memberIdentityA.id,
  );
}

async function cleanup() {
  // Leaf-most rows first; organization teardown removes the rest.
  const orgIds = [orgA?.id, orgB?.id].filter(Boolean) as string[];
  await prisma.memberSubmissionAttachment.deleteMany({
    where: { organizationId: { in: orgIds } },
  });
  await prisma.memberQualificationAttachment.deleteMany({
    where: { organizationId: { in: orgIds } },
  });
  await prisma.memberSubmission.deleteMany({
    where: { organizationId: { in: orgIds } },
  });
  await prisma.memberContactChange.deleteMany({
    where: { organizationId: { in: orgIds } },
  });
  await prisma.attachmentEvent.deleteMany({
    where: { attachment: { organizationId: { in: orgIds } } },
  });
  await prisma.attachment.deleteMany({
    where: { organizationId: { in: orgIds } },
  });
  await prisma.memberQualification.deleteMany({
    where: { organizationId: { in: orgIds } },
  });
  await prisma.qualificationDefinition.deleteMany({
    where: { organizationId: { in: orgIds } },
  });
  await prisma.member.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organizationAccess.deleteMany({
    where: { organizationId: { in: orgIds } },
  });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.authIdentity.deleteMany({
    where: { email: { contains: PREFIX } },
  });
}

describe.skipIf(!hasDb)("member submissions (issue #71)", () => {
  beforeAll(async () => {
    storage = new InMemoryFileStorageProvider();
    orgA = await prisma.organization.create({ data: { name: uniq("org-a") } });
    orgB = await prisma.organization.create({ data: { name: uniq("org-b") } });
    adminA = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("admin-a"),
        email: `${uniq("admin-a")}@example.test`,
      },
    });
    adminB = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("admin-b"),
        email: `${uniq("admin-b")}@example.test`,
      },
    });
    memberIdentityA = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("member-a"),
        email: `${uniq("member-a")}@example.test`,
      },
    });
    await prisma.organizationAccess.createMany({
      data: [
        { authIdentityId: adminA.id, organizationId: orgA.id, role: "ADMIN" },
        { authIdentityId: adminB.id, organizationId: orgB.id, role: "ADMIN" },
        {
          authIdentityId: memberIdentityA.id,
          organizationId: orgA.id,
          role: "MEMBER",
        },
      ],
    });
    memberA = await prisma.member.create({
      data: {
        organizationId: orgA.id,
        displayName: uniq("member-a"),
        authIdentityId: memberIdentityA.id,
      },
    });
    otherMemberA = await prisma.member.create({
      data: { organizationId: orgA.id, displayName: uniq("other-a") },
    });
    definitionA = await prisma.qualificationDefinition.create({
      data: { organizationId: orgA.id, name: uniq("def-a") },
    });
    foreignDefinition = await prisma.qualificationDefinition.create({
      data: { organizationId: orgB.id, name: uniq("def-b") },
    });
  });

  afterAll(cleanup);

  describe("createMemberSubmission", () => {
    it("stores a PENDING claim that changes no verified state", async () => {
      const submission = await makeClaim(memberA, definitionA.id);
      expect(submission.status).toBe("PENDING");
      expect(submission.organizationId).toBe(orgA.id);
      expect(submission.memberId).toBe(memberA.id);
      expect(submission.submittedByAuthIdentityId).toBe(memberIdentityA.id);
      // Nothing landed in the verified qualification table.
      expect(
        await prisma.memberQualification.count({
          where: { memberId: memberA.id },
        }),
      ).toBe(0);
    });

    it("rejects a claim naming a definition from another organization", async () => {
      await expect(makeClaim(memberA, foreignDefinition.id)).rejects.toThrow(
        SubmissionTargetError,
      );
    });

    it("rejects a claim naming an inactive definition", async () => {
      const inactive = await prisma.qualificationDefinition.create({
        data: {
          organizationId: orgA.id,
          name: uniq("def-inactive"),
          status: "INACTIVE",
        },
      });
      await expect(makeClaim(memberA, inactive.id)).rejects.toThrow(
        SubmissionTargetError,
      );
    });

    it("rejects a correction targeting another member's record", async () => {
      const foreignRecord = await prisma.memberQualification.create({
        data: {
          organizationId: orgA.id,
          memberId: otherMemberA.id,
          definitionId: definitionA.id,
        },
      });
      await expect(
        createMemberSubmission(
          memberA,
          {
            kind: "RECORD_CORRECTION",
            details: "Wrong expiry date.",
            targetMemberQualificationId: foreignRecord.id,
          },
          memberIdentityA.id,
        ),
      ).rejects.toThrow(SubmissionTargetError);
    });

    it("accepts a correction targeting the member's own record", async () => {
      const own = await prisma.memberQualification.create({
        data: {
          organizationId: orgA.id,
          memberId: memberA.id,
          definitionId: definitionA.id,
        },
      });
      const submission = await createMemberSubmission(
        memberA,
        {
          kind: "RECORD_CORRECTION",
          details: "Expiry says 2025 but the card says 2027.",
          targetMemberQualificationId: own.id,
        },
        memberIdentityA.id,
      );
      expect(submission.kind).toBe("RECORD_CORRECTION");
      expect(submission.targetMemberQualificationId).toBe(own.id);
    });
  });

  describe("reviewMemberSubmission", () => {
    it("approval creates the verified qualification and copies evidence", async () => {
      const submission = await makeClaim(memberA, definitionA.id);
      await uploadAttachment(
        { type: "MEMBER_SUBMISSION", id: submission.id },
        { ...PDF_FILE, name: uniq("evidence.pdf") },
        {},
        memberIdentityA.id,
        storage,
      );

      const reviewed = await reviewMemberSubmission(
        submission.id,
        "APPROVED",
        null,
        adminA.id,
      );
      expect(reviewed.status).toBe("APPROVED");
      expect(reviewed.reviewedByAuthIdentityId).toBe(adminA.id);
      expect(reviewed.reviewedAt).not.toBeNull();
      expect(reviewed.createdMemberQualificationId).not.toBeNull();

      const record = await prisma.memberQualification.findUniqueOrThrow({
        where: { id: reviewed.createdMemberQualificationId! },
        include: { attachments: true },
      });
      expect(record.organizationId).toBe(orgA.id);
      expect(record.memberId).toBe(memberA.id);
      expect(record.definitionId).toBe(definitionA.id);
      expect(record.issuer).toBe("KNRM");
      expect(record.reference).toBe("CERT-123");
      // The member's evidence is carried onto the verified record.
      expect(record.attachments).toHaveLength(1);
    });

    it("rejection requires a note", async () => {
      const submission = await makeClaim(memberA, definitionA.id);
      await expect(
        reviewMemberSubmission(submission.id, "REJECTED", null, adminA.id),
      ).rejects.toThrow(SubmissionReviewNoteRequiredError);
      await expect(
        reviewMemberSubmission(submission.id, "REJECTED", "  ", adminA.id),
      ).rejects.toThrow(SubmissionReviewNoteRequiredError);
      // Still PENDING — the failed reviews changed nothing.
      expect(
        (
          await prisma.memberSubmission.findUniqueOrThrow({
            where: { id: submission.id },
          })
        ).status,
      ).toBe("PENDING");
    });

    it("rejection keeps the submission, note, and reviewer", async () => {
      const submission = await makeClaim(memberA, definitionA.id);
      const reviewed = await reviewMemberSubmission(
        submission.id,
        "REJECTED",
        "The certificate is illegible — please upload a clearer copy.",
        adminA.id,
      );
      expect(reviewed.status).toBe("REJECTED");
      expect(reviewed.reviewNote).toContain("illegible");
      expect(reviewed.createdMemberQualificationId).toBeNull();
    });

    it("a reviewed submission cannot be reviewed again", async () => {
      const submission = await makeClaim(memberA, definitionA.id);
      await reviewMemberSubmission(submission.id, "APPROVED", null, adminA.id);
      await expect(
        reviewMemberSubmission(submission.id, "APPROVED", null, adminA.id),
      ).rejects.toThrow(SubmissionStateError);
      await expect(
        reviewMemberSubmission(
          submission.id,
          "REJECTED",
          "too late",
          adminA.id,
        ),
      ).rejects.toThrow(SubmissionStateError);
    });

    it("a missing submission is an opaque not-found", async () => {
      await expect(
        reviewMemberSubmission(
          "no-such-submission",
          "APPROVED",
          null,
          adminA.id,
        ),
      ).rejects.toThrow(SubmissionNotFoundError);
    });

    it("approval refuses a definition deactivated while pending", async () => {
      const submission = await makeClaim(memberA, definitionA.id);
      const baseline = await prisma.memberQualification.count({
        where: { memberId: memberA.id },
      });
      await prisma.qualificationDefinition.update({
        where: { id: definitionA.id },
        data: { status: "INACTIVE" },
      });
      try {
        await expect(
          reviewMemberSubmission(submission.id, "APPROVED", null, adminA.id),
        ).rejects.toThrow(SubmissionDefinitionInactiveError);
        // Nothing changed — still pending, no record created.
        expect(
          (
            await prisma.memberSubmission.findUniqueOrThrow({
              where: { id: submission.id },
            })
          ).status,
        ).toBe("PENDING");
        expect(
          await prisma.memberQualification.count({
            where: { memberId: memberA.id },
          }),
        ).toBe(baseline);
        // Rejection remains available so the claim is never stranded.
        const reviewed = await reviewMemberSubmission(
          submission.id,
          "REJECTED",
          "Definition retired.",
          adminA.id,
        );
        expect(reviewed.status).toBe("REJECTED");
      } finally {
        await prisma.qualificationDefinition.update({
          where: { id: definitionA.id },
          data: { status: "ACTIVE" },
        });
      }
    });
  });

  describe("evidence attachments", () => {
    it("a reviewed submission no longer accepts files or unlink", async () => {
      const submission = await makeClaim(memberA, definitionA.id);
      await reviewMemberSubmission(
        submission.id,
        "REJECTED",
        "not this time",
        adminA.id,
      );
      await expect(
        uploadAttachment(
          { type: "MEMBER_SUBMISSION", id: submission.id },
          { ...PDF_FILE, name: uniq("late.pdf") },
          {},
          memberIdentityA.id,
          storage,
        ),
      ).rejects.toThrow(AttachmentInputError);
      await expect(
        unlinkAttachment(
          { type: "MEMBER_SUBMISSION", id: submission.id },
          "any-attachment",
          {},
          memberIdentityA.id,
        ),
      ).rejects.toThrow(AttachmentInputError);
    });

    it("members can unlink evidence while the submission is pending", async () => {
      const submission = await makeClaim(memberA, definitionA.id);
      const attachment = await uploadAttachment(
        { type: "MEMBER_SUBMISSION", id: submission.id },
        { ...PDF_FILE, name: uniq("retract.pdf") },
        {},
        memberIdentityA.id,
        storage,
      );
      const result = await unlinkAttachment(
        { type: "MEMBER_SUBMISSION", id: submission.id },
        attachment.id,
        {},
        memberIdentityA.id,
      );
      expect(result.unlinked).toBe(true);
      expect(
        await listEntityAttachments("MEMBER_SUBMISSION", submission.id),
      ).toHaveLength(0);
      // The tombstone survives — history, not destruction.
      expect(
        (
          await prisma.attachment.findUniqueOrThrow({
            where: { id: attachment.id },
          })
        ).status,
      ).toBe("ACTIVE");
    });
  });

  describe("authorization", () => {
    it("admins of the submission's org can resolve it", async () => {
      const submission = await makeClaim(memberA, definitionA.id);
      const ctx = ctxFor(adminA.id, [
        { organizationId: orgA.id, role: "ADMIN" },
      ]);
      const resolved = await requireOrgAdminForMemberSubmission(
        ctx,
        submission.id,
      );
      expect(resolved.id).toBe(submission.id);
    });

    it("a foreign-org admin is denied the submission", async () => {
      const submission = await makeClaim(memberA, definitionA.id);
      const ctx = ctxFor(adminB.id, [
        { organizationId: orgB.id, role: "ADMIN" },
      ]);
      await expect(
        requireOrgAdminForMemberSubmission(ctx, submission.id),
      ).rejects.toThrow(AuthorizationError);
    });

    it("a plain member cannot resolve the review queue", async () => {
      const submission = await makeClaim(memberA, definitionA.id);
      const ctx = ctxFor(memberIdentityA.id, [
        { organizationId: orgA.id, role: "MEMBER" },
      ]);
      await expect(
        requireOrgAdminForMemberSubmission(ctx, submission.id),
      ).rejects.toThrow(AuthorizationError);
    });

    it("the owning member can fetch their own submission attachment", async () => {
      const submission = await makeClaim(memberA, definitionA.id);
      const attachment = await uploadAttachment(
        { type: "MEMBER_SUBMISSION", id: submission.id },
        { ...PDF_FILE, name: uniq("mine.pdf") },
        {},
        memberIdentityA.id,
        storage,
      );
      const ctx = ctxFor(
        memberIdentityA.id,
        [{ organizationId: orgA.id, role: "MEMBER" }],
        [{ id: memberA.id, organizationId: orgA.id }],
      );
      const resolved = await requireAttachmentForAdminOrOwner(
        ctx,
        attachment.id,
      );
      expect(resolved.id).toBe(attachment.id);
    });

    it("another member of the same org cannot fetch the evidence", async () => {
      const submission = await makeClaim(memberA, definitionA.id);
      const attachment = await uploadAttachment(
        { type: "MEMBER_SUBMISSION", id: submission.id },
        { ...PDF_FILE, name: uniq("not-mine.pdf") },
        {},
        memberIdentityA.id,
        storage,
      );
      const strangerIdentity = await prisma.authIdentity.create({
        data: {
          provider: "test",
          providerUid: uniq("stranger"),
          email: `${uniq("stranger")}@example.test`,
        },
      });
      const ctx = ctxFor(
        strangerIdentity.id,
        [{ organizationId: orgA.id, role: "MEMBER" }],
        [{ id: otherMemberA.id, organizationId: orgA.id }],
      );
      await expect(
        requireAttachmentForAdminOrOwner(ctx, attachment.id),
      ).rejects.toThrow(AuthorizationError);
    });

    it("a member whose access was revoked loses download scope", async () => {
      const submission = await makeClaim(memberA, definitionA.id);
      const attachment = await uploadAttachment(
        { type: "MEMBER_SUBMISSION", id: submission.id },
        { ...PDF_FILE, name: uniq("revoked.pdf") },
        {},
        memberIdentityA.id,
        storage,
      );
      // No access row → linked member grants nothing.
      const ctx = ctxFor(
        memberIdentityA.id,
        [],
        [{ id: memberA.id, organizationId: orgA.id }],
      );
      await expect(
        requireAttachmentForAdminOrOwner(ctx, attachment.id),
      ).rejects.toThrow(AuthorizationError);
    });
  });

  describe("contact detail changes", () => {
    it("self-service writes audit one row per changed field", async () => {
      await updateMemberContactDetails(
        memberA.id,
        {
          email: "new-self@example.test",
          phone: undefined,
          phoneRegion: undefined,
          emergencyContactName: "Sam Shore",
          emergencyContactPhone: undefined,
          emergencyContactPhoneRegion: undefined,
        },
        memberIdentityA.id,
      );
      const changes = await prisma.memberContactChange.findMany({
        where: { memberId: memberA.id },
        orderBy: { createdAt: "asc" },
      });
      expect(changes).toHaveLength(2);
      const fields = changes.map((c) => c.field).sort();
      expect(fields).toEqual(["email", "emergencyContactName"]);
      for (const change of changes) {
        expect(change.selfReported).toBe(true);
        expect(change.actorAuthIdentityId).toBe(memberIdentityA.id);
        expect(change.organizationId).toBe(orgA.id);
      }
    });

    it("a write that changes nothing records no audit rows", async () => {
      const member = await prisma.member.findUniqueOrThrow({
        where: { id: memberA.id },
      });
      await updateMemberContactDetails(
        memberA.id,
        {
          email: member.email ?? undefined,
          phone: member.phone ?? undefined,
          emergencyContactName: member.emergencyContactName ?? undefined,
          emergencyContactPhone: member.emergencyContactPhone ?? undefined,
        },
        memberIdentityA.id,
      );
      // Rows from the previous test only — nothing new appended.
      expect(
        await prisma.memberContactChange.count({
          where: { memberId: memberA.id },
        }),
      ).toBe(2);
    });

    it("admin edits through updateMember are audited as not self-reported", async () => {
      const member = await prisma.member.create({
        data: {
          organizationId: orgA.id,
          displayName: uniq("admin-edited"),
        },
      });
      await updateMember(
        member.id,
        {
          displayName: member.displayName,
          email: "admin-set@example.test",
        },
        { actorAuthIdentityId: adminA.id, selfReported: false },
      );
      const change = await prisma.memberContactChange.findFirstOrThrow({
        where: { memberId: member.id, field: "email" },
      });
      expect(change.selfReported).toBe(false);
      expect(change.newValue).toBe("admin-set@example.test");
      expect(change.actorAuthIdentityId).toBe(adminA.id);
    });

    it("phone input is normalized to E.164 before storage and audit", async () => {
      const member = await prisma.member.create({
        data: { organizationId: orgA.id, displayName: uniq("phone") },
      });
      await updateMemberContactDetails(
        member.id,
        {
          phone: "06 1234 5678",
          phoneRegion: "NL",
        },
        memberIdentityA.id,
      );
      const updated = await prisma.member.findUniqueOrThrow({
        where: { id: member.id },
      });
      expect(updated.phone).toMatch(/^\+31/);
      const change = await prisma.memberContactChange.findFirstOrThrow({
        where: { memberId: member.id, field: "phone" },
      });
      expect(change.newValue).toBe(updated.phone);
    });
  });
});
