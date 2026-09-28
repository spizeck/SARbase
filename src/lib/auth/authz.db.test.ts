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
import { linkedMembersWithAccess } from "@/lib/auth/authorize";
import {
  createMemberAction,
  createMemberQualificationAction,
  createQualificationDefinitionAction,
  createUnitAction,
  linkIdentityToMemberAction,
  createTrainingEventAction,
  setMemberStatusAction,
  setMemberUnitsAction,
  setQualificationDefinitionStatusAction,
  setTrainingAttendanceAction,
  setTrainingEventStatusAction,
  unlinkIdentityFromMemberAction,
  updateMemberAction,
  updateTrainingEventAction,
  updateMemberQualificationAction,
  updateOrganizationAction,
  updateQualificationDefinitionAction,
  updateUnitAction,
  createStorageLocationAction,
  updateStorageLocationAction,
  createAssetAction,
  updateAssetAction,
  createInventoryItemAction,
  updateInventoryItemAction,
  createInspectionDefinitionAction,
  updateInspectionDefinitionAction,
  setInspectionDefinitionStatusAction,
  recordInspectionAction,
  updateInspectionRecordAction,
  createMaintenancePlanAction,
  recordMaintenanceAction,
  updateMaintenanceRecordAction,
  reportDefectAction,
  updateDefectAction,
  transitionDefectAction,
  createAssetMeterAction,
  recordMeterReadingAction,
} from "@/app/admin/actions";
import TrainingEventPage from "@/app/admin/training/[eventId]/page";
import AssetPage from "@/app/admin/assets/[assetId]/page";

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
let adminAIdentityId: string;
// Issue #11 fixtures — records that live in org B and must be opaque to A.
let assetA: { id: string };
let assetB: { id: string };
let inspectionDefinitionB: { id: string };
let inspectionRecordB: { id: string };
let maintenancePlanB: { id: string };
let maintenanceRecordB: { id: string };
let defectB: { id: string };
let meterB: { id: string };

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
    adminAIdentityId = adminA!.id;
    void noAccess;

    // Issue #11 fixtures in each org.
    assetA = await prisma.asset.create({
      data: { organizationId: orgA.id, name: uniq("asset-a") },
    });
    assetB = await prisma.asset.create({
      data: { organizationId: orgB.id, name: uniq("asset-b") },
    });
    inspectionDefinitionB = await prisma.inspectionDefinition.create({
      data: { organizationId: orgB.id, name: uniq("def-b") },
    });
    inspectionRecordB = await prisma.inspectionRecord.create({
      data: {
        organizationId: orgB.id,
        assetId: assetB.id,
        definitionId: inspectionDefinitionB.id,
        performedOn: new Date("2026-09-15T00:00:00.000Z"),
      },
    });
    maintenancePlanB = await prisma.maintenancePlan.create({
      data: {
        organizationId: orgB.id,
        assetId: assetB.id,
        name: uniq("plan-b"),
      },
    });
    maintenanceRecordB = await prisma.maintenanceRecord.create({
      data: {
        organizationId: orgB.id,
        assetId: assetB.id,
        planId: maintenancePlanB.id,
        title: uniq("svc-b"),
        performedOn: new Date("2026-09-15T00:00:00.000Z"),
      },
    });
    defectB = await prisma.defect.create({
      data: {
        organizationId: orgB.id,
        assetId: assetB.id,
        reportedOn: new Date("2026-09-15T00:00:00.000Z"),
        title: uniq("defect-b"),
      },
    });
    meterB = await prisma.assetMeter.create({
      data: {
        organizationId: orgB.id,
        assetId: assetB.id,
        name: uniq("meter-b"),
        unit: "hours",
      },
    });
  });

  afterAll(async () => {
    await prisma.member.updateMany({
      where: { displayName: { startsWith: PREFIX } },
      data: { authIdentityId: null },
    });
    await prisma.organizationAccess.deleteMany({
      where: { authIdentity: { providerUid: { startsWith: PREFIX } } },
    });
    // Issue #11 fixtures — readings and change rows first (they carry
    // provenance + member + identity FKs), then records, then parents.
    await prisma.assetMeterReading.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.defectChange.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.defect.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.maintenanceRecord.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.inspectionRecord.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.maintenancePlan.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.inspectionDefinition.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.assetMeter.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.authIdentity.deleteMany({
      where: { providerUid: { startsWith: PREFIX } },
    });
    await prisma.trainingAttendanceChange.deleteMany({
      where: { event: { organization: { name: { startsWith: PREFIX } } } },
    });
    await prisma.trainingAttendance.deleteMany({
      where: { member: { organization: { name: { startsWith: PREFIX } } } },
    });
    await prisma.trainingTopic.deleteMany({
      where: { event: { organization: { name: { startsWith: PREFIX } } } },
    });
    await prisma.trainingEvent.updateMany({
      where: { organization: { name: { startsWith: PREFIX } } },
      data: { leadMemberId: null },
    });
    await prisma.trainingEvent.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.memberQualification.deleteMany({
      where: { member: { organization: { name: { startsWith: PREFIX } } } },
    });
    await prisma.qualificationDefinition.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.memberUnit.deleteMany({
      where: { member: { organization: { name: { startsWith: PREFIX } } } },
    });
    await prisma.member.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    // Issue #10 fixtures — break self-referential edges before parents.
    await prisma.inventoryItem.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.asset.updateMany({
      where: { organization: { name: { startsWith: PREFIX } } },
      data: { parentAssetId: null, storageLocationId: null, unitId: null },
    });
    await prisma.asset.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.storageLocation.updateMany({
      where: { organization: { name: { startsWith: PREFIX } } },
      data: { parentLocationId: null, containingAssetId: null },
    });
    await prisma.storageLocation.deleteMany({
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

  describe("qualification administration", () => {
    let defA: { id: string };
    let defB: { id: string };
    let recordA: { id: string };
    let recordB: { id: string };

    beforeAll(async () => {
      defA = await prisma.qualificationDefinition.create({
        data: { organizationId: orgA.id, name: uniq("def-a") },
      });
      defB = await prisma.qualificationDefinition.create({
        data: { organizationId: orgB.id, name: uniq("def-b") },
      });
      recordA = await prisma.memberQualification.create({
        data: {
          organizationId: orgA.id,
          memberId: memberA.id,
          definitionId: defA.id,
        },
      });
      recordB = await prisma.memberQualification.create({
        data: {
          organizationId: orgB.id,
          memberId: memberB.id,
          definitionId: defB.id,
        },
      });
    });

    it("admin A creates, edits and deactivates definitions in A", async () => {
      signInAs(adminAUid);
      const created = await createQualificationDefinitionAction(
        orgA.id,
        {},
        form({ name: uniq("via-action") }),
      );
      expect(created).toEqual({});

      expect(
        await updateQualificationDefinitionAction(
          defA.id,
          {},
          form({ name: uniq("renamed") }),
        ),
      ).toEqual({});

      await expect(
        setQualificationDefinitionStatusAction(defA.id, "INACTIVE"),
      ).resolves.toBeUndefined();
      const after = await prisma.qualificationDefinition.findUnique({
        where: { id: defA.id },
      });
      expect(after?.status).toBe("INACTIVE");
      // Reactivate so later tests in this suite can add records under defA.
      await setQualificationDefinitionStatusAction(defA.id, "ACTIVE");
    });

    it("admin A cannot create a definition in org B by supplying its id", async () => {
      signInAs(adminAUid);
      const result = await createQualificationDefinitionAction(
        orgB.id,
        {},
        form({ name: uniq("intruder") }),
      );
      expect(result).toEqual({ message: "Not found." });
      expect(
        await prisma.qualificationDefinition.count({
          where: { organizationId: orgB.id, name: { startsWith: PREFIX } },
        }),
      ).toBe(1); // only defB, created directly
    });

    it("admin A cannot edit or deactivate a definition in org B", async () => {
      signInAs(adminAUid);
      expect(
        await updateQualificationDefinitionAction(
          defB.id,
          {},
          form({ name: "hijacked" }),
        ),
      ).toEqual({ message: "Not found." });
      await expect(
        setQualificationDefinitionStatusAction(defB.id, "INACTIVE"),
      ).rejects.toThrow("Not found or not permitted.");
      const unchanged = await prisma.qualificationDefinition.findUnique({
        where: { id: defB.id },
      });
      expect(unchanged?.status).toBe("ACTIVE");
    });

    it("admin A adds a qualification record to a member in A", async () => {
      signInAs(adminAUid);
      const result = await createMemberQualificationAction(
        memberA.id,
        {},
        form({
          definitionId: defA.id,
          issuedOn: "2026-01-15",
          expiresOn: "2028-01-15",
          issuer: "Synthetic Issuer",
          reference: "REF-1",
          notes: "",
        }),
      );
      expect(result).toEqual({});
      const saved = await prisma.memberQualification.findFirst({
        where: {
          memberId: memberA.id,
          definitionId: defA.id,
          issuer: "Synthetic Issuer",
        },
      });
      expect(saved).toBeTruthy();
    });

    it("admin A cannot add a record to a member in org B", async () => {
      signInAs(adminAUid);
      const result = await createMemberQualificationAction(
        memberB.id,
        {},
        form({ definitionId: defB.id }),
      );
      expect(result).toEqual({ message: "Not found." });
    });

    it("admin A cannot attach an org-B definition to an org-A member", async () => {
      signInAs(adminAUid);
      // defB.id is a valid-looking selector; the record's real org
      // mismatch is caught and reported opaquely.
      const result = await createMemberQualificationAction(
        memberA.id,
        {},
        form({ definitionId: defB.id }),
      );
      expect(result).toEqual({ message: "Not found." });
      expect(
        await prisma.memberQualification.count({
          where: { memberId: memberA.id, definitionId: defB.id },
        }),
      ).toBe(0);
    });

    it("admin A cannot modify a qualification record in org B by id", async () => {
      signInAs(adminAUid);
      const result = await updateMemberQualificationAction(
        recordB.id,
        {},
        form({ issuer: "Forged Issuer" }),
      );
      expect(result).toEqual({ message: "Not found." });
      const unchanged = await prisma.memberQualification.findUnique({
        where: { id: recordB.id },
      });
      expect(unchanged?.issuer).toBeNull();
    });

    it("admin B is equally fenced from org A records", async () => {
      signInAs(adminBUid);
      expect(
        await updateMemberQualificationAction(
          recordA.id,
          {},
          form({ issuer: "Forged" }),
        ),
      ).toEqual({ message: "Not found." });
    });

    it("MEMBER role cannot perform any qualification administration", async () => {
      signInAs(memberRoleUid); // MEMBER of org A
      expect(
        await createQualificationDefinitionAction(
          orgA.id,
          {},
          form({ name: uniq("member-attempt") }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await updateQualificationDefinitionAction(
          defA.id,
          {},
          form({ name: "member-attempt" }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await createMemberQualificationAction(
          memberA.id,
          {},
          form({ definitionId: defA.id }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await updateMemberQualificationAction(
          recordA.id,
          {},
          form({ issuer: "x" }),
        ),
      ).toEqual({ message: "Not found." });
    });

    it("unauthenticated qualification calls redirect to /login", async () => {
      signInAs(null);
      await expect(
        createQualificationDefinitionAction(orgA.id, {}, form({ name: "x" })),
      ).rejects.toThrow("NEXT_REDIRECT /login");
      await expect(
        updateMemberQualificationAction(recordA.id, {}, form({})),
      ).rejects.toThrow("NEXT_REDIRECT /login");
    });
  });

  describe("account access boundary", () => {
    // The /account page must expose linked member records (and their
    // qualification records) ONLY while an OrganizationAccess row exists
    // for the member's organization. Member.authIdentityId alone grants
    // nothing; stale links are hidden, not deleted.
    it("member visibility follows OrganizationAccess, not the link", async () => {
      const uid = uniq("uid-linked-a");
      const identity = await prisma.authIdentity.create({
        data: { provider: "firebase", providerUid: uid },
      });
      const member = await prisma.member.create({
        data: {
          organizationId: orgA.id,
          displayName: uniq("linked-a"),
          authIdentityId: identity.id,
        },
      });
      const def = await prisma.qualificationDefinition.create({
        data: { organizationId: orgA.id, name: uniq("def-linked") },
      });
      const record = await prisma.memberQualification.create({
        data: {
          organizationId: orgA.id,
          memberId: member.id,
          definitionId: def.id,
        },
      });

      signInAs(uid);

      // Linked but NO access row → the member and its records are hidden.
      let ctx = await getAuthContext();
      expect(ctx?.members.map((m) => m.id)).toContain(member.id);
      expect(linkedMembersWithAccess(ctx!)).toEqual([]);

      // Grant MEMBER access → member visible, qualifications resolvable.
      const grant = await prisma.organizationAccess.create({
        data: {
          authIdentityId: identity.id,
          organizationId: orgA.id,
          role: "MEMBER",
        },
      });
      ctx = await getAuthContext();
      expect(linkedMembersWithAccess(ctx!).map((m) => m.id)).toEqual([
        member.id,
      ]);
      const quals = await prisma.memberQualification.findMany({
        where: { memberId: member.id },
      });
      expect(quals.map((q) => q.id)).toEqual([record.id]);

      // Revoke access → hidden again; the Member link itself is untouched.
      await prisma.organizationAccess.delete({ where: { id: grant.id } });
      ctx = await getAuthContext();
      expect(linkedMembersWithAccess(ctx!)).toEqual([]);
      const unlinked = await prisma.member.findUnique({
        where: { id: member.id },
      });
      expect(unlinked?.authIdentityId).toBe(identity.id);

      // Restore access → visible again.
      await prisma.organizationAccess.create({
        data: {
          authIdentityId: identity.id,
          organizationId: orgA.id,
          role: "MEMBER",
        },
      });
      ctx = await getAuthContext();
      expect(linkedMembersWithAccess(ctx!).map((m) => m.id)).toEqual([
        member.id,
      ]);
    });

    it("per-organization visibility and role-independent rule", async () => {
      const uid = uniq("uid-linked-multi");
      const identity = await prisma.authIdentity.create({
        data: { provider: "firebase", providerUid: uid },
      });
      const memberInA = await prisma.member.create({
        data: {
          organizationId: orgA.id,
          displayName: uniq("multi-a"),
          authIdentityId: identity.id,
        },
      });
      const memberInB = await prisma.member.create({
        data: {
          organizationId: orgB.id,
          displayName: uniq("multi-b"),
          authIdentityId: identity.id,
        },
      });

      signInAs(uid);

      // Access only to B → only B's member record is visible.
      await prisma.organizationAccess.create({
        data: {
          authIdentityId: identity.id,
          organizationId: orgB.id,
          role: "MEMBER",
        },
      });
      let ctx = await getAuthContext();
      expect(linkedMembersWithAccess(ctx!).map((m) => m.id)).toEqual([
        memberInB.id,
      ]);
      expect(memberInA.id).toBeTruthy();

      // Upgrade A to ADMIN grant → same rule: A becomes visible too.
      await prisma.organizationAccess.create({
        data: {
          authIdentityId: identity.id,
          organizationId: orgA.id,
          role: "ADMIN",
        },
      });
      ctx = await getAuthContext();
      expect(
        linkedMembersWithAccess(ctx!)
          .map((m) => m.id)
          .sort(),
      ).toEqual([memberInA.id, memberInB.id].sort());
    });
  });

  describe("training administration", () => {
    let eventA: { id: string };
    let eventB: { id: string };

    beforeAll(async () => {
      eventA = await prisma.trainingEvent.create({
        data: {
          organizationId: orgA.id,
          title: uniq("event-a"),
          date: new Date("2027-03-01T00:00:00.000Z"),
        },
      });
      eventB = await prisma.trainingEvent.create({
        data: {
          organizationId: orgB.id,
          title: uniq("event-b"),
          date: new Date("2027-03-01T00:00:00.000Z"),
        },
      });
    });

    it("admin A manages events and attendance in A", async () => {
      signInAs(adminAUid);
      const created = await createTrainingEventAction(
        orgA.id,
        {},
        form({
          title: uniq("via-action"),
          date: "2027-05-10",
          durationMinutes: "90",
          topics: "anchors, radio",
        }),
      );
      expect(created).toEqual({});

      expect(
        await updateTrainingEventAction(
          eventA.id,
          {},
          form({ title: "renamed", date: "2027-03-01" }),
        ),
      ).toEqual({});

      expect(
        await setTrainingAttendanceAction(
          eventA.id,
          {},
          form({ memberIds: [memberA.id] }),
        ),
      ).toEqual({});
      const rows = await prisma.trainingAttendance.findMany({
        where: { trainingEventId: eventA.id },
      });
      expect(rows.map((r) => r.memberId)).toEqual([memberA.id]);

      await expect(
        setTrainingEventStatusAction(eventA.id, "CANCELLED"),
      ).resolves.toBeUndefined();
      const after = await prisma.trainingEvent.findUnique({
        where: { id: eventA.id },
      });
      expect(after?.status).toBe("CANCELLED");
      await setTrainingEventStatusAction(eventA.id, "COMPLETED");
    });

    it("admin A cannot create an event in org B", async () => {
      signInAs(adminAUid);
      expect(
        await createTrainingEventAction(
          orgB.id,
          {},
          form({ title: "intruder", date: "2027-01-01" }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await prisma.trainingEvent.count({
          where: { organizationId: orgB.id, title: "intruder" },
        }),
      ).toBe(0);
    });

    it("admin A cannot edit, cancel, or set attendance on org-B events", async () => {
      signInAs(adminAUid);
      expect(
        await updateTrainingEventAction(
          eventB.id,
          {},
          form({ title: "hijacked", date: "2027-03-01" }),
        ),
      ).toEqual({ message: "Not found." });
      await expect(
        setTrainingEventStatusAction(eventB.id, "CANCELLED"),
      ).rejects.toThrow("Not found or not permitted.");
      expect(
        await setTrainingAttendanceAction(
          eventB.id,
          {},
          form({ memberIds: [memberA.id] }),
        ),
      ).toEqual({ message: "Not found." });
      const unchanged = await prisma.trainingEvent.findUnique({
        where: { id: eventB.id },
      });
      expect(unchanged?.title).not.toBe("hijacked");
      expect(unchanged?.status).toBe("COMPLETED");
    });

    it("admin A cannot add an org-B member to an org-A event", async () => {
      signInAs(adminAUid);
      const result = await setTrainingAttendanceAction(
        eventA.id,
        {},
        form({ memberIds: [memberB.id] }),
      );
      expect(result).toEqual({ message: "Not found." });
      expect(
        await prisma.trainingAttendance.count({
          where: { trainingEventId: eventA.id, memberId: memberB.id },
        }),
      ).toBe(0);
    });

    it("admin A cannot reference an org-B unit or lead when creating", async () => {
      signInAs(adminAUid);
      expect(
        await createTrainingEventAction(
          orgA.id,
          {},
          form({
            title: "x",
            date: "2027-01-01",
            unitId: unitB.id,
          }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await createTrainingEventAction(
          orgA.id,
          {},
          form({
            title: "x",
            date: "2027-01-01",
            leadMemberId: memberB.id,
          }),
        ),
      ).toEqual({ message: "Not found." });
    });

    it("MEMBER role cannot mutate training records", async () => {
      signInAs(memberRoleUid); // MEMBER of org A
      expect(
        await createTrainingEventAction(
          orgA.id,
          {},
          form({ title: "x", date: "2027-01-01" }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await updateTrainingEventAction(
          eventA.id,
          {},
          form({ title: "x", date: "2027-01-01" }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await setTrainingAttendanceAction(
          eventA.id,
          {},
          form({ memberIds: [memberA.id] }),
        ),
      ).toEqual({ message: "Not found." });
    });

    it("unauthenticated training calls redirect to /login", async () => {
      signInAs(null);
      await expect(
        createTrainingEventAction(orgA.id, {}, form({})),
      ).rejects.toThrow("NEXT_REDIRECT /login");
      await expect(
        setTrainingAttendanceAction(eventA.id, {}, form({})),
      ).rejects.toThrow("NEXT_REDIRECT /login");
    });

    it("attendance edits record the authenticated admin as audit actor", async () => {
      signInAs(adminAUid);
      const newMember = await prisma.member.create({
        data: { organizationId: orgA.id, displayName: uniq("auditee") },
      });
      const before = await prisma.trainingAttendanceChange.count({
        where: { trainingEventId: eventA.id },
      });
      const result = await setTrainingAttendanceAction(
        eventA.id,
        {},
        form({ memberIds: [memberA.id, newMember.id] }),
      );
      expect(result).toEqual({});

      const rows = await prisma.trainingAttendanceChange.findMany({
        where: { trainingEventId: eventA.id },
        orderBy: { createdAt: "asc" },
      });
      expect(rows.length).toBeGreaterThan(before);
      // The actor came from the verified session — no client input can
      // reach this column.
      expect(rows.at(-1)?.actorAuthIdentityId).toBe(adminAIdentityId);
      expect(rows.at(-1)?.organizationId).toBe(orgA.id);
    });

    it("MEMBER role cannot create attendance audit rows", async () => {
      signInAs(memberRoleUid); // MEMBER of org A
      const before = await prisma.trainingAttendanceChange.count({
        where: { trainingEventId: eventA.id },
      });
      const result = await setTrainingAttendanceAction(
        eventA.id,
        {},
        form({ memberIds: [memberA.id] }),
      );
      expect(result).toEqual({ message: "Not found." });
      expect(
        await prisma.trainingAttendanceChange.count({
          where: { trainingEventId: eventA.id },
        }),
      ).toBe(before);
    });

    it("admin A cannot inspect organization B attendance history", async () => {
      // Seed org-B audit history directly, then prove the page-level
      // authorization boundary: an org-A admin gets the opaque
      // notFound, not the event — and therefore never the history.
      await prisma.trainingAttendanceChange.create({
        data: {
          organizationId: orgB.id,
          trainingEventId: eventB.id,
          memberId: memberB.id,
          actorAuthIdentityId: "any-actor",
          action: "ADDED",
        },
      });
      signInAs(adminAUid);
      await expect(
        TrainingEventPage({
          params: Promise.resolve({ eventId: eventB.id }),
        }),
      ).rejects.toThrow("NEXT_NOT_FOUND");

      // The org-B admin renders it — including the audit section.
      signInAs(adminBUid);
      const page = await TrainingEventPage({
        params: Promise.resolve({ eventId: eventB.id }),
      });
      expect(page).toBeTruthy();
    });
  });

  describe("assets, inventory, locations (issue #10)", () => {
    it("admin A creates locations, assets, and items in org A", async () => {
      signInAs(adminAUid);
      expect(
        await createStorageLocationAction(
          orgA.id,
          {},
          form({ name: uniq("loc"), container: "" }),
        ),
      ).toEqual({});
      await expect(
        createAssetAction(orgA.id, {}, form({ name: uniq("asset") })),
      ).rejects.toThrow("NEXT_REDIRECT /admin/assets/");
      expect(
        await createInventoryItemAction(
          orgA.id,
          {},
          form({ name: uniq("item"), quantity: "3" }),
        ),
      ).toEqual({});
    });

    it("admin A cannot create records in organization B", async () => {
      signInAs(adminAUid);
      expect(
        await createStorageLocationAction(
          orgB.id,
          {},
          form({ name: uniq("loc"), container: "" }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await createInventoryItemAction(
          orgB.id,
          {},
          form({ name: uniq("item"), quantity: "1" }),
        ),
      ).toEqual({ message: "Not found." });
      // createAssetAction would redirect on success — denial returns
      // the opaque message instead.
      expect(
        await createAssetAction(orgB.id, {}, form({ name: uniq("asset") })),
      ).toEqual({ message: "Not found." });
    });

    it("admin A cannot view or edit organization B records", async () => {
      const locB = await prisma.storageLocation.create({
        data: { organizationId: orgB.id, name: uniq("loc-b") },
      });
      const assetB = await prisma.asset.create({
        data: { organizationId: orgB.id, name: uniq("asset-b") },
      });
      const itemB = await prisma.inventoryItem.create({
        data: {
          organizationId: orgB.id,
          name: uniq("item-b"),
          quantity: 1,
        },
      });

      signInAs(adminAUid);
      expect(
        await updateStorageLocationAction(
          locB.id,
          {},
          form({ name: uniq("hijack"), container: "" }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await updateAssetAction(assetB.id, {}, form({ name: uniq("hijack") })),
      ).toEqual({ message: "Not found." });
      expect(
        await updateInventoryItemAction(
          itemB.id,
          {},
          form({ name: uniq("hijack"), quantity: "9" }),
        ),
      ).toEqual({ message: "Not found." });

      // Substituted/unknown ids are indistinguishable from foreign ones.
      const foreign = await updateAssetAction(
        assetB.id,
        {},
        form({ name: "x" }),
      );
      const missing = await updateAssetAction(
        "nonexistent-id",
        {},
        form({ name: "x" }),
      );
      expect(foreign).toEqual({ message: "Not found." });
      expect(missing).toEqual(foreign);

      // Page-level: the asset detail page is opaque to admin A.
      await expect(
        AssetPage({ params: Promise.resolve({ assetId: assetB.id }) }),
      ).rejects.toThrow("NEXT_NOT_FOUND");

      // Nothing was mutated.
      expect(
        (await prisma.asset.findUniqueOrThrow({ where: { id: assetB.id } }))
          .name,
      ).not.toContain("hijack");
    });

    it("admin A cannot attach org-B locations, units, or parents", async () => {
      const locA = await prisma.storageLocation.create({
        data: { organizationId: orgA.id, name: uniq("loc-a") },
      });
      const locB = await prisma.storageLocation.create({
        data: { organizationId: orgB.id, name: uniq("loc-b2") },
      });
      const assetA = await prisma.asset.create({
        data: { organizationId: orgA.id, name: uniq("asset-a") },
      });
      const parentB = await prisma.asset.create({
        data: { organizationId: orgB.id, name: uniq("parent-b") },
      });

      signInAs(adminAUid);
      // Move org-A asset into an org-B location — opaque failure.
      expect(
        await updateAssetAction(
          assetA.id,
          {},
          form({ name: assetA.name, storageLocationId: locB.id }),
        ),
      ).toEqual({ message: "Not found." });
      // Org-B unit on an org-A asset.
      expect(
        await updateAssetAction(
          assetA.id,
          {},
          form({ name: assetA.name, unitId: unitB.id }),
        ),
      ).toEqual({ message: "Not found." });
      // Org-B parent asset.
      expect(
        await updateAssetAction(
          assetA.id,
          {},
          form({ name: assetA.name, parentAssetId: parentB.id }),
        ),
      ).toEqual({ message: "Not found." });
      // Org-A location nested inside an org-B location.
      expect(
        await updateStorageLocationAction(
          locA.id,
          {},
          form({ name: locA.name, container: `location:${locB.id}` }),
        ),
      ).toEqual({ message: "Not found." });
      // Org-A location inside an org-B asset.
      expect(
        await createStorageLocationAction(
          orgA.id,
          {},
          form({ name: uniq("loc"), container: `asset:${parentB.id}` }),
        ),
      ).toEqual({ message: "Not found." });
      // Org-B location on an org-A inventory item.
      const itemA = await prisma.inventoryItem.create({
        data: { organizationId: orgA.id, name: uniq("item-a"), quantity: 1 },
      });
      expect(
        await updateInventoryItemAction(
          itemA.id,
          {},
          form({ name: itemA.name, quantity: "1", storageLocationId: locB.id }),
        ),
      ).toEqual({ message: "Not found." });
    });

    it("MEMBER role cannot mutate assets, locations, or items", async () => {
      signInAs(memberRoleUid); // MEMBER of org A
      expect(
        await createStorageLocationAction(
          orgA.id,
          {},
          form({ name: uniq("loc"), container: "" }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await createInventoryItemAction(
          orgA.id,
          {},
          form({ name: uniq("item"), quantity: "1" }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await createAssetAction(orgA.id, {}, form({ name: uniq("asset") })),
      ).toEqual({ message: "Not found." });
    });

    it("unauthenticated callers are redirected before any write", async () => {
      signInAs(null);
      await expect(
        createStorageLocationAction(orgA.id, {}, form({ name: "x" })),
      ).rejects.toThrow("NEXT_REDIRECT /login");
      await expect(
        createAssetAction(orgA.id, {}, form({ name: "x" })),
      ).rejects.toThrow("NEXT_REDIRECT /login");
      await expect(
        createInventoryItemAction(orgA.id, {}, form({ name: "x" })),
      ).rejects.toThrow("NEXT_REDIRECT /login");
    });
  });

  describe("issue #11 — inspections, maintenance, defects, meters", () => {
    const recordDate = "2026-09-15";

    it("admin A manages org A records end to end", async () => {
      signInAs(adminAUid);
      expect(
        await createInspectionDefinitionAction(
          orgA.id,
          {},
          form({
            name: uniq("def-a"),
            recurrenceType: "CALENDAR_DAYS",
            intervalValue: "30",
          }),
        ),
      ).toEqual({});
      const defA = await prisma.inspectionDefinition.findFirst({
        where: { organizationId: orgA.id },
      });
      expect(defA).not.toBeNull();
      expect(
        await recordInspectionAction(
          assetA.id,
          {},
          form({
            definitionId: defA!.id,
            performedOn: recordDate,
            inspectorMemberId: "",
            inspectorName: "",
            conditionObserved: "",
            nextDueOn: "",
            meterId: "",
            meterReading: "",
            notes: "",
          }),
        ),
      ).toEqual({});

      expect(
        await createAssetMeterAction(
          assetA.id,
          {},
          form({ name: uniq("meter-a"), unit: "hours" }),
        ),
      ).toEqual({});
      const meterA = await prisma.assetMeter.findFirst({
        where: { assetId: assetA.id },
      });
      expect(
        await recordMeterReadingAction(
          meterA!.id,
          {},
          form({
            reading: "42.5",
            recordedOn: recordDate,
            recordedByMemberId: "",
            notes: "",
          }),
        ),
      ).toEqual({});

      expect(
        await createMaintenancePlanAction(
          assetA.id,
          {},
          form({
            name: uniq("plan-a"),
            description: "",
            intervalType: "METER_INTERVAL",
            intervalValue: "",
            meterId: meterA!.id,
            meterInterval: "100",
          }),
        ),
      ).toEqual({});
      const planA = await prisma.maintenancePlan.findFirst({
        where: { assetId: assetA.id },
      });
      expect(
        await recordMaintenanceAction(
          assetA.id,
          {},
          form({
            planId: planA!.id,
            title: uniq("service-a"),
            performedOn: recordDate,
            providerName: "",
            performedByMemberId: "",
            meterId: meterA!.id,
            meterReading: "50",
            nextDueOn: "",
            workPerformed: "",
            notes: "",
          }),
        ),
      ).toEqual({});

      expect(
        await reportDefectAction(
          assetA.id,
          {},
          form({
            title: uniq("defect-a"),
            description: "",
            reportedOn: recordDate,
            reportedByMemberId: "",
            reporterName: "",
          }),
        ),
      ).toEqual({});
      const defectA = await prisma.defect.findFirst({
        where: { assetId: assetA.id },
      });
      expect(
        await transitionDefectAction(
          defectA!.id,
          {},
          form({
            status: "RESOLVED",
            resolvedOn: "2026-09-20",
            resolutionNotes: "Fixed",
            note: "",
          }),
        ),
      ).toEqual({});
      expect(
        (await prisma.defect.findUnique({ where: { id: defectA!.id } }))
          ?.status,
      ).toBe("RESOLVED");
    });

    it("admin A cannot touch organization B records — opaque failures", async () => {
      signInAs(adminAUid);
      // Org B as the target organization id.
      expect(
        await createInspectionDefinitionAction(
          orgB.id,
          {},
          form({ name: uniq("hijack"), recurrenceType: "NONE" }),
        ),
      ).toEqual({ message: "Not found." });

      // Foreign record ids — identical to nonexistent ones.
      expect(
        await updateInspectionDefinitionAction(
          inspectionDefinitionB.id,
          {},
          form({ name: "x", recurrenceType: "NONE" }),
        ),
      ).toEqual({ message: "Not found." });
      await expect(
        setInspectionDefinitionStatusAction(
          inspectionDefinitionB.id,
          "INACTIVE",
        ),
      ).rejects.toThrow("Not found or not permitted.");

      expect(
        await recordInspectionAction(
          assetB.id,
          {},
          form({
            definitionId: inspectionDefinitionB.id,
            performedOn: recordDate,
          }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await updateInspectionRecordAction(
          inspectionRecordB.id,
          {},
          form({ performedOn: recordDate }),
        ),
      ).toEqual({ message: "Not found." });

      expect(
        await createMaintenancePlanAction(
          assetB.id,
          {},
          form({ name: uniq("hijack-plan"), intervalType: "NONE" }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await updateMaintenanceRecordAction(
          maintenanceRecordB.id,
          {},
          form({ title: "hijack", performedOn: recordDate }),
        ),
      ).toEqual({ message: "Not found." });

      expect(
        await reportDefectAction(
          assetB.id,
          {},
          form({ title: "hijack", reportedOn: recordDate }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await updateDefectAction(
          defectB.id,
          {},
          form({ title: "hijack", reportedOn: recordDate }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await transitionDefectAction(
          defectB.id,
          {},
          form({ status: "RESOLVED", resolvedOn: "2026-09-20" }),
        ),
      ).toEqual({ message: "Not found." });

      expect(
        await createAssetMeterAction(
          assetB.id,
          {},
          form({ name: "hijack", unit: "hours" }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await recordMeterReadingAction(
          meterB.id,
          {},
          form({ reading: "1", recordedOn: recordDate }),
        ),
      ).toEqual({ message: "Not found." });

      // Nothing in org B changed.
      expect(
        (await prisma.defect.findUnique({ where: { id: defectB.id } }))?.status,
      ).toBe("OPEN");
      expect(
        (
          await prisma.inspectionDefinition.findUnique({
            where: { id: inspectionDefinitionB.id },
          })
        )?.status,
      ).toBe("ACTIVE");
    });

    it("treats nonexistent and foreign ids identically", async () => {
      signInAs(adminAUid);
      const missing = await updateInspectionRecordAction(
        "nonexistent-id",
        {},
        form({ performedOn: recordDate }),
      );
      const foreign = await updateInspectionRecordAction(
        inspectionRecordB.id,
        {},
        form({ performedOn: recordDate }),
      );
      expect(missing).toEqual({ message: "Not found." });
      expect(missing).toEqual(foreign);
    });

    it("MEMBER role cannot mutate maintenance records", async () => {
      signInAs(memberRoleUid);
      expect(
        await reportDefectAction(
          assetA.id,
          {},
          form({ title: "member attempt", reportedOn: recordDate }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await createInspectionDefinitionAction(
          orgA.id,
          {},
          form({ name: uniq("member-def"), recurrenceType: "NONE" }),
        ),
      ).toEqual({ message: "Not found." });
    });

    it("unauthenticated callers are redirected before any write", async () => {
      signInAs(null);
      await expect(
        reportDefectAction(
          assetA.id,
          {},
          form({ title: "x", reportedOn: recordDate }),
        ),
      ).rejects.toThrow("NEXT_REDIRECT /login");
      await expect(
        createInspectionDefinitionAction(
          orgA.id,
          {},
          form({ name: "x", recurrenceType: "NONE" }),
        ),
      ).rejects.toThrow("NEXT_REDIRECT /login");
    });
  });
});
