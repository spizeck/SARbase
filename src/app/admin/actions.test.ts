import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getAuthContextMock,
  redirectMock,
  memberFindUniqueMock,
  unitFindUniqueMock,
  organizationUpdateMock,
  unitCreateMock,
  unitUpdateMock,
  memberCreateMock,
  memberUpdateMock,
  memberUnitDeleteManyMock,
  memberUnitCreateManyMock,
  authIdentityFindManyMock,
  organizationAccessUpsertMock,
} = vi.hoisted(() => ({
  getAuthContextMock: vi.fn(),
  redirectMock: vi.fn(() => {
    throw new Error("NEXT_REDIRECT /login");
  }),
  memberFindUniqueMock: vi.fn(),
  unitFindUniqueMock: vi.fn(),
  organizationUpdateMock: vi.fn(),
  unitCreateMock: vi.fn(),
  unitUpdateMock: vi.fn(),
  memberCreateMock: vi.fn(),
  memberUpdateMock: vi.fn(),
  memberUnitDeleteManyMock: vi.fn(),
  memberUnitCreateManyMock: vi.fn(),
  authIdentityFindManyMock: vi.fn(),
  organizationAccessUpsertMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: {
      update: organizationUpdateMock,
    },
    unit: {
      findUnique: unitFindUniqueMock,
      create: unitCreateMock,
      update: unitUpdateMock,
    },
    member: {
      findUnique: memberFindUniqueMock,
      create: memberCreateMock,
      update: memberUpdateMock,
    },
    memberUnit: {
      deleteMany: memberUnitDeleteManyMock,
      createMany: memberUnitCreateManyMock,
    },
    authIdentity: { findMany: authIdentityFindManyMock },
    organizationAccess: { upsert: organizationAccessUpsertMock },
    $transaction: vi.fn(async (arg) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg({
        memberUnit: {
          deleteMany: memberUnitDeleteManyMock,
          createMany: memberUnitCreateManyMock,
        },
        unit: { findMany: vi.fn().mockResolvedValue([]) },
        member: { update: memberUpdateMock },
        organizationAccess: { upsert: organizationAccessUpsertMock },
      });
    }),
  },
}));

vi.mock("@/lib/auth/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/context")>()),
  getAuthContext: getAuthContextMock,
}));

import {
  createMemberAction,
  createUnitAction,
  linkIdentityToMemberAction,
  setMemberStatusAction,
  setMemberUnitsAction,
  unlinkIdentityFromMemberAction,
  updateMemberAction,
  updateOrganizationAction,
  updateUnitAction,
} from "./actions";
import type { AuthContext } from "@/lib/auth/context";

const ORG_A = "org-a";
const ORG_B = "org-b";

function actor(role: string | null, orgId = ORG_A): AuthContext {
  return {
    identity: { id: "ident-actor", status: "ACTIVE" },
    members: [],
    access: role ? [{ organizationId: orgId, role }] : [],
  } as unknown as AuthContext;
}

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("unauthenticated requests", () => {
  it("redirect to /login before any data access", async () => {
    getAuthContextMock.mockResolvedValue(null);
    await expect(
      updateOrganizationAction(ORG_A, {}, formData({ name: "X" })),
    ).rejects.toThrow("NEXT_REDIRECT /login");
    expect(organizationUpdateMock).not.toHaveBeenCalled();
    expect(memberFindUniqueMock).not.toHaveBeenCalled();
  });
});

describe("cross-organization denials (admin of A vs records of B)", () => {
  beforeEach(() => {
    getAuthContextMock.mockResolvedValue(actor("ADMIN", ORG_A));
    memberFindUniqueMock.mockImplementation(async ({ where }) =>
      where.id === "member-b"
        ? { id: "member-b", organizationId: ORG_B }
        : { id: where.id, organizationId: ORG_A },
    );
    unitFindUniqueMock.mockImplementation(async ({ where }) =>
      where.id === "unit-b"
        ? { id: "unit-b", organizationId: ORG_B }
        : { id: where.id, organizationId: ORG_A },
    );
  });

  it("cannot rename organization B", async () => {
    const result = await updateOrganizationAction(
      ORG_B,
      {},
      formData({ name: "Renamed" }),
    );
    expect(result).toEqual({ message: "Not found." });
    expect(organizationUpdateMock).not.toHaveBeenCalled();
  });

  it("cannot create or rename units in organization B", async () => {
    expect(
      await createUnitAction(ORG_B, {}, formData({ name: "Unit" })),
    ).toEqual({ message: "Not found." });
    expect(
      await updateUnitAction("unit-b", {}, formData({ name: "Unit" })),
    ).toEqual({ message: "Not found." });
    expect(unitCreateMock).not.toHaveBeenCalled();
    expect(unitUpdateMock).not.toHaveBeenCalled();
  });

  it("cannot create members in organization B", async () => {
    expect(
      await createMemberAction(ORG_B, {}, formData({ displayName: "Person" })),
    ).toEqual({ message: "Not found." });
    expect(memberCreateMock).not.toHaveBeenCalled();
  });

  it("cannot edit, toggle, or reassign organization B members", async () => {
    expect(
      await updateMemberAction(
        "member-b",
        {},
        formData({ displayName: "Person" }),
      ),
    ).toEqual({ message: "Not found." });
    expect(await setMemberUnitsAction("member-b", {}, formData({}))).toEqual({
      message: "Not found.",
    });
    await expect(setMemberStatusAction("member-b", "INACTIVE")).rejects.toThrow(
      "Not found or not permitted.",
    );
    expect(memberUpdateMock).not.toHaveBeenCalled();
    expect(memberUnitCreateManyMock).not.toHaveBeenCalled();
  });

  it("cannot link or unlink identities on organization B members", async () => {
    expect(
      await linkIdentityToMemberAction(
        "member-b",
        {},
        formData({ email: "x@example.org" }),
      ),
    ).toEqual({ message: "Not found." });
    await expect(unlinkIdentityFromMemberAction("member-b")).rejects.toThrow(
      "Not found or not permitted.",
    );
    expect(memberUpdateMock).not.toHaveBeenCalled();
  });

  it("reports an out-of-scope member identically to a missing one", async () => {
    memberFindUniqueMock.mockResolvedValueOnce(null);
    const missing = await updateMemberAction(
      "missing",
      {},
      formData({ displayName: "P" }),
    );
    const foreign = await updateMemberAction(
      "member-b",
      {},
      formData({ displayName: "P" }),
    );
    expect(missing).toEqual(foreign);
    expect(missing).toEqual({ message: "Not found." });
  });
});

describe("ordinary member role", () => {
  it("cannot administer its own organization", async () => {
    getAuthContextMock.mockResolvedValue(actor("MEMBER", ORG_A));
    memberFindUniqueMock.mockResolvedValue({
      id: "member-a",
      organizationId: ORG_A,
    });
    expect(
      await updateOrganizationAction(ORG_A, {}, formData({ name: "X" })),
    ).toEqual({ message: "Not found." });
    expect(await createUnitAction(ORG_A, {}, formData({ name: "U" }))).toEqual({
      message: "Not found.",
    });
    expect(
      await updateMemberAction("member-a", {}, formData({ displayName: "P" })),
    ).toEqual({ message: "Not found." });
    expect(organizationUpdateMock).not.toHaveBeenCalled();
    expect(unitCreateMock).not.toHaveBeenCalled();
    expect(memberUpdateMock).not.toHaveBeenCalled();
  });
});

describe("in-scope admin operations", () => {
  beforeEach(() => {
    getAuthContextMock.mockResolvedValue(actor("ADMIN", ORG_A));
    memberFindUniqueMock.mockResolvedValue({
      id: "member-a",
      organizationId: ORG_A,
    });
    unitFindUniqueMock.mockResolvedValue({
      id: "unit-a",
      organizationId: ORG_A,
    });
  });

  it("exposes no organization-creation action — ADMIN cannot be self-granted", async () => {
    // Issue #6 hardening: org creation + first ADMIN grant live only in
    // scripts/provision-admin.ts. No exported action may create an
    // Organization or write an ADMIN OrganizationAccess row.
    const actions = await import("./actions");
    expect("createOrganizationAction" in actions).toBe(false);
    for (const value of Object.values(actions)) {
      expect(typeof value).toBe("function");
    }
  });

  it("links an identity only when exactly one ACTIVE match exists", async () => {
    memberFindUniqueMock.mockResolvedValue({
      id: "member-a",
      organizationId: ORG_A,
    });
    authIdentityFindManyMock.mockResolvedValue([
      { id: "ident-target", status: "ACTIVE" },
    ]);
    memberUpdateMock.mockResolvedValue({});
    organizationAccessUpsertMock.mockResolvedValue({});

    const result = await linkIdentityToMemberAction(
      "member-a",
      {},
      formData({ email: "one@example.org" }),
    );
    expect(result).toEqual({});
    // The access row created by linking is MEMBER — never ADMIN.
    expect(organizationAccessUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ role: "MEMBER" }),
        update: {},
      }),
    );
  });

  it("refuses ambiguous email matches — no link, no access grant", async () => {
    memberFindUniqueMock.mockResolvedValue({
      id: "member-a",
      organizationId: ORG_A,
    });
    authIdentityFindManyMock.mockResolvedValue([
      { id: "ident-1", status: "ACTIVE" },
      { id: "ident-2", status: "ACTIVE" },
    ]);

    const result = await linkIdentityToMemberAction(
      "member-a",
      {},
      formData({ email: "dupe@example.org" }),
    );
    expect(result.fieldErrors?.email?.[0]).toContain("Multiple");
    expect(memberUpdateMock).not.toHaveBeenCalled();
    expect(organizationAccessUpsertMock).not.toHaveBeenCalled();
  });

  it("renames its own organization", async () => {
    organizationUpdateMock.mockResolvedValue({ id: ORG_A });
    const result = await updateOrganizationAction(
      ORG_A,
      {},
      formData({ name: "Org A" }),
    );
    expect(result).toEqual({});
    expect(organizationUpdateMock).toHaveBeenCalled();
  });
});
