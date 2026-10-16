import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for member self-service actions (issue #71). The domain
 * layer is exercised for real over a mocked prisma — the point under
 * test is the ACTION-side rule: a client-supplied memberId/submissionId
 * is only a selector; ownership is proven by intersecting it with the
 * caller's own linked members + current access grants.
 */

const {
  getAuthContextMock,
  memberFindUniqueOrThrowMock,
  memberUpdateMock,
  memberContactChangeCreateManyMock,
  memberSubmissionFindUniqueMock,
  memberSubmissionCreateMock,
  qualificationDefinitionFindFirstMock,
  memberQualificationFindFirstMock,
} = vi.hoisted(() => ({
  getAuthContextMock: vi.fn(),
  memberFindUniqueOrThrowMock: vi.fn(),
  memberUpdateMock: vi.fn(),
  memberContactChangeCreateManyMock: vi.fn(),
  memberSubmissionFindUniqueMock: vi.fn(),
  memberSubmissionCreateMock: vi.fn(),
  qualificationDefinitionFindFirstMock: vi.fn(),
  memberQualificationFindFirstMock: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    memberSubmission: { findUnique: memberSubmissionFindUniqueMock },
    $transaction: vi.fn(async (arg) =>
      arg({
        member: {
          findUniqueOrThrow: memberFindUniqueOrThrowMock,
          update: memberUpdateMock,
        },
        memberContactChange: {
          createMany: memberContactChangeCreateManyMock,
        },
        memberSubmission: { create: memberSubmissionCreateMock },
        qualificationDefinition: {
          findFirst: qualificationDefinitionFindFirstMock,
        },
        memberQualification: { findFirst: memberQualificationFindFirstMock },
      }),
    ),
  },
}));

vi.mock("@/lib/auth/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/context")>()),
  getAuthContext: getAuthContextMock,
}));

import {
  createMySubmissionAction,
  updateMyContactDetailsAction,
  uploadMySubmissionAttachmentAction,
} from "./actions";
import type { AuthContext } from "@/lib/auth/context";

const ORG_A = "org-a";
const ORG_B = "org-b";

/** Caller holds MEMBER access on org A and is linked to member-a. */
function memberCtx(): AuthContext {
  return {
    identity: { id: "ident-member", status: "ACTIVE" },
    access: [{ organizationId: ORG_A, role: "MEMBER" }],
    members: [
      { id: "member-a", organizationId: ORG_A },
      // Linked to a member in org B, but holds NO access grant there —
      // a link alone grants nothing.
      { id: "member-b", organizationId: ORG_B },
    ],
  } as unknown as AuthContext;
}

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContextMock.mockResolvedValue(memberCtx());
});

describe("updateMyContactDetailsAction", () => {
  it("rejects an unlinked member id identically to a foreign one", async () => {
    for (const memberId of ["member-b", "member-foreign", "missing"]) {
      const result = await updateMyContactDetailsAction(
        memberId,
        {},
        formData({ email: "me@example.test" }),
      );
      expect(result).toEqual({ message: "Not found." });
    }
    expect(memberUpdateMock).not.toHaveBeenCalled();
  });

  it("writes permitted fields and audits them as self-reported", async () => {
    memberFindUniqueOrThrowMock.mockResolvedValue({
      id: "member-a",
      organizationId: ORG_A,
      email: null,
      phone: null,
      emergencyContactName: null,
      emergencyContactPhone: null,
    });
    memberUpdateMock.mockResolvedValue({
      id: "member-a",
      organizationId: ORG_A,
      email: "me@example.test",
      phone: "+31612345678",
      emergencyContactName: "Sam",
      emergencyContactPhone: null,
    });
    const result = await updateMyContactDetailsAction(
      "member-a",
      {},
      formData({
        email: "me@example.test",
        phone: "06 12345678",
        phoneRegion: "NL",
        emergencyContactName: "Sam",
      }),
    );
    expect(result).toEqual({});
    expect(memberUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "member-a" },
        data: expect.objectContaining({
          email: "me@example.test",
          phone: "+31612345678",
          emergencyContactName: "Sam",
        }),
      }),
    );
    expect(memberContactChangeCreateManyMock).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          memberId: "member-a",
          field: "email",
          selfReported: true,
          actorAuthIdentityId: "ident-member",
        }),
        expect.objectContaining({
          field: "phone",
          newValue: "+31612345678",
          selfReported: true,
        }),
        expect.objectContaining({
          field: "emergencyContactName",
          newValue: "Sam",
          selfReported: true,
        }),
      ]),
    });
  });

  it("rejects an invalid phone number with a field error", async () => {
    const result = await updateMyContactDetailsAction(
      "member-a",
      {},
      formData({ phone: "1", phoneRegion: "NL" }),
    );
    expect(result.fieldErrors?.phone).toBeDefined();
    expect(memberUpdateMock).not.toHaveBeenCalled();
  });
});

describe("createMySubmissionAction", () => {
  it("rejects member ids the caller does not own", async () => {
    const result = await createMySubmissionAction(
      "member-b",
      {},
      formData({ kind: "RECORD_CORRECTION", details: "wrong date" }),
    );
    expect(result).toEqual({ message: "Not found." });
    expect(memberSubmissionCreateMock).not.toHaveBeenCalled();
  });

  it("creates a PENDING claim for the caller's own member", async () => {
    qualificationDefinitionFindFirstMock.mockResolvedValue({ id: "def-a" });
    memberSubmissionCreateMock.mockResolvedValue({ id: "sub-new" });
    const result = await createMySubmissionAction(
      "member-a",
      {},
      formData({
        kind: "QUALIFICATION_CLAIM",
        details: "Completed the coxswain course.",
        qualificationDefinitionId: "def-a",
        issuedOn: "2026-06-01",
      }),
    );
    expect(result).toEqual({ submissionId: "sub-new" });
    expect(memberSubmissionCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: ORG_A,
          memberId: "member-a",
          kind: "QUALIFICATION_CLAIM",
          submittedByAuthIdentityId: "ident-member",
        }),
      }),
    );
  });

  it("rejects a claim naming a foreign or inactive definition", async () => {
    qualificationDefinitionFindFirstMock.mockResolvedValue(null);
    const result = await createMySubmissionAction(
      "member-a",
      {},
      formData({
        kind: "QUALIFICATION_CLAIM",
        details: "Claim",
        qualificationDefinitionId: "def-foreign",
      }),
    );
    expect(result).toEqual({
      message: "The referenced record is not valid for this submission.",
    });
    expect(memberSubmissionCreateMock).not.toHaveBeenCalled();
  });
});

describe("uploadMySubmissionAttachmentAction", () => {
  const fd = () => {
    const data = formData({ description: "cert scan" });
    data.set(
      "file",
      new File(["%PDF-1.4 fixture"], "cert.pdf", { type: "application/pdf" }),
    );
    return data;
  };

  it("denies a submission owned by a different member", async () => {
    memberSubmissionFindUniqueMock.mockResolvedValue({
      id: "sub-other",
      memberId: "member-b",
      organizationId: ORG_B,
    });
    const result = await uploadMySubmissionAttachmentAction(
      "sub-other",
      {},
      fd(),
    );
    expect(result).toEqual({ message: "Not found." });
  });

  it("denies a submission id that does not resolve", async () => {
    memberSubmissionFindUniqueMock.mockResolvedValue(null);
    const result = await uploadMySubmissionAttachmentAction(
      "missing",
      {},
      fd(),
    );
    expect(result).toEqual({ message: "Not found." });
  });
});
