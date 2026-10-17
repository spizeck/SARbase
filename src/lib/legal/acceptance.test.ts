import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMock, findUniqueMock, findUniqueOrThrowMock } = vi.hoisted(
  () => ({
    createMock: vi.fn(),
    findUniqueMock: vi.fn(),
    findUniqueOrThrowMock: vi.fn(),
  }),
);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    termsAcceptance: {
      create: createMock,
      findUnique: findUniqueMock,
      findUniqueOrThrow: findUniqueOrThrowMock,
    },
  },
}));

vi.mock("@/lib/logging", () => ({ log: vi.fn(), logExpected: vi.fn() }));

import { Prisma } from "@prisma/client";

import {
  hasAcceptedCurrentTerms,
  isTermsAcceptanceEnforced,
  recordTermsAcceptance,
} from "./acceptance";
import {
  PRIVACY_POLICY,
  TERMS_OF_SERVICE,
  legalDocumentHash,
} from "./documents";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.LEGAL_ACCEPTANCE_REQUIRED;
});

describe("isTermsAcceptanceEnforced", () => {
  it("is never enforced while the Terms document is a draft — even with the flag set", () => {
    // Guard rail: the current document is a draft. The flag cannot
    // make unapproved text mandatory.
    expect(TERMS_OF_SERVICE.status).toBe("draft");
    process.env.LEGAL_ACCEPTANCE_REQUIRED = "true";
    expect(isTermsAcceptanceEnforced()).toBe(false);
  });

  it("is off when the flag is unset", () => {
    expect(isTermsAcceptanceEnforced()).toBe(false);
  });
});

describe("hasAcceptedCurrentTerms", () => {
  it("queries by identity + current terms version", async () => {
    findUniqueMock.mockResolvedValue({ id: "ta-1" });
    await expect(hasAcceptedCurrentTerms("ident-1")).resolves.toBe(true);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: {
        authIdentityId_termsVersion: {
          authIdentityId: "ident-1",
          termsVersion: TERMS_OF_SERVICE.version,
        },
      },
      select: { id: true },
    });

    findUniqueMock.mockResolvedValue(null);
    await expect(hasAcceptedCurrentTerms("ident-1")).resolves.toBe(false);
  });
});

describe("recordTermsAcceptance", () => {
  it("stores version + content hash for both documents and the mechanism", async () => {
    createMock.mockResolvedValue({ id: "ta-1", termsVersion: "0.1-draft" });
    const row = await recordTermsAcceptance("ident-1");
    expect(row.id).toBe("ta-1");
    expect(createMock).toHaveBeenCalledWith({
      data: {
        authIdentityId: "ident-1",
        termsVersion: TERMS_OF_SERVICE.version,
        termsHash: legalDocumentHash(TERMS_OF_SERVICE),
        privacyVersion: PRIVACY_POLICY.version,
        privacyHash: legalDocumentHash(PRIVACY_POLICY),
        mechanism: "explicit_checkbox",
      },
    });
  });

  it("is idempotent — a duplicate submission returns the existing row", async () => {
    createMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "6.19.3",
      }),
    );
    findUniqueOrThrowMock.mockResolvedValue({ id: "ta-existing" });
    await expect(recordTermsAcceptance("ident-1")).resolves.toEqual({
      id: "ta-existing",
    });
    expect(findUniqueOrThrowMock).toHaveBeenCalledWith({
      where: {
        authIdentityId_termsVersion: {
          authIdentityId: "ident-1",
          termsVersion: TERMS_OF_SERVICE.version,
        },
      },
    });
  });

  it("rethrows non-unique failures", async () => {
    createMock.mockRejectedValue(new Error("db down"));
    await expect(recordTermsAcceptance("ident-1")).rejects.toThrow("db down");
  });
});
