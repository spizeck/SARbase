import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Database-backed authorization tests — run only via `npm run test:db`.
 *
 * These are the issue #6 IDOR / horizontal-privilege-escalation proofs:
 * a REAL database, REAL domain functions, REAL server actions and REAL
 * context resolution — with only the two external seams stubbed:
 *
 * - next/headers cookies(): injects the session cookie
 * - lib/auth/session verifySessionCookie(): stands in for Firebase
 *   verification, returning a chosen provider uid (or null)
 *
 * Everything downstream — AuthIdentity lookup, OrganizationAccess rows,
 * record→org resolution, denials — runs against real code and data.
 *
 * Fixture rows are prefixed `authztest-` for cleanup.
 */

const { cookieValueMock, verifySessionCookieMock, redirectMock, notFoundMock } =
  vi.hoisted(() => ({
    cookieValueMock: vi.fn<() => string | undefined>(),
    verifySessionCookieMock: vi.fn(),
    redirectMock: vi.fn((url: string) => {
      throw new Error(`NEXT_REDIRECT ${url}`);
    }),
    notFoundMock: vi.fn(() => {
      throw new Error("NEXT_NOT_FOUND");
    }),
  }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "sarbase_session" && cookieValueMock()
        ? { value: cookieValueMock() }
        : undefined,
  }),
}));

vi.mock("./session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session")>()),
  verifySessionCookie: verifySessionCookieMock,
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
  notFound: notFoundMock,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { getAuthContext } from "@/lib/auth/context";
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
} from "@/app/admin/actions";

const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "authztest-";

let counter = 0;
function uniq(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

/** Point the verified session at a Firebase uid; null = signed out. */
function signInAs(uid: string | null) {
  if (uid === null) {
    cookieValueMock.mockReturnValue(undefined);
  } else {
    cookieValueMock.mockReturnValue("session-cookie");
    verifySessionCookieMock.mockResolvedValue({ sub: uid });
  }
}

function form(fields: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) fd.append(key, v);
  }
  return fd;
}

// Fixture handles, populated in beforeAll.
let orgA: { id: string };
let orgB: { id: string };
let unitA: { id: string };
let unitB: { id: string };
let memberA: { id: string };
let memberB: { id: string };
let adminAUid: string;
let adminBUid: string;
let memberRoleUid: string;
let noAccessUid: string;

describe.skipIf(!hasDb)("organization-scoped authorization", () => {
  beforeAll(async () => {
    orgA = await prisma.organization.create({ data: { name: uniq("org-a") } });
    orgB = await prisma.organization.create({ data: { name: uniq("org-b") } });
    unitA = await prisma.unit.create({
      data: { organizationId: orgA.id, name: uniq("unit-a") },
    });
    unitB = await prisma.unit.create({
      data: { organizationId: orgB.id, name: uniq("unit-b") },
    });
    memberA = await prisma.member.create({
      data: { organizationId: orgA.id, displayName: uniq("member-a") },
    });
    memberB = await prisma.member.create({
      data: { organizationId: orgB.id, displayName: uniq("member-b") },
    });

    adminAUid = uniq("uid-admin-a");
    adminBUid = uniq("uid-admin-b");
    memberRoleUid = uniq("uid-member-a");
    noAccessUid = uniq("uid-none");

    const [adminA, adminB, memberRole, noAccess] = await Promise.all(
      [adminAUid, adminBUid, memberRoleUid, noAccessUid].map((uid, i) =>
        prisma.authIdentity.create({
          data: {
            provider: "firebase",
            providerUid: uid,
            email: `${uniq("ident")}@example.org`,
            status: i === 3 ? "ACTIVE" : "ACTIVE",
          },
        }),
      ),
    );

    await prisma.organizationAccess.createMany({
      data: [
        { authIdentityId: adminA!.id, organizationId: orgA.id, role: "ADMIN" },
        { authIdentityId: adminB!.id, organizationId: orgB.id, role: "ADMIN" },
        {
          authIdentityId: memberRole!.id,
          organizationId: orgA.id,
          role: "MEMBER",
        },
      ],
    });
    void noAccess;
  });

  afterAll(async () => {
    await prisma.member.updateMany({
      where: { displayName: { startsWith: PREFIX } },
      data: { authIdentityId: null },
    });
    await prisma.organizationAccess.deleteMany({
      where: { authIdentity: { providerUid: { startsWith: PREFIX } } },
    });
    await prisma.authIdentity.deleteMany({
      where: { providerUid: { startsWith: PREFIX } },
    });
    await prisma.memberUnit.deleteMany({
      where: { member: { organization: { name: { startsWith: PREFIX } } } },
    });
    await prisma.member.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.unit.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  describe("authentication resolution", () => {
    it("rejects unauthenticated requests at the first action call", async () => {
      signInAs(null);
      await expect(
        updateOrganizationAction(orgA.id, {}, form({ name: "X" })),
      ).rejects.toThrow("NEXT_REDIRECT /login");
    });

    it("resolves a verified session to the right org-scoped context", async () => {
      signInAs(adminAUid);
      const ctx = await getAuthContext();
      expect(ctx?.access).toEqual([
        expect.objectContaining({ organizationId: orgA.id, role: "ADMIN" }),
      ]);
    });

    it("returns null for an authenticated user with no identity row", async () => {
      signInAs(uniq("uid-unknown"));
      await expect(getAuthContext()).resolves.toBeNull();
    });

    it("fails closed for a DISABLED identity", async () => {
      const uid = uniq("uid-disabled");
      await prisma.authIdentity.create({
        data: { provider: "firebase", providerUid: uid, status: "DISABLED" },
      });
      signInAs(uid);
      await expect(getAuthContext()).resolves.toBeNull();
    });
  });

  describe("admin of A vs organization B — IDOR proofs", () => {
    it("cannot rename organization B", async () => {
      signInAs(adminAUid);
      const result = await updateOrganizationAction(
        orgB.id,
        {},
        form({ name: uniq("hijack") }),
      );
      expect(result).toEqual({ message: "Not found." });
      const stillB = await prisma.organization.findUnique({
        where: { id: orgB.id },
      });
      expect(stillB?.name.startsWith("hijack")).toBe(false);
    });

    it("cannot create or rename units in organization B", async () => {
      signInAs(adminAUid);
      expect(
        await createUnitAction(orgB.id, {}, form({ name: uniq("u") })),
      ).toEqual({ message: "Not found." });
      expect(
        await updateUnitAction(unitB.id, {}, form({ name: uniq("u") })),
      ).toEqual({ message: "Not found." });
    });

    it("cannot create members in organization B", async () => {
      signInAs(adminAUid);
      expect(
        await createMemberAction(orgB.id, {}, form({ displayName: uniq("m") })),
      ).toEqual({ message: "Not found." });
    });

    it("cannot edit, deactivate, or reassign organization B members", async () => {
      signInAs(adminAUid);
      expect(
        await updateMemberAction(
          memberB.id,
          {},
          form({ displayName: uniq("edited") }),
        ),
      ).toEqual({ message: "Not found." });
      await expect(
        setMemberStatusAction(memberB.id, "INACTIVE"),
      ).rejects.toThrow("Not found or not permitted.");
      expect(
        await setMemberUnitsAction(
          memberB.id,
          {},
          form({ unitIds: [unitB.id] }),
        ),
      ).toEqual({ message: "Not found." });

      const unchanged = await prisma.member.findUnique({
        where: { id: memberB.id },
      });
      expect(unchanged?.status).toBe("ACTIVE");
      expect(unchanged?.displayName.startsWith("edited")).toBe(false);
    });

    it("treats out-of-scope and nonexistent member ids identically", async () => {
      signInAs(adminAUid);
      const missing = await updateMemberAction(
        "nonexistent-id",
        {},
        form({ displayName: "x" }),
      );
      const foreign = await updateMemberAction(
        memberB.id,
        {},
        form({ displayName: "x" }),
      );
      expect(missing).toEqual({ message: "Not found." });
      expect(missing).toEqual(foreign);
    });

    it("cannot link or unlink identities on organization B members", async () => {
      signInAs(adminAUid);
      expect(
        await linkIdentityToMemberAction(
          memberB.id,
          {},
          form({ email: "any@example.org" }),
        ),
      ).toEqual({ message: "Not found." });
      await expect(unlinkIdentityFromMemberAction(memberB.id)).rejects.toThrow(
        "Not found or not permitted.",
      );
    });
  });

  describe("ordinary member role", () => {
    it("cannot administer its own organization via any action", async () => {
      signInAs(memberRoleUid);
      expect(
        await updateOrganizationAction(orgA.id, {}, form({ name: "X" })),
      ).toEqual({ message: "Not found." });
      expect(await createUnitAction(orgA.id, {}, form({ name: "U" }))).toEqual({
        message: "Not found.",
      });
      expect(
        await updateMemberAction(memberA.id, {}, form({ displayName: "P" })),
      ).toEqual({ message: "Not found." });
    });
  });

  describe("in-scope administration works", () => {
    it("admin of A manages org A end to end", async () => {
      signInAs(adminAUid);
      expect(
        await updateOrganizationAction(
          orgA.id,
          {},
          form({ name: uniq("renamed") }),
        ),
      ).toEqual({});
      expect(
        await createUnitAction(orgA.id, {}, form({ name: uniq("unit") })),
      ).toEqual({});
      expect(
        await updateUnitAction(unitA.id, {}, form({ name: uniq("unit-a2") })),
      ).toEqual({});
      expect(
        await updateMemberAction(
          memberA.id,
          {},
          form({ displayName: uniq("edited-a"), email: "", phone: "" }),
        ),
      ).toEqual({});
      await setMemberStatusAction(memberA.id, "INACTIVE");
      expect(
        (await prisma.member.findUnique({ where: { id: memberA.id } }))?.status,
      ).toBe("INACTIVE");
      await setMemberStatusAction(memberA.id, "ACTIVE");
      expect(
        await setMemberUnitsAction(
          memberA.id,
          {},
          form({ unitIds: [unitA.id] }),
        ),
      ).toEqual({});
    });
  });

  describe("account ↔ member linking", () => {
    it("links an existing identity to a member and creates MEMBER access", async () => {
      signInAs(adminAUid);
      const uid = uniq("uid-linked");
      const identity = await prisma.authIdentity.create({
        data: {
          provider: "firebase",
          providerUid: uid,
          email: uniq("linked") + "@example.org",
        },
      });
      const member = await prisma.member.create({
        data: { organizationId: orgA.id, displayName: uniq("linked") },
      });

      const result = await linkIdentityToMemberAction(
        member.id,
        {},
        form({ email: identity.email! }),
      );
      expect(result).toEqual({});

      const linked = await prisma.member.findUnique({
        where: { id: member.id },
      });
      expect(linked?.authIdentityId).toBe(identity.id);
      const access = await prisma.organizationAccess.findUnique({
        where: {
          authIdentityId_organizationId: {
            authIdentityId: identity.id,
            organizationId: orgA.id,
          },
        },
      });
      expect(access?.role).toBe("MEMBER");

      // The linked identity now resolves member context at login.
      signInAs(uid);
      const ctx = await getAuthContext();
      expect(ctx?.members.map((m) => m.id)).toContain(member.id);
      expect(ctx?.access[0]?.role).toBe("MEMBER");
    });

    it("refuses to link an unknown email", async () => {
      signInAs(adminAUid);
      const member = await prisma.member.create({
        data: { organizationId: orgA.id, displayName: uniq("unlinked") },
      });
      const result = await linkIdentityToMemberAction(
        member.id,
        {},
        form({ email: uniq("nobody") + "@example.org" }),
      );
      expect(result.fieldErrors?.email?.[0]).toContain("No active sign-in");
      const stillUnlinked = await prisma.member.findUnique({
        where: { id: member.id },
      });
      expect(stillUnlinked?.authIdentityId).toBeNull();
    });

    it("refuses an ambiguous email — no member link, no access grant", async () => {
      signInAs(adminAUid);
      // Two ACTIVE identities sharing one email: email is a lookup
      // convenience, never an authoritative identity key.
      const email = uniq("dupe") + "@example.org";
      const dupe1 = await prisma.authIdentity.create({
        data: { provider: "firebase", providerUid: uniq("dupe-1"), email },
      });
      const dupe2 = await prisma.authIdentity.create({
        data: { provider: "firebase", providerUid: uniq("dupe-2"), email },
      });
      const member = await prisma.member.create({
        data: { organizationId: orgA.id, displayName: uniq("ambig") },
      });

      const result = await linkIdentityToMemberAction(
        member.id,
        {},
        form({ email }),
      );
      expect(result.fieldErrors?.email?.[0]).toContain("Multiple");

      // Nothing was written: no link, no OrganizationAccess grant.
      const stillUnlinked = await prisma.member.findUnique({
        where: { id: member.id },
      });
      expect(stillUnlinked?.authIdentityId).toBeNull();
      expect(
        await prisma.organizationAccess.count({
          where: {
            organizationId: orgA.id,
            authIdentityId: { in: [dupe1.id, dupe2.id] },
          },
        }),
      ).toBe(0);
    });

    it("ignores DISABLED identities when resolving by email", async () => {
      signInAs(adminAUid);
      const email = uniq("disabled-dupe") + "@example.org";
      await prisma.authIdentity.create({
        data: {
          provider: "firebase",
          providerUid: uniq("disabled"),
          email,
          status: "DISABLED",
        },
      });
      const active = await prisma.authIdentity.create({
        data: {
          provider: "firebase",
          providerUid: uniq("active"),
          email,
          status: "ACTIVE",
        },
      });
      const member = await prisma.member.create({
        data: { organizationId: orgA.id, displayName: uniq("disambig") },
      });
      const result = await linkIdentityToMemberAction(
        member.id,
        {},
        form({ email }),
      );
      expect(result).toEqual({});
      const linked = await prisma.member.findUnique({
        where: { id: member.id },
      });
      expect(linked?.authIdentityId).toBe(active.id);
    });
  });

  describe("one linked member per organization per identity", () => {
    it("allows cross-org links, rejects a second link in the same org, allows unlinked", async () => {
      const identity = await prisma.authIdentity.create({
        data: { provider: "firebase", providerUid: uniq("uid-multi") },
      });

      // Identity → member in org A: allowed.
      const inA = await prisma.member.create({
        data: {
          organizationId: orgA.id,
          displayName: uniq("multi-a"),
          authIdentityId: identity.id,
        },
      });
      expect(inA.authIdentityId).toBe(identity.id);

      // Identity → member in org B: allowed (same human, other org).
      const inB = await prisma.member.create({
        data: {
          organizationId: orgB.id,
          displayName: uniq("multi-b"),
          authIdentityId: identity.id,
        },
      });
      expect(inB.authIdentityId).toBe(identity.id);

      // Identity → a SECOND member in org A: rejected by the
      // (organizationId, authIdentityId) unique constraint.
      await expect(
        prisma.member.create({
          data: {
            organizationId: orgA.id,
            displayName: uniq("multi-a2"),
            authIdentityId: identity.id,
          },
        }),
      ).rejects.toThrow();

      // Any number of UNLINKED members in org A coexist — NULL
      // authIdentityId values are distinct under the constraint.
      const u1 = await prisma.member.create({
        data: { organizationId: orgA.id, displayName: uniq("unlinked-1") },
      });
      const u2 = await prisma.member.create({
        data: { organizationId: orgA.id, displayName: uniq("unlinked-2") },
      });
      expect(u1.authIdentityId).toBeNull();
      expect(u2.authIdentityId).toBeNull();
    });

    it("the application surfaces the constraint as an error, not a silent overwrite", async () => {
      signInAs(adminAUid);
      const identity = await prisma.authIdentity.create({
        data: {
          provider: "firebase",
          providerUid: uniq("uid-collision"),
          email: uniq("collision") + "@example.org",
        },
      });
      await prisma.member.create({
        data: {
          organizationId: orgA.id,
          displayName: uniq("first"),
          authIdentityId: identity.id,
        },
      });
      const second = await prisma.member.create({
        data: { organizationId: orgA.id, displayName: uniq("second") },
      });
      const result = await linkIdentityToMemberAction(
        second.id,
        {},
        form({ email: identity.email! }),
      );
      expect(result.fieldErrors?.email?.[0]).toContain("already linked");
      const unchanged = await prisma.member.findUnique({
        where: { id: second.id },
      });
      expect(unchanged?.authIdentityId).toBeNull();
    });
  });

  describe("schema constraints", () => {
    it("enforces (provider, providerUid) uniqueness", async () => {
      const uid = uniq("uid-dupe");
      await prisma.authIdentity.create({
        data: { provider: "firebase", providerUid: uid },
      });
      await expect(
        prisma.authIdentity.create({
          data: { provider: "firebase", providerUid: uid },
        }),
      ).rejects.toThrow();
      // Same uid under a different provider is legal.
      await expect(
        prisma.authIdentity.create({
          data: { provider: "other", providerUid: uid },
        }),
      ).resolves.toBeTruthy();
    });

    it("enforces one access row per (identity, organization)", async () => {
      const uid = uniq("uid-access");
      const identity = await prisma.authIdentity.create({
        data: { provider: "firebase", providerUid: uid },
      });
      await prisma.organizationAccess.create({
        data: {
          authIdentityId: identity.id,
          organizationId: orgA.id,
          role: "MEMBER",
        },
      });
      await expect(
        prisma.organizationAccess.create({
          data: {
            authIdentityId: identity.id,
            organizationId: orgA.id,
            role: "ADMIN",
          },
        }),
      ).rejects.toThrow();
    });

    it("deleting an identity preserves member records (SetNull) and removes access", async () => {
      const uid = uniq("uid-delete");
      const identity = await prisma.authIdentity.create({
        data: { provider: "firebase", providerUid: uid },
      });
      const member = await prisma.member.create({
        data: {
          organizationId: orgA.id,
          displayName: uniq("preserve-me"),
          authIdentityId: identity.id,
        },
      });
      await prisma.organizationAccess.create({
        data: {
          authIdentityId: identity.id,
          organizationId: orgA.id,
          role: "MEMBER",
        },
      });

      await prisma.authIdentity.delete({ where: { id: identity.id } });

      const preserved = await prisma.member.findUnique({
        where: { id: member.id },
      });
      expect(preserved).toBeTruthy();
      expect(preserved?.authIdentityId).toBeNull();
      expect(
        await prisma.organizationAccess.count({
          where: { authIdentityId: identity.id },
        }),
      ).toBe(0);
    });

    it("restricts deleting an organization that still has access rows", async () => {
      const org = await prisma.organization.create({
        data: { name: uniq("org-restrict") },
      });
      const identity = await prisma.authIdentity.create({
        data: { provider: "firebase", providerUid: uniq("uid-restrict") },
      });
      await prisma.organizationAccess.create({
        data: {
          authIdentityId: identity.id,
          organizationId: org.id,
          role: "MEMBER",
        },
      });
      await expect(
        prisma.organization.delete({ where: { id: org.id } }),
      ).rejects.toThrow();
      await prisma.organizationAccess.deleteMany({
        where: { organizationId: org.id },
      });
      await prisma.organization.delete({ where: { id: org.id } });
    });
  });
});
