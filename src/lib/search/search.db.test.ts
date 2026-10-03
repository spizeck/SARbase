import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthContext } from "@/lib/auth/context";
import { prisma } from "@/lib/prisma";

import { searchOrganizationRecords } from "./search";
import type { SearchResultType } from "./types";

/**
 * Database-backed global-search tests (issue #18) — `npm run test:db`
 * only (TEST_DATABASE_URL). Distinct org-name prefix: files may run on
 * parallel workers, so cleanup must never touch another suite's rows.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "searchtest-";

let counter = 0;
function uniqueName(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

function ctxFor(organizationId: string, role: "ADMIN" | "MEMBER"): AuthContext {
  const identity = {
    id: `${PREFIX}identity-${role}-${organizationId}`,
    provider: "test",
    providerUid: `${PREFIX}${role}`,
    email: null,
    status: "ACTIVE" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return {
    identity,
    members: [],
    access: [
      {
        id: `${PREFIX}access-${role}-${organizationId}`,
        organizationId,
        authIdentityId: identity.id,
        role,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  };
}

function typesOf(
  outcome: Awaited<ReturnType<typeof searchOrganizationRecords>>,
) {
  return outcome.groups.map((g) => g.type);
}

function resultsOf(
  outcome: Awaited<ReturnType<typeof searchOrganizationRecords>>,
  type: SearchResultType,
) {
  return outcome.groups.find((g) => g.type === type)?.results ?? [];
}

const ACTOR = `${PREFIX}actor`;

describe.skipIf(!hasDb)("global organization search", () => {
  let orgA = "";
  let orgB = "";
  const ids = {
    member: "",
    otherMember: "",
    asset: "",
    incident: "",
    callout: "",
    document: "",
    attachment: "",
    foreignMember: "",
  };

  beforeAll(async () => {
    const a = await prisma.organization.create({
      data: { name: uniqueName("org-a") },
    });
    const b = await prisma.organization.create({
      data: { name: uniqueName("org-b") },
    });
    orgA = a.id;
    orgB = b.id;

    const unit = await prisma.unit.create({
      data: { organizationId: orgA, name: `${PREFIX}north-station` },
    });

    const member = await prisma.member.create({
      data: {
        organizationId: orgA,
        displayName: `${PREFIX}Nadia Okafor`,
        email: `${PREFIX}nadia@example.test`,
      },
    });
    ids.member = member.id;
    await prisma.memberUnit.create({
      data: { organizationId: orgA, memberId: member.id, unitId: unit.id },
    });
    const otherMember = await prisma.member.create({
      data: {
        organizationId: orgA,
        displayName: `${PREFIX}Kellan Byrne`,
        status: "INACTIVE",
      },
    });
    ids.otherMember = otherMember.id;

    // Same-name member + same-name asset in the OTHER organization —
    // cross-org leakage probes below rely on these existing.
    const foreignMember = await prisma.member.create({
      data: { organizationId: orgB, displayName: `${PREFIX}Nadia Okafor` },
    });
    ids.foreignMember = foreignMember.id;

    const definition = await prisma.qualificationDefinition.create({
      data: {
        organizationId: orgA,
        name: `${PREFIX}Swiftwater Rescue Technician`,
      },
    });
    await prisma.memberQualification.create({
      data: {
        organizationId: orgA,
        memberId: member.id,
        definitionId: definition.id,
        issuer: "Rescue 3 International",
        reference: `${PREFIX}R3-8811`,
      },
    });

    const event = await prisma.trainingEvent.create({
      data: {
        organizationId: orgA,
        title: `${PREFIX}Night navigation exercise`,
        date: new Date("2026-09-10T00:00:00.000Z"),
        location: "Point Reyes",
        instructorName: "Casey Duran",
      },
    });
    await prisma.trainingTopic.create({
      data: {
        organizationId: orgA,
        trainingEventId: event.id,
        label: `${PREFIX}chart plotting`,
      },
    });

    const boathouse = await prisma.storageLocation.create({
      data: { organizationId: orgA, name: `${PREFIX}boathouse` },
    });
    const locker = await prisma.storageLocation.create({
      data: {
        organizationId: orgA,
        parentLocationId: boathouse.id,
        name: `${PREFIX}rope-locker`,
      },
    });

    const asset = await prisma.asset.create({
      data: {
        organizationId: orgA,
        unitId: unit.id,
        storageLocationId: boathouse.id,
        name: `${PREFIX}Rescue Boat 1`,
        category: "Vessel",
        serialNumber: `${PREFIX}SN-4471`,
        assetTag: `${PREFIX}RB-1`,
      },
    });
    ids.asset = asset.id;
    await prisma.asset.create({
      data: { organizationId: orgB, name: `${PREFIX}Rescue Boat 1` },
    });

    await prisma.inventoryItem.create({
      data: {
        organizationId: orgA,
        storageLocationId: locker.id,
        name: `${PREFIX}3/8 double-braid line`,
        category: "Rope",
        quantity: "600",
        unitOfMeasure: "ft",
      },
    });
    await prisma.inventoryItem.create({
      data: {
        organizationId: orgA,
        name: `${PREFIX}Handheld flares`,
        category: "Pyrotechnics",
        quantity: "6",
        unitOfMeasure: "each",
        vendor: "Example Chandlery",
      },
    });

    const inspection = await prisma.inspectionDefinition.create({
      data: { organizationId: orgA, name: `${PREFIX}monthly vessel check` },
    });
    await prisma.inspectionRecord.create({
      data: {
        organizationId: orgA,
        assetId: asset.id,
        definitionId: inspection.id,
        performedOn: new Date("2026-09-15T00:00:00.000Z"),
        notes: `${PREFIX}rudder pin shows wear`,
      },
    });

    const plan = await prisma.maintenancePlan.create({
      data: {
        organizationId: orgA,
        assetId: asset.id,
        name: `${PREFIX}engine oil change`,
      },
    });
    await prisma.maintenanceRecord.create({
      data: {
        organizationId: orgA,
        assetId: asset.id,
        planId: plan.id,
        performedOn: new Date("2026-09-01T00:00:00.000Z"),
        title: `${PREFIX}engine oil change`,
        providerName: `${PREFIX}Seaside Marine Works`,
      },
    });

    await prisma.defect.create({
      data: {
        organizationId: orgA,
        assetId: asset.id,
        reportedOn: new Date("2026-09-20T00:00:00.000Z"),
        title: `${PREFIX}bilge pump intermittent`,
        description: `${PREFIX}pump stalls after a few minutes`,
      },
    });

    const callout = await prisma.callout.create({
      data: {
        organizationId: orgA,
        createdByAuthIdentityId: ACTOR,
        audience: "ORGANIZATION",
        title: `${PREFIX}missing kayaker`,
        message: `${PREFIX}responders needed near the point`,
        activationKey: `${PREFIX}callout-1`,
        intentHash: `${PREFIX}intent-1`,
      },
    });
    ids.callout = callout.id;

    const incident = await prisma.incident.create({
      data: {
        organizationId: orgA,
        sequence: 1,
        reference: `${PREFIX}INC-7`,
        title: `${PREFIX}overdue sailor`,
        summary: `${PREFIX}single-handed sailor reported overdue`,
        status: "OPEN",
        createdByAuthIdentityId: ACTOR,
      },
    });
    ids.incident = incident.id;
    await prisma.incidentNote.create({
      data: {
        organizationId: orgA,
        incidentId: incident.id,
        authorAuthIdentityId: ACTOR,
        body: `${PREFIX}casualty located at the cove`,
      },
    });

    const document = await prisma.organizationDocument.create({
      data: {
        organizationId: orgA,
        title: `${PREFIX}vessel insurance certificate`,
        category: "Insurance",
        createdByAuthIdentityId: ACTOR,
      },
    });
    ids.document = document.id;

    const attachment = await prisma.attachment.create({
      data: {
        organizationId: orgA,
        displayFilename: `${PREFIX}engine-manual.pdf`,
        mediaType: "application/pdf",
        sizeBytes: 1234,
        storageProvider: "fake",
        storageKey: `${PREFIX}storage-key`,
        checksumSha256: `${PREFIX}checksum`,
        uploadedByAuthIdentityId: ACTOR,
      },
    });
    ids.attachment = attachment.id;
    await prisma.assetAttachment.create({
      data: {
        organizationId: orgA,
        assetId: asset.id,
        attachmentId: attachment.id,
        createdByAuthIdentityId: ACTOR,
      },
    });
  });

  afterAll(async () => {
    const orgFilter = { organization: { name: { startsWith: PREFIX } } };
    // Link/audit/child tables first — Restrict FKs protect parents.
    await prisma.incidentNoteAttachment.deleteMany({ where: orgFilter });
    await prisma.incidentAttachment.deleteMany({ where: orgFilter });
    await prisma.memberQualificationAttachment.deleteMany({
      where: orgFilter,
    });
    await prisma.trainingEventAttachment.deleteMany({ where: orgFilter });
    await prisma.assetAttachment.deleteMany({ where: orgFilter });
    await prisma.inspectionRecordAttachment.deleteMany({ where: orgFilter });
    await prisma.maintenanceRecordAttachment.deleteMany({ where: orgFilter });
    await prisma.defectAttachment.deleteMany({ where: orgFilter });
    await prisma.organizationDocumentVersion.deleteMany({ where: orgFilter });
    await prisma.incidentNoteCorrection.deleteMany({ where: orgFilter });
    await prisma.incidentNote.deleteMany({ where: orgFilter });
    await prisma.incidentTimelineEvent.deleteMany({ where: orgFilter });
    await prisma.incidentChange.deleteMany({ where: orgFilter });
    await prisma.incidentMember.deleteMany({ where: orgFilter });
    await prisma.incidentAsset.deleteMany({ where: orgFilter });
    await prisma.incident.deleteMany({ where: orgFilter });
    await prisma.calloutResponseChange.deleteMany({ where: orgFilter });
    await prisma.calloutInvitation.deleteMany({ where: orgFilter });
    await prisma.callout.deleteMany({ where: orgFilter });
    await prisma.attachmentEvent.deleteMany({ where: orgFilter });
    await prisma.attachment.deleteMany({ where: orgFilter });
    await prisma.organizationDocument.deleteMany({ where: orgFilter });
    await prisma.inspectionRecordChange.deleteMany({ where: orgFilter });
    await prisma.inspectionRecord.deleteMany({ where: orgFilter });
    await prisma.maintenanceRecordChange.deleteMany({ where: orgFilter });
    await prisma.maintenanceRecord.deleteMany({ where: orgFilter });
    await prisma.defectChange.deleteMany({ where: orgFilter });
    await prisma.defect.deleteMany({ where: orgFilter });
    await prisma.assetMeterReading.deleteMany({ where: orgFilter });
    await prisma.assetMeter.deleteMany({ where: orgFilter });
    await prisma.maintenancePlan.deleteMany({ where: orgFilter });
    await prisma.inspectionDefinition.deleteMany({ where: orgFilter });
    // TrainingTopic/Attendance(+Change)/MemberQualification/MemberUnit
    // carry organizationId but expose no `organization` relation —
    // filter through their parents.
    await prisma.trainingAttendanceChange.deleteMany({
      where: { event: { organization: { name: { startsWith: PREFIX } } } },
    });
    await prisma.trainingAttendance.deleteMany({
      where: { event: { organization: { name: { startsWith: PREFIX } } } },
    });
    await prisma.trainingTopic.deleteMany({
      where: { event: { organization: { name: { startsWith: PREFIX } } } },
    });
    await prisma.trainingEvent.deleteMany({ where: orgFilter });
    await prisma.memberQualification.deleteMany({
      where: { member: { organization: { name: { startsWith: PREFIX } } } },
    });
    await prisma.qualificationDefinition.deleteMany({ where: orgFilter });
    await prisma.memberAvailabilityUpdate.deleteMany({ where: orgFilter });
    await prisma.memberNotificationPreference.deleteMany({
      where: orgFilter,
    });
    await prisma.notificationAttempt.deleteMany({ where: orgFilter });
    await prisma.notification.deleteMany({ where: orgFilter });
    await prisma.memberUnit.deleteMany({
      where: { member: { organization: { name: { startsWith: PREFIX } } } },
    });
    // Break self/container edges before deleting parents.
    await prisma.asset.updateMany({
      where: orgFilter,
      data: { parentAssetId: null, storageLocationId: null, unitId: null },
    });
    await prisma.storageLocation.updateMany({
      where: orgFilter,
      data: { parentLocationId: null, containingAssetId: null },
    });
    await prisma.inventoryItem.deleteMany({ where: orgFilter });
    await prisma.asset.deleteMany({ where: orgFilter });
    await prisma.storageLocation.deleteMany({ where: orgFilter });
    await prisma.member.deleteMany({ where: orgFilter });
    await prisma.unit.deleteMany({ where: orgFilter });
    await prisma.organizationAccess.deleteMany({ where: orgFilter });
    await prisma.incidentSequence.deleteMany({ where: orgFilter });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  describe("matching", () => {
    it("finds a member by exact name, case-insensitively", async () => {
      const outcome = await searchOrganizationRecords(
        ctxFor(orgA, "ADMIN"),
        orgA,
        `${PREFIX}NADIA OKAFOR`,
      );
      const members = resultsOf(outcome, "member");
      expect(members.map((m) => m.id)).toContain(ids.member);
      expect(members[0]?.title).toContain("Nadia Okafor");
    });

    it("finds a member by prefix", async () => {
      const outcome = await searchOrganizationRecords(
        ctxFor(orgA, "ADMIN"),
        orgA,
        `${PREFIX}nad`,
      );
      expect(resultsOf(outcome, "member").map((m) => m.id)).toContain(
        ids.member,
      );
    });

    it("finds '3/8 line' via token matching", async () => {
      const outcome = await searchOrganizationRecords(
        ctxFor(orgA, "ADMIN"),
        orgA,
        "3/8 line",
      );
      const inventory = resultsOf(outcome, "inventory");
      expect(
        inventory.some((r) => r.title.includes("3/8 double-braid line")),
      ).toBe(true);
    });

    it("finds an asset by tag and by serial number", async () => {
      const byTag = await searchOrganizationRecords(
        ctxFor(orgA, "ADMIN"),
        orgA,
        `${PREFIX}RB-1`,
      );
      expect(resultsOf(byTag, "asset").map((r) => r.id)).toContain(ids.asset);

      const bySerial = await searchOrganizationRecords(
        ctxFor(orgA, "ADMIN"),
        orgA,
        "SN-4471",
      );
      expect(resultsOf(bySerial, "asset").map((r) => r.id)).toContain(
        ids.asset,
      );
    });

    it("finds flares and a maintenance vendor", async () => {
      const flares = await searchOrganizationRecords(
        ctxFor(orgA, "ADMIN"),
        orgA,
        "flares",
      );
      expect(
        resultsOf(flares, "inventory").some((r) =>
          r.title.includes("Handheld flares"),
        ),
      ).toBe(true);

      const vendor = await searchOrganizationRecords(
        ctxFor(orgA, "ADMIN"),
        orgA,
        "Seaside Marine",
      );
      expect(
        resultsOf(vendor, "maintenance").some((r) =>
          r.title.includes("engine oil"),
        ),
      ).toBe(true);
    });

    it("finds an incident by reference and by note text", async () => {
      const byRef = await searchOrganizationRecords(
        ctxFor(orgA, "ADMIN"),
        orgA,
        `${PREFIX}INC-7`,
      );
      const incidents = resultsOf(byRef, "incident");
      expect(incidents.map((r) => r.id)).toContain(ids.incident);
      expect(incidents[0]?.title).toContain("INC-7");

      const byNote = await searchOrganizationRecords(
        ctxFor(orgA, "ADMIN"),
        orgA,
        "casualty located",
      );
      const noteHit = resultsOf(byNote, "incident").find(
        (r) => r.id === ids.incident,
      );
      expect(noteHit).toBeTruthy();
      expect(noteHit?.snippet).toContain("casualty");
    });

    it("finds storage locations, defects, callouts, documents, and attachments", async () => {
      const admin = ctxFor(orgA, "ADMIN");

      const loc = await searchOrganizationRecords(admin, orgA, "rope-locker");
      expect(resultsOf(loc, "location").length).toBeGreaterThan(0);

      const defect = await searchOrganizationRecords(
        admin,
        orgA,
        "pump stalls",
      );
      expect(
        resultsOf(defect, "defect").some((r) => r.title.includes("bilge")),
      ).toBe(true);

      const callout = await searchOrganizationRecords(admin, orgA, "kayaker");
      expect(resultsOf(callout, "callout").map((r) => r.id)).toContain(
        ids.callout,
      );

      const doc = await searchOrganizationRecords(
        admin,
        orgA,
        "insurance certificate",
      );
      expect(resultsOf(doc, "document").map((r) => r.id)).toContain(
        ids.document,
      );

      const att = await searchOrganizationRecords(admin, orgA, "engine-manual");
      const attachments = resultsOf(att, "attachment");
      expect(attachments.map((r) => r.id)).toContain(ids.attachment);
      // The link resolves to the asset page the file is attached to.
      expect(attachments[0]?.href).toBe(`/admin/assets/${ids.asset}`);
    });

    it("returns nothing for a non-matching query", async () => {
      const outcome = await searchOrganizationRecords(
        ctxFor(orgA, "ADMIN"),
        orgA,
        "zz-no-such-record-zz",
      );
      expect(outcome.groups).toEqual([]);
      expect(outcome.totalCount).toBe(0);
    });
  });

  describe("authorization", () => {
    it("returns every domain group to an org ADMIN", async () => {
      const outcome = await searchOrganizationRecords(
        ctxFor(orgA, "ADMIN"),
        orgA,
        PREFIX,
      );
      for (const t of [
        "member",
        "unit",
        "qualification",
        "training",
        "asset",
        "inventory",
        "location",
        "inspection",
        "maintenance",
        "defect",
        "incident",
        "callout",
        "document",
        "attachment",
      ] as const) {
        expect(typesOf(outcome), `expected ${t} group`).toContain(t);
      }
    });

    it("returns nothing at all to a MEMBER — no record domain is member-visible", async () => {
      const outcome = await searchOrganizationRecords(
        ctxFor(orgA, "MEMBER"),
        orgA,
        "Nadia",
      );
      expect(outcome.accepted).toBe(true);
      expect(outcome.groups).toEqual([]);
      expect(outcome.totalCount).toBe(0);
    });

    it("returns nothing to an identity with no access to the org", async () => {
      const outcome = await searchOrganizationRecords(
        ctxFor(orgB, "ADMIN"), // admin of a different org
        orgA,
        "Nadia",
      );
      expect(outcome.groups).toEqual([]);
    });

    it("never leaks foreign-org records, including same-name rows", async () => {
      const outcome = await searchOrganizationRecords(
        ctxFor(orgA, "ADMIN"),
        orgA,
        "Nadia Okafor",
      );
      const memberIds = resultsOf(outcome, "member").map((m) => m.id);
      expect(memberIds).toContain(ids.member);
      expect(memberIds).not.toContain(ids.foreignMember);
    });

    it("hides incident results from a MEMBER even when text matches", async () => {
      const outcome = await searchOrganizationRecords(
        ctxFor(orgA, "MEMBER"),
        orgA,
        `${PREFIX}INC-7`,
      );
      expect(resultsOf(outcome, "incident")).toEqual([]);
      expect(outcome.totalCount).toBe(0);
    });
  });

  describe("ranking", () => {
    it("ranks an exact match above a phrase match, deterministically", async () => {
      // "${PREFIX}rope-locker" exact-matches the location's name; the
      // same query only phrase/topic-matches nothing else in the group.
      const outcome = await searchOrganizationRecords(
        ctxFor(orgA, "ADMIN"),
        orgA,
        `${PREFIX}rope-locker`,
      );
      const locations = resultsOf(outcome, "location");
      expect(locations.length).toBeGreaterThan(0);
      expect(locations[0]?.title).toBe(`${PREFIX}rope-locker`);
    });

    it("repeats the same ordering for the same query", async () => {
      const admin = ctxFor(orgA, "ADMIN");
      const first = await searchOrganizationRecords(admin, orgA, PREFIX);
      const second = await searchOrganizationRecords(admin, orgA, PREFIX);
      expect(
        second.groups.map((g) => [g.type, g.results.map((r) => r.id)]),
      ).toEqual(first.groups.map((g) => [g.type, g.results.map((r) => r.id)]));
    });

    it("returns an exact match even when the contains scan overflows", async () => {
      // Regression for the scan-limit starvation bug: the contains
      // query takes 50 rows in fixed order — an exact match that sorts
      // past the cut must still reach the ranker via the exact pass.
      const deep = await prisma.organization.create({
        data: { name: uniqueName("deep-org") },
      });
      const ref = uniqueName("INC-7");
      const exact = await prisma.incident.create({
        data: {
          organizationId: deep.id,
          sequence: 1,
          reference: ref,
          title: "the one that must surface",
          createdByAuthIdentityId: ACTOR,
        },
      });
      // 60 fillers that all contains-match the reference token and are
      // newer than the exact row — the fixed createdAt-desc scan would
      // cut the exact match without the separate exact pass.
      await prisma.incident.createMany({
        data: Array.from({ length: 60 }, (_, i) => ({
          organizationId: deep.id,
          sequence: i + 2,
          reference: `${ref}0-${i}`,
          title: `filler ${i}`,
          createdByAuthIdentityId: ACTOR,
        })),
      });

      const outcome = await searchOrganizationRecords(
        ctxFor(deep.id, "ADMIN"),
        deep.id,
        ref,
      );
      const incidents = resultsOf(outcome, "incident");
      expect(incidents.length).toBeGreaterThan(0);
      expect(incidents[0]?.id).toBe(exact.id);
    });
  });

  describe("query safety", () => {
    const admin = () => ctxFor(orgA, "ADMIN");

    it("treats SQL-looking input as literal text", async () => {
      const outcome = await searchOrganizationRecords(
        admin(),
        orgA,
        `'; DROP TABLE "Member";--`,
      );
      expect(outcome.groups).toEqual([]);
      // Table still there.
      expect(await prisma.member.count()).toBeGreaterThan(0);
    });

    it("treats %, _, and quotes literally, not as LIKE wildcards", async () => {
      const percent = await searchOrganizationRecords(
        admin(),
        orgA,
        "100% members",
      );
      expect(percent.groups).toEqual([]);

      const underscored = await searchOrganizationRecords(
        admin(),
        orgA,
        "Nadia_Okafor",
      );
      // '_' is literal — the stored name uses a space, so no match.
      expect(resultsOf(underscored, "member")).toEqual([]);
    });

    it("handles quotes and backslashes without error", async () => {
      const outcome = await searchOrganizationRecords(
        admin(),
        orgA,
        `it's "quoted" \\`,
      );
      expect(outcome.accepted).toBe(true);
    });

    it("rejects empty, whitespace, and single-character queries", async () => {
      for (const bad of ["", "   ", "x"]) {
        const outcome = await searchOrganizationRecords(admin(), orgA, bad);
        expect(outcome.accepted).toBe(false);
        expect(outcome.groups).toEqual([]);
      }
    });

    it("handles a query longer than the maximum without error", async () => {
      const outcome = await searchOrganizationRecords(
        admin(),
        orgA,
        "long".repeat(200),
      );
      expect(outcome.accepted).toBe(true);
      expect(outcome.normalizedQuery.length).toBeLessThanOrEqual(100);
    });

    it("respects a valid type filter and ignores an invalid one", async () => {
      const scoped = await searchOrganizationRecords(admin(), orgA, "Nadia", {
        type: "member",
      });
      expect(typesOf(scoped)).toEqual(["member"]);

      const invalid = await searchOrganizationRecords(admin(), orgA, "Nadia", {
        type: "not-a-type",
      });
      // Invalid filters widen to all domains rather than guessing.
      expect(typesOf(invalid)).toContain("member");
    });
  });

  describe("performance", () => {
    it("searches a realistically sized dataset within a generous bound", async () => {
      const perf = await prisma.organization.create({
        data: { name: uniqueName("perf-org") },
      });
      const bulkPrefix = `${PREFIX}bulk-`;
      await prisma.member.createMany({
        data: Array.from({ length: 400 }, (_, i) => ({
          organizationId: perf.id,
          displayName: `${bulkPrefix}member-${i}`,
        })),
      });
      await prisma.asset.createMany({
        data: Array.from({ length: 400 }, (_, i) => ({
          organizationId: perf.id,
          name: `${bulkPrefix}asset-${i}`,
          serialNumber: `${bulkPrefix}sn-${i}`,
          notes: `${bulkPrefix}notes about asset ${i} maintenance history`,
        })),
      });
      await prisma.inventoryItem.createMany({
        data: Array.from({ length: 200 }, (_, i) => ({
          organizationId: perf.id,
          name: `${bulkPrefix}item-${i}`,
          quantity: "1",
        })),
      });
      await prisma.incident.createMany({
        data: Array.from({ length: 200 }, (_, i) => ({
          organizationId: perf.id,
          sequence: i + 1,
          reference: `${bulkPrefix}INC-${i}`,
          title: `${bulkPrefix}incident ${i}`,
          summary: `${bulkPrefix}summary of incident ${i}`,
          createdByAuthIdentityId: ACTOR,
        })),
      });
      await prisma.trainingEvent.createMany({
        data: Array.from({ length: 150 }, (_, i) => ({
          organizationId: perf.id,
          title: `${bulkPrefix}training ${i}`,
          date: new Date("2026-01-01T00:00:00.000Z"),
        })),
      });

      const admin = ctxFor(perf.id, "ADMIN");
      const startedAt = performance.now();
      const outcome = await searchOrganizationRecords(
        admin,
        perf.id,
        `${bulkPrefix}asset-3`,
      );
      const elapsed = performance.now() - startedAt;

      expect(resultsOf(outcome, "asset").length).toBeGreaterThan(0);
      // Generous threshold — this guards "accidentally quadratic"
      // regressions, not microbenchmarks. Observed locally: well under
      // 1s against ~1350 rows in one org.
      expect(elapsed).toBeLessThan(10_000);
    });
  });
});
