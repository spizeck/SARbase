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
  setMemberAvailabilityAction,
  updateMemberContactPreferenceAction,
  sendAdminNotificationAction,
  retryNotificationAction,
  createIncidentAction,
  transitionIncidentStatusAction,
  updateIncidentAction,
  addIncidentMemberAction,
  removeIncidentMemberAction,
  addIncidentNoteAction,
  correctIncidentNoteAction,
  createVendorAction,
  updateVendorAction,
  setVendorStatusAction,
  createExpenseAction,
  updateExpenseAction,
  transitionExpenseAction,
  rejectExpenseAction,
  setExpenseReimbursementAction,
  addExpenseLinkAction,
  removeExpenseLinkAction,
} from "@/app/admin/actions";
import { createIncident } from "@/lib/domain/incidents";
import { createVendor, createExpense } from "@/lib/domain/expenses";
import {
  updateMyAvailabilityAction,
  updateMyContactPreferencesAction,
} from "@/app/account/actions";
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
let inspectionDefinitionA: { id: string };
let inspectionRecordA: { id: string };
let maintenanceRecordA: { id: string };
let inspectionDefinitionB: { id: string };
let inspectionRecordB: { id: string };
let maintenancePlanB: { id: string };
let maintenanceRecordB: { id: string };
let defectB: { id: string };
let meterB: { id: string };
// Issue #15 fixtures — incident records must be opaque across orgs.
let incidentA: { id: string };
let incidentB: { id: string };
let incidentMemberB: { id: string };
let incidentNoteB: { id: string };
// Issue #17 fixtures — financial records must be opaque across orgs.
let vendorB: { id: string };
let expenseB: { id: string };
let expenseLinkB: { id: string };

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
    inspectionDefinitionA = await prisma.inspectionDefinition.create({
      data: { organizationId: orgA.id, name: uniq("def-a") },
    });
    inspectionRecordA = await prisma.inspectionRecord.create({
      data: {
        organizationId: orgA.id,
        assetId: assetA.id,
        definitionId: inspectionDefinitionA.id,
        performedOn: new Date("2026-09-15T00:00:00.000Z"),
      },
    });
    maintenanceRecordA = await prisma.maintenanceRecord.create({
      data: {
        organizationId: orgA.id,
        assetId: assetA.id,
        title: uniq("svc-a"),
        performedOn: new Date("2026-09-15T00:00:00.000Z"),
      },
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
    // Issue #15 fixtures — one incident per org, plus org-B children that
    // an org-A admin must never reach through the id selectors.
    const incA = await createIncident(
      orgA.id,
      { title: uniq("incident-a") },
      adminAIdentityId,
    );
    incidentA = { id: incA.id };
    const incB = await createIncident(
      orgB.id,
      { title: uniq("incident-b") },
      adminB!.id,
    );
    incidentB = { id: incB.id };
    const pmB = await prisma.incidentMember.create({
      data: {
        organizationId: orgB.id,
        incidentId: incB.id,
        memberId: memberB.id,
        recordedByAuthIdentityId: adminB!.id,
      },
    });
    incidentMemberB = { id: pmB.id };
    const noteB = await prisma.incidentNote.create({
      data: {
        organizationId: orgB.id,
        incidentId: incB.id,
        authorAuthIdentityId: adminB!.id,
        body: uniq("note-b"),
      },
    });
    incidentNoteB = { id: noteB.id };
    // Issue #17 fixtures — a vendor, an expense, and a context-link row
    // in org B that an org-A admin must never reach through selectors.
    const vB = await createVendor(
      orgB.id,
      { name: uniq("vendor-b") },
      adminB!.id,
    );
    vendorB = { id: vB.id };
    const eB = await createExpense(
      orgB.id,
      {
        expenseDate: new Date("2026-03-15T00:00:00.000Z"),
        amount: "10.00",
        currency: "USD",
        vendorId: vB.id,
        reimbursementStatus: "NOT_REQUIRED",
      },
      adminB!.id,
    );
    expenseB = { id: eB.id };
    const linkB = await prisma.expenseAsset.create({
      data: {
        organizationId: orgB.id,
        expenseId: eB.id,
        assetId: assetB.id,
        recordedByAuthIdentityId: adminB!.id,
      },
    });
    expenseLinkB = { id: linkB.id };
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
    await prisma.inspectionRecordChange.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.maintenanceRecordChange.deleteMany({
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
    // Issue #12 fixtures — Restrict edges to members and actor
    // identities require cleanup before both parents.
    await prisma.memberAvailabilityUpdate.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.memberNotificationPreference.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    // Issue #13 — attempts before requests (append-only children), then
    // the requests' Restrict edges to members/organizations.
    await prisma.notificationAttempt.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.notification.deleteMany({
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
    // Issue #17 fixtures — link rows/events/changes first (Restrict
    // edges to expenses, members, assets, incidents), then expenses,
    // sequences, vendors — all before their parents.
    await prisma.expenseChange.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.expenseEvent.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.expenseIncident.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.expenseTrainingEvent.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.expenseAsset.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.expenseMaintenanceRecord.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.expenseInventoryItem.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.expenseAttachment.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.expenseSequence.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.expense.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.vendor.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    // Issue #15 fixtures — append-only children before incidents, and
    // all of it before members (IncidentMember carries a member FK).
    await prisma.incidentNoteCorrection.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.incidentNote.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.incidentTimelineEvent.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.incidentChange.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.incidentMember.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.incidentAsset.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.incidentSequence.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.incident.deleteMany({
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

    it("MEMBER can write neither a correction nor its history", async () => {
      signInAs(memberRoleUid);
      const before = await prisma.inspectionRecord.findUniqueOrThrow({
        where: { id: inspectionRecordA.id },
      });
      expect(
        await updateInspectionRecordAction(
          inspectionRecordA.id,
          {},
          form({ performedOn: "2026-09-16", notes: "member tamper" }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await updateMaintenanceRecordAction(
          maintenanceRecordA.id,
          {},
          form({ title: "member tamper", performedOn: recordDate }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await prisma.inspectionRecord.findUniqueOrThrow({
          where: { id: inspectionRecordA.id },
        }),
      ).toEqual(before);
      expect(
        await prisma.inspectionRecordChange.count({
          where: { recordId: inspectionRecordA.id },
        }),
      ).toBe(0);
      expect(
        await prisma.maintenanceRecordChange.count({
          where: { recordId: maintenanceRecordA.id },
        }),
      ).toBe(0);
    });

    it("admin A cannot mutate org B records or grow their history", async () => {
      signInAs(adminAUid);
      const before = await prisma.maintenanceRecord.findUniqueOrThrow({
        where: { id: maintenanceRecordB.id },
      });
      expect(
        await updateMaintenanceRecordAction(
          maintenanceRecordB.id,
          {},
          form({ title: "tampered", performedOn: recordDate }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await updateInspectionRecordAction(
          inspectionRecordB.id,
          {},
          form({ performedOn: "2026-09-20" }),
        ),
      ).toEqual({ message: "Not found." });
      // Foreign record untouched; no change rows materialized.
      expect(
        await prisma.maintenanceRecord.findUniqueOrThrow({
          where: { id: maintenanceRecordB.id },
        }),
      ).toEqual(before);
      expect(
        await prisma.maintenanceRecordChange.count({
          where: { recordId: maintenanceRecordB.id },
        }),
      ).toBe(0);
      expect(
        await prisma.inspectionRecordChange.count({
          where: { recordId: inspectionRecordB.id },
        }),
      ).toBe(0);
    });

    it("derives the correction actor from the server identity, not the form", async () => {
      signInAs(adminAUid);
      expect(
        await updateInspectionRecordAction(
          inspectionRecordA.id,
          {},
          form({
            performedOn: "2026-09-16",
            notes: "spoof attempt",
            // Forged fields — must be ignored; the actor is ctx.identity.
            actorAuthIdentityId: "attacker-identity",
            actorId: "attacker-identity",
            correctionNote: "date was wrong",
          }),
        ),
      ).toEqual({});
      const change = await prisma.inspectionRecordChange.findFirstOrThrow({
        where: { recordId: inspectionRecordA.id },
      });
      expect(change.actorAuthIdentityId).toBe(adminAIdentityId);
      expect(change.note).toBe("date was wrong");
      expect(change.afterNotes).toBe("spoof attempt");
    });
  });

  describe("member availability & contact preference authorization", () => {
    // Issue #12: self-service is scoped to the caller's own linked member
    // AND gated on a live OrganizationAccess row — the Member link alone
    // grants nothing. All denials surface as an opaque "Not found."
    let selfMember: { id: string }; // org A, linked to memberRoleUid
    let unlinkedMemberA: { id: string }; // org A, no link
    let memberRoleIdentityId: string;

    beforeAll(async () => {
      const memberRoleIdentity = await prisma.authIdentity.findUniqueOrThrow({
        where: {
          provider_providerUid: {
            provider: "firebase",
            providerUid: memberRoleUid,
          },
        },
      });
      memberRoleIdentityId = memberRoleIdentity.id;
      selfMember = await prisma.member.create({
        data: {
          organizationId: orgA.id,
          displayName: uniq("self"),
          email: "self@example.org",
          phone: "+17875550134",
          authIdentityId: memberRoleIdentity.id,
        },
      });
      unlinkedMemberA = await prisma.member.create({
        data: { organizationId: orgA.id, displayName: uniq("unlinked-self") },
      });
    });

    it("a linked member with MEMBER access records own availability (selfReported)", async () => {
      signInAs(memberRoleUid); // MEMBER of org A, linked to selfMember
      const result = await updateMyAvailabilityAction(
        selfMember.id,
        {},
        form({ status: "OFF_ISLAND", until: "2030-01-01", note: "" }),
      );
      expect(result).toEqual({});
      const saved = await prisma.memberAvailabilityUpdate.findFirstOrThrow({
        where: { memberId: selfMember.id, status: "OFF_ISLAND" },
      });
      expect(saved.organizationId).toBe(orgA.id);
      expect(saved.selfReported).toBe(true);
      // The actor is the server identity — never client-supplied.
      expect(saved.actorAuthIdentityId).toBe(memberRoleIdentityId);
    });

    it("a forged actor field is ignored — attribution stays the session identity", async () => {
      signInAs(memberRoleUid);
      const result = await updateMyAvailabilityAction(
        selfMember.id,
        {},
        form({
          status: "AVAILABLE",
          until: "",
          note: "",
          actorAuthIdentityId: adminAIdentityId,
        }),
      );
      expect(result).toEqual({});
      const saved = await prisma.memberAvailabilityUpdate.findFirstOrThrow({
        where: { memberId: selfMember.id, status: "AVAILABLE" },
      });
      expect(saved.actorAuthIdentityId).toBe(memberRoleIdentityId);
    });

    it("cannot submit another memberId — unlinked, linked-to-someone-else, or cross-org", async () => {
      signInAs(memberRoleUid);
      const beforeA = await prisma.memberAvailabilityUpdate.count({
        where: { memberId: unlinkedMemberA.id },
      });
      const beforeB = await prisma.memberAvailabilityUpdate.count({
        where: { memberId: memberB.id },
      });
      for (const target of [unlinkedMemberA.id, memberA.id, memberB.id]) {
        expect(
          await updateMyAvailabilityAction(
            target,
            {},
            form({ status: "AVAILABLE", until: "", note: "" }),
          ),
        ).toEqual({ message: "Not found." });
      }
      expect(
        await prisma.memberAvailabilityUpdate.count({
          where: { memberId: unlinkedMemberA.id },
        }),
      ).toBe(beforeA);
      expect(
        await prisma.memberAvailabilityUpdate.count({
          where: { memberId: memberB.id },
        }),
      ).toBe(beforeB);
    });

    it("revoked OrganizationAccess removes self-service even while linked", async () => {
      signInAs(memberRoleUid);
      const access = await prisma.organizationAccess.findFirstOrThrow({
        where: {
          authIdentityId: memberRoleIdentityId,
          organizationId: orgA.id,
        },
      });
      await prisma.organizationAccess.delete({ where: { id: access.id } });
      try {
        // Still linked via Member.authIdentityId — but no access row.
        expect(
          await updateMyAvailabilityAction(
            selfMember.id,
            {},
            form({ status: "UNAVAILABLE", until: "", note: "" }),
          ),
        ).toEqual({ message: "Not found." });
        expect(
          await prisma.memberAvailabilityUpdate.count({
            where: { memberId: selfMember.id, status: "UNAVAILABLE" },
          }),
        ).toBe(0);
      } finally {
        await prisma.organizationAccess.create({
          data: {
            authIdentityId: memberRoleIdentityId,
            organizationId: orgA.id,
            role: "MEMBER",
          },
        });
      }
    });

    it("unauthenticated self-service is denied", async () => {
      signInAs(null);
      expect(
        await updateMyAvailabilityAction(
          selfMember.id,
          {},
          form({ status: "AVAILABLE" }),
        ),
      ).toEqual({ message: "Not found." });
    });

    it("self updates contact preferences; SMS requires a phone destination", async () => {
      signInAs(memberRoleUid);
      expect(
        await updateMyContactPreferencesAction(
          selfMember.id,
          {},
          form({ notifyEmail: "on", notifySms: "on" }),
        ),
      ).toEqual({});
      const saved = await prisma.memberNotificationPreference.findFirstOrThrow({
        where: { memberId: selfMember.id },
      });
      expect(saved.notifyEmail).toBe(true);
      expect(saved.notifySms).toBe(true);
      expect(saved.notifyWhatsapp).toBe(false);
      expect(saved.notifyPush).toBe(false);
    });

    it("cannot update another member's contact preferences (IDOR)", async () => {
      signInAs(memberRoleUid);
      expect(
        await updateMyContactPreferencesAction(
          unlinkedMemberA.id,
          {},
          form({ notifyEmail: "on" }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await updateMyContactPreferencesAction(
          memberB.id,
          {},
          form({ notifyEmail: "on" }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await prisma.memberNotificationPreference.count({
          where: { memberId: { in: [unlinkedMemberA.id, memberB.id] } },
        }),
      ).toBe(0);
    });

    it("admin records availability on behalf — attributed, not selfReported", async () => {
      signInAs(adminAUid);
      expect(
        await setMemberAvailabilityAction(
          unlinkedMemberA.id,
          {},
          form({
            status: "UNAVAILABLE",
            until: "2030-02-01",
            note: "Phoned in",
          }),
        ),
      ).toEqual({});
      const saved = await prisma.memberAvailabilityUpdate.findFirstOrThrow({
        where: { memberId: unlinkedMemberA.id, status: "UNAVAILABLE" },
      });
      expect(saved.selfReported).toBe(false);
      expect(saved.actorAuthIdentityId).toBe(adminAIdentityId);
      expect(saved.note).toBe("Phoned in");
    });

    it("admin A cannot manage availability or preferences for org B members", async () => {
      signInAs(adminAUid);
      expect(
        await setMemberAvailabilityAction(
          memberB.id,
          {},
          form({ status: "AVAILABLE" }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await updateMemberContactPreferenceAction(
          memberB.id,
          {},
          form({ notifyEmail: "on" }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await prisma.memberAvailabilityUpdate.count({
          where: { memberId: memberB.id },
        }),
      ).toBe(0);
      expect(
        await prisma.memberNotificationPreference.count({
          where: { memberId: memberB.id },
        }),
      ).toBe(0);
    });

    it("admin updates a member's preferences; email requires a destination", async () => {
      signInAs(adminAUid);
      expect(
        await updateMemberContactPreferenceAction(
          selfMember.id,
          {},
          form({ notifyEmail: "on", notifyPush: "on" }),
        ),
      ).toEqual({});
      // unlinkedMemberA has neither email nor phone → refuses.
      expect(
        await updateMemberContactPreferenceAction(
          unlinkedMemberA.id,
          {},
          form({ notifyEmail: "on" }),
        ),
      ).toEqual({
        message:
          "Email notifications need an email address on the member record.",
      });
    });

    it("MEMBER role cannot use the admin availability/preference actions", async () => {
      signInAs(memberRoleUid);
      expect(
        await setMemberAvailabilityAction(
          selfMember.id,
          {},
          form({ status: "AVAILABLE" }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await updateMemberContactPreferenceAction(
          selfMember.id,
          {},
          form({ notifyEmail: "on" }),
        ),
      ).toEqual({ message: "Not found." });
    });
  });

  describe("notification administration (issue #13)", () => {
    // The provider resolves to the deterministic fake in tests — these
    // calls never touch the network.
    function sendForm(overrides: Record<string, string> = {}) {
      return form({
        memberId: "",
        destination: `dest-${counter}@example.test`,
        subject: "Radio check",
        body: "Synthetic test notification.",
        idempotencyKey: uniq("idem"),
        ...overrides,
      });
    }

    it("admin A sends a one-off notification in org A — actor attributed server-side", async () => {
      signInAs(adminAUid);
      const result = await sendAdminNotificationAction(orgA.id, {}, sendForm());
      expect(result).toEqual({});
      const saved = await prisma.notification.findFirstOrThrow({
        where: { organizationId: orgA.id, template: "admin_test" },
        orderBy: { createdAt: "desc" },
      });
      expect(saved.status).toBe("ACCEPTED");
      expect(saved.requestedByAuthIdentityId).toBe(adminAIdentityId);
      expect(
        await prisma.notificationAttempt.count({
          where: { notificationId: saved.id },
        }),
      ).toBe(1);
    });

    it("a forged actor field in the form cannot redirect attribution", async () => {
      signInAs(adminAUid);
      const result = await sendAdminNotificationAction(
        orgA.id,
        {},
        sendForm({ requestedByAuthIdentityId: "attacker" }),
      );
      expect(result).toEqual({});
      const saved = await prisma.notification.findFirstOrThrow({
        where: { organizationId: orgA.id },
        orderBy: { createdAt: "desc" },
      });
      expect(saved.requestedByAuthIdentityId).toBe(adminAIdentityId);
    });

    it("rejects a member target from another organization", async () => {
      signInAs(adminAUid);
      const result = await sendAdminNotificationAction(
        orgA.id,
        {},
        sendForm({ memberId: memberB.id, destination: "" }),
      );
      expect(result).toEqual({ message: "Not found." });
      expect(
        await prisma.notification.count({ where: { memberId: memberB.id } }),
      ).toBe(0);
    });

    it("MEMBER role and unauthenticated callers are denied", async () => {
      const before = await prisma.notification.count({
        where: { organizationId: orgA.id },
      });
      signInAs(memberRoleUid);
      expect(
        await sendAdminNotificationAction(orgA.id, {}, sendForm()),
      ).toEqual({ message: "Not found." });
      signInAs(null);
      await expect(
        sendAdminNotificationAction(orgA.id, {}, sendForm()),
      ).rejects.toThrow("NEXT_REDIRECT /login");
      expect(
        await prisma.notification.count({
          where: { organizationId: orgA.id },
        }),
      ).toBe(before); // nothing was written by either denied call
    });

    it("admin A cannot retry a notification belonging to org B", async () => {
      const foreign = await prisma.notification.create({
        data: {
          organizationId: orgB.id,
          channel: "EMAIL",
          template: "admin_test",
          destination: "b@example.test",
          idempotencyKey: uniq("foreign"),
          intentHash: "x",
          status: "FAILED",
        },
      });
      signInAs(adminAUid);
      const result = await retryNotificationAction(foreign.id);
      expect(result).toEqual({ message: "Not found." });
      expect(
        await prisma.notificationAttempt.count({
          where: { notificationId: foreign.id },
        }),
      ).toBe(0);
    });

    it("rate limiting denies sends beyond the per-actor window", async () => {
      signInAs(adminAUid);
      const limit = 10; // NOTIFICATION_SEND_LIMIT in actions.ts
      let denied: unknown = null;
      for (let i = 0; i < limit + 2; i++) {
        const result = await sendAdminNotificationAction(
          orgA.id,
          {},
          sendForm(),
        );
        if (result && "message" in result && result.message !== "Not found.") {
          denied = result;
        }
      }
      expect(denied).toEqual({
        message:
          "Too many notification requests. Please wait a moment and try again.",
      });
    });
  });

  describe("incident records (issue #15 — sensitive data, ADMIN-only)", () => {
    it("denies unauthenticated callers before any lookup", async () => {
      signInAs(null);
      await expect(
        createIncidentAction(orgA.id, {}, form({ title: "x" })),
      ).rejects.toThrow("NEXT_REDIRECT /login");
      await expect(
        transitionIncidentStatusAction(incidentA.id, "OPEN"),
      ).rejects.toThrow("NEXT_REDIRECT /login");
    });

    it("denies an ordinary MEMBER of the same organization", async () => {
      signInAs(memberRoleUid);
      expect(
        await createIncidentAction(orgA.id, {}, form({ title: "x" })),
      ).toEqual({ message: "Not found." });
      expect(
        await transitionIncidentStatusAction(incidentA.id, "OPEN"),
      ).toEqual({ message: "Not found." });
      expect(
        await addIncidentNoteAction(
          incidentA.id,
          {},
          form({ kind: "GENERAL", body: "snoop" }),
        ),
      ).toEqual({ message: "Not found." });
      // Nothing was written.
      expect(
        await prisma.incidentTimelineEvent.count({
          where: { incidentId: incidentA.id },
        }),
      ).toBe(1); // only INCIDENT_CREATED
    });

    it("denies an org-A admin against every org-B incident surface", async () => {
      signInAs(adminAUid);
      expect(
        await transitionIncidentStatusAction(incidentB.id, "OPEN"),
      ).toEqual({ message: "Not found." });
      expect(
        await updateIncidentAction(
          incidentB.id,
          {},
          form({ title: uniq("hijack") }),
        ),
      ).toEqual({ message: "Not found." });
      expect(
        await addIncidentMemberAction(
          incidentB.id,
          {},
          form({ memberId: memberA.id }),
        ),
      ).toEqual({ message: "Not found." });
      // Child-row selectors resolve to their own org — removing org-B
      // participation or correcting org-B notes is equally opaque.
      expect(await removeIncidentMemberAction(incidentMemberB.id)).toEqual({
        message: "Not found.",
      });
      expect(
        await correctIncidentNoteAction(
          incidentNoteB.id,
          {},
          form({ body: "tampered" }),
        ),
      ).toEqual({ message: "Not found." });

      const unchanged = await prisma.incident.findUnique({
        where: { id: incidentB.id },
      });
      expect(unchanged?.status).toBe("DRAFT");
      const noteB = await prisma.incidentNote.findUniqueOrThrow({
        where: { id: incidentNoteB.id },
      });
      expect(noteB.body).toContain("note-b");
    });

    it("treats a foreign incident id identically to a nonexistent one", async () => {
      signInAs(adminAUid);
      const missing = await transitionIncidentStatusAction(
        "nonexistent-id",
        "OPEN",
      );
      const foreign = await transitionIncidentStatusAction(
        incidentB.id,
        "OPEN",
      );
      expect(missing).toEqual({ message: "Not found." });
      expect(missing).toEqual(foreign);
    });

    it("ignores a forged actor id — attribution is the signed-in identity", async () => {
      signInAs(adminAUid);
      const fd = form({
        kind: "GENERAL",
        body: uniq("forged"),
        occurredAt: "",
      });
      // A form-supplied author id must never reach the record.
      fd.append("authorAuthIdentityId", "someone-else");
      fd.append("organizationId", orgB.id);
      expect(await addIncidentNoteAction(incidentA.id, {}, fd)).toEqual({});
      const note = await prisma.incidentNote.findFirstOrThrow({
        where: { incidentId: incidentA.id },
      });
      expect(note.authorAuthIdentityId).toBe(adminAIdentityId);
      expect(note.organizationId).toBe(orgA.id);
    });
  });

  describe("vendors and expenses (issue #17 — financial data, ADMIN-only)", () => {
    const expenseForm = (overrides: Record<string, string> = {}) =>
      form({
        expenseDate: "2026-03-15",
        amount: "12.50",
        currency: "USD",
        category: "Fuel",
        ...overrides,
      });

    it("denies unauthenticated callers before any lookup", async () => {
      signInAs(null);
      await expect(
        createVendorAction(orgA.id, {}, form({ name: "x" })),
      ).rejects.toThrow("NEXT_REDIRECT /login");
      await expect(
        createExpenseAction(orgA.id, {}, expenseForm()),
      ).rejects.toThrow("NEXT_REDIRECT /login");
      await expect(
        transitionExpenseAction(expenseB.id, "SUBMITTED"),
      ).rejects.toThrow("NEXT_REDIRECT /login");
    });

    it("denies an ordinary MEMBER of the same organization", async () => {
      signInAs(memberRoleUid);
      expect(
        await createVendorAction(orgA.id, {}, form({ name: "snoop" })),
      ).toEqual({ message: "Not found." });
      expect(await createExpenseAction(orgA.id, {}, expenseForm())).toEqual({
        message: "Not found.",
      });
      expect(
        await updateVendorAction(vendorB.id, {}, form({ name: "snoop" })),
      ).toEqual({ message: "Not found." });
      expect(await transitionExpenseAction(expenseB.id, "SUBMITTED")).toEqual({
        message: "Not found.",
      });
      expect(
        await setExpenseReimbursementAction(
          expenseB.id,
          {},
          form({ status: "REIMBURSED" }),
        ),
      ).toEqual({ message: "Not found." });
      // Nothing was written.
      expect(
        await prisma.expenseEvent.count({ where: { expenseId: expenseB.id } }),
      ).toBe(1); // only EXPENSE_CREATED
    });

    it("denies an org-A admin against every org-B vendor/expense surface", async () => {
      signInAs(adminAUid);
      // Create-scoped surfaces: org B in the URL never buys a grant.
      expect(
        await createVendorAction(orgB.id, {}, form({ name: "hijack" })),
      ).toEqual({ message: "Not found." });
      expect(await createExpenseAction(orgB.id, {}, expenseForm())).toEqual({
        message: "Not found.",
      });
      // Record-scoped surfaces resolve the record's own org.
      expect(
        await updateVendorAction(vendorB.id, {}, form({ name: "hijack" })),
      ).toEqual({ message: "Not found." });
      expect(await setVendorStatusAction(vendorB.id, "INACTIVE")).toEqual({
        message: "Not found.",
      });
      expect(await updateExpenseAction(expenseB.id, {}, expenseForm())).toEqual(
        { message: "Not found." },
      );
      expect(await transitionExpenseAction(expenseB.id, "SUBMITTED")).toEqual({
        message: "Not found.",
      });
      expect(
        await rejectExpenseAction(expenseB.id, {}, form({ note: "no" })),
      ).toEqual({ message: "Not found." });
      expect(
        await setExpenseReimbursementAction(
          expenseB.id,
          {},
          form({ status: "PENDING" }),
        ),
      ).toEqual({ message: "Not found." });
      // Context-link surfaces: adding to a foreign expense, or removing
      // a foreign link row, is equally opaque.
      expect(
        await addExpenseLinkAction(
          expenseB.id,
          {},
          form({ kind: "ASSET", targetId: assetA.id }),
        ),
      ).toEqual({ message: "Not found." });
      expect(await removeExpenseLinkAction("ASSET", expenseLinkB.id)).toEqual({
        message: "Not found.",
      });

      const unchanged = await prisma.expense.findUniqueOrThrow({
        where: { id: expenseB.id },
      });
      expect(unchanged.status).toBe("DRAFT");
      const vendorUnchanged = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorB.id },
      });
      expect(vendorUnchanged.name).toContain("vendor-b");
      expect(vendorUnchanged.status).toBe("ACTIVE");
    });

    it("treats a foreign expense id identically to a nonexistent one", async () => {
      signInAs(adminAUid);
      const missing = await transitionExpenseAction(
        "nonexistent-id",
        "SUBMITTED",
      );
      const foreign = await transitionExpenseAction(expenseB.id, "SUBMITTED");
      expect(missing).toEqual({ message: "Not found." });
      expect(missing).toEqual(foreign);
    });

    it("lets the org-A admin manage org-A vendors and expenses", async () => {
      signInAs(adminAUid);
      expect(
        await createVendorAction(orgA.id, {}, form({ name: uniq("v-ok") })),
      ).toEqual({});
      // createExpenseAction redirects to the new record on success.
      await expect(
        createExpenseAction(orgA.id, {}, expenseForm()),
      ).rejects.toThrow(/NEXT_REDIRECT .*\/expenses\//);
      const mine = await prisma.expense.findFirstOrThrow({
        where: { organizationId: orgA.id },
        orderBy: { createdAt: "desc" },
      });
      expect(mine.createdByAuthIdentityId).toBe(adminAIdentityId);
      expect(await transitionExpenseAction(mine.id, "SUBMITTED")).toEqual({});
      const row = await prisma.expense.findUniqueOrThrow({
        where: { id: mine.id },
      });
      expect(row.status).toBe("SUBMITTED");
    });
  });
});
