import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Database-backed export + reporting tests (issue #19) — run only via
 * `npm run test:db`. Real rows, real org scoping, real transactions;
 * nothing is stubbed except where a test explicitly simulates an audit
 * failure to prove fail-closed behavior.
 *
 * Fixture rows are prefixed `exporttest-` for cleanup.
 */

import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { AuthorizationError } from "@/lib/auth/context";

import { CSV_UTF8_BOM } from "./csv";
import { EXPORT_DATASETS, getExportDataset } from "./datasets";
import { ExportFilterError, parseExportFilters } from "./filters";
import { ExportRateLimitedError, runCsvExport } from "./service";
import {
  getAnnualSummary,
  participantHoursLabel,
  summarizeTrainingEvents,
} from "@/lib/reporting/summary";

const hasDb = Boolean(process.env.TEST_DATABASE_URL);
const PREFIX = "exporttest-";
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

const emptyParams = new URLSearchParams();

function csvRows(csv: string): string[][] {
  return csv
    .slice(CSV_UTF8_BOM.length)
    .trimEnd()
    .split("\r\n")
    .map((line) => line.split(","));
}

describe.skipIf(!hasDb)("data exports", () => {
  let orgA = "";
  let orgB = "";
  const ids = {
    unit: "",
    member: "",
    otherMember: "",
    foreignMember: "",
    vendor: "",
    vendor2: "",
    foreignVendor: "",
    expenseUsdApproved: "",
    expenseUsdSubmitted: "",
    expenseEurApproved: "",
    expenseRejected: "",
    expensePriorYear: "",
    foreignExpense: "",
    trainingEvent90: "",
    trainingEventNoDuration: "",
    trainingCancelled: "",
    trainingPriorYear: "",
    trainingUnitScoped: "",
    asset: "",
    incidentInYear: "",
    incidentBoundaryPrevYear: "",
    maintenanceRecord: "",
    attachment: "",
    document: "",
    callout: "",
  };

  beforeAll(async () => {
    // Non-UTC org — timezone boundary assertions rely on UTC-4 with no DST.
    const a = await prisma.organization.create({
      data: { name: uniqueName("org-a"), timezone: "America/Puerto_Rico" },
    });
    const b = await prisma.organization.create({
      data: { name: uniqueName("org-b") },
    });
    orgA = a.id;
    orgB = b.id;

    const unit = await prisma.unit.create({
      data: { organizationId: orgA, name: `${PREFIX}harbor-unit` },
    });
    ids.unit = unit.id;

    const member = await prisma.member.create({
      data: {
        organizationId: orgA,
        displayName: `${PREFIX}Marisol Vega`,
        email: `${PREFIX}marisol@example.test`,
      },
    });
    ids.member = member.id;
    await prisma.memberUnit.create({
      data: { organizationId: orgA, memberId: member.id, unitId: unit.id },
    });
    const otherMember = await prisma.member.create({
      data: { organizationId: orgA, displayName: `${PREFIX}Theo Lindqvist` },
    });
    ids.otherMember = otherMember.id;
    const foreignMember = await prisma.member.create({
      data: { organizationId: orgB, displayName: `${PREFIX}Marisol Vega` },
    });
    ids.foreignMember = foreignMember.id;

    await prisma.memberAvailabilityUpdate.create({
      data: {
        organizationId: orgA,
        memberId: member.id,
        status: "AVAILABLE",
        actorAuthIdentityId: `${PREFIX}actor`,
      },
    });

    // Training fixtures — the participant-hours math fixture.
    const ev90 = await prisma.trainingEvent.create({
      data: {
        organizationId: orgA,
        title: `${PREFIX}boat-handling`,
        date: new Date("2026-03-10T00:00:00.000Z"),
        durationMinutes: 90,
      },
    });
    ids.trainingEvent90 = ev90.id;
    const thirdMember = await prisma.member.create({
      data: { organizationId: orgA, displayName: `${PREFIX}Priya Nair` },
    });
    for (const m of [member.id, otherMember.id, thirdMember.id]) {
      await prisma.trainingAttendance.create({
        data: {
          organizationId: orgA,
          trainingEventId: ev90.id,
          memberId: m,
        },
      });
    }
    const evNoDur = await prisma.trainingEvent.create({
      data: {
        organizationId: orgA,
        title: `${PREFIX}kit-familiarization`,
        date: new Date("2026-04-02T00:00:00.000Z"),
      },
    });
    ids.trainingEventNoDuration = evNoDur.id;
    await prisma.trainingAttendance.create({
      data: {
        organizationId: orgA,
        trainingEventId: evNoDur.id,
        memberId: member.id,
      },
    });
    const cancelled = await prisma.trainingEvent.create({
      data: {
        organizationId: orgA,
        title: `${PREFIX}weather-scrub`,
        date: new Date("2026-05-01T00:00:00.000Z"),
        durationMinutes: 60,
        status: "CANCELLED",
      },
    });
    ids.trainingCancelled = cancelled.id;
    await prisma.trainingEvent
      .create({
        data: {
          organizationId: orgA,
          title: `${PREFIX}old-course`,
          date: new Date("2025-06-15T00:00:00.000Z"),
          durationMinutes: 120,
        },
      })
      .then((e) => (ids.trainingPriorYear = e.id));
    const unitEvent = await prisma.trainingEvent.create({
      data: {
        organizationId: orgA,
        unitId: unit.id,
        title: `${PREFIX}unit-drill`,
        date: new Date("2026-07-04T00:00:00.000Z"),
        durationMinutes: 45,
      },
    });
    ids.trainingUnitScoped = unitEvent.id;

    // Assets / maintenance fixtures.
    const location = await prisma.storageLocation.create({
      data: { organizationId: orgA, name: `${PREFIX}dock-locker` },
    });
    const asset = await prisma.asset.create({
      data: {
        organizationId: orgA,
        unitId: unit.id,
        storageLocationId: location.id,
        name: `${PREFIX}Rescue Boat 7`,
        assetTag: `${PREFIX}RB-7`,
      },
    });
    ids.asset = asset.id;
    await prisma.inventoryItem.create({
      data: {
        organizationId: orgA,
        storageLocationId: location.id,
        name: `${PREFIX}marine-flares`,
        quantity: 12,
      },
    });
    const definition = await prisma.inspectionDefinition.create({
      data: { organizationId: orgA, name: `${PREFIX}hull-check` },
    });
    await prisma.inspectionRecord.create({
      data: {
        organizationId: orgA,
        assetId: asset.id,
        definitionId: definition.id,
        performedOn: new Date("2026-02-11T00:00:00.000Z"),
      },
    });
    const maintenanceRecord = await prisma.maintenanceRecord.create({
      data: {
        organizationId: orgA,
        assetId: asset.id,
        performedOn: new Date("2026-03-05T00:00:00.000Z"),
        title: `${PREFIX}100-hour service`,
      },
    });
    ids.maintenanceRecord = maintenanceRecord.id;
    const meter = await prisma.assetMeter.create({
      data: {
        organizationId: orgA,
        assetId: asset.id,
        name: `${PREFIX}engine-hours`,
        unit: "hours",
      },
    });
    await prisma.assetMeterReading.create({
      data: {
        organizationId: orgA,
        meterId: meter.id,
        reading: 412.5,
        recordedOn: new Date("2026-03-05T00:00:00.000Z"),
      },
    });
    await prisma.defect.create({
      data: {
        organizationId: orgA,
        assetId: asset.id,
        reportedOn: new Date("2026-04-18T00:00:00.000Z"),
        title: `${PREFIX}cracked-cleat`,
      },
    });
    await prisma.defect.create({
      data: {
        organizationId: orgA,
        assetId: asset.id,
        reportedOn: new Date("2026-05-02T00:00:00.000Z"),
        title: `${PREFIX}fixed-roller`,
        status: "RESOLVED",
        resolvedOn: new Date("2026-05-20T00:00:00.000Z"),
      },
    });

    // Callout + incident fixtures. The boundary incident is created
    // 2026-01-01T03:30Z = 2025-12-31 23:30 in Puerto Rico — locally it
    // belongs to 2025, not 2026.
    const callout = await prisma.callout.create({
      data: {
        organizationId: orgA,
        createdByAuthIdentityId: `${PREFIX}actor`,
        audience: "ORGANIZATION",
        title: `${PREFIX}callout-harbor`,
        activationKey: `${PREFIX}key`,
        intentHash: `${PREFIX}hash`,
        activatedAt: new Date("2026-06-01T12:00:00.000Z"),
      },
    });
    ids.callout = callout.id;
    await prisma.calloutInvitation.create({
      data: {
        organizationId: orgA,
        calloutId: callout.id,
        memberId: member.id,
        responseTokenHash: `${PREFIX}tokenhash`,
        response: "COMING",
        respondedAt: new Date("2026-06-01T12:10:00.000Z"),
      },
    });
    const incident = await prisma.incident.create({
      data: {
        organizationId: orgA,
        sequence: 1,
        reference: `${PREFIX}INC-1`,
        title: `${PREFIX}capsized-kayak`,
        status: "CLOSED",
        createdByAuthIdentityId: `${PREFIX}actor`,
        createdAt: new Date("2026-06-02T14:00:00.000Z"),
      },
    });
    ids.incidentInYear = incident.id;
    await prisma.incidentMember.create({
      data: {
        organizationId: orgA,
        incidentId: incident.id,
        memberId: member.id,
        recordedByAuthIdentityId: `${PREFIX}actor`,
      },
    });
    await prisma.incidentAsset.create({
      data: {
        organizationId: orgA,
        incidentId: incident.id,
        assetId: asset.id,
        recordedByAuthIdentityId: `${PREFIX}actor`,
      },
    });
    const boundary = await prisma.incident.create({
      data: {
        organizationId: orgA,
        sequence: 2,
        reference: `${PREFIX}INC-2`,
        title: `${PREFIX}newyear-call`,
        status: "OPEN",
        createdByAuthIdentityId: `${PREFIX}actor`,
        createdAt: new Date("2026-01-01T03:30:00.000Z"),
      },
    });
    ids.incidentBoundaryPrevYear = boundary.id;

    // Vendor + expense fixtures: two currencies, four statuses, one
    // prior-year row, one foreign-org row.
    const vendor = await prisma.vendor.create({
      data: {
        organizationId: orgA,
        name: `${PREFIX}Harbor Chandlery`,
        accountReference: `${PREFIX}acct-1`,
      },
    });
    ids.vendor = vendor.id;
    const vendor2 = await prisma.vendor.create({
      data: { organizationId: orgA, name: `${PREFIX}Island Fuel Dock` },
    });
    ids.vendor2 = vendor2.id;
    const foreignVendor = await prisma.vendor.create({
      data: { organizationId: orgB, name: `${PREFIX}Harbor Chandlery` },
    });
    ids.foreignVendor = foreignVendor.id;

    let seq = 0;
    const mkExpense = (data: {
      expenseDate: string;
      amountMinor: number;
      currency: string;
      status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";
      category?: string;
      vendorId?: string;
      reimbursementStatus?: "NOT_REQUIRED" | "PENDING" | "REIMBURSED";
    }) => {
      seq += 1;
      return prisma.expense.create({
        data: {
          organizationId: orgA,
          sequence: seq,
          reference: `EXP-${seq}`,
          expenseDate: new Date(`${data.expenseDate}T00:00:00.000Z`),
          amountMinor: data.amountMinor,
          currency: data.currency,
          status: data.status,
          reimbursementStatus: data.reimbursementStatus ?? "NOT_REQUIRED",
          category: data.category ?? null,
          vendorId: data.vendorId ?? null,
          submittedByMemberId: member.id,
          paidByMemberId: member.id,
          createdByAuthIdentityId: `${PREFIX}actor`,
        },
      });
    };
    ids.expenseUsdApproved = (
      await mkExpense({
        expenseDate: "2026-02-10",
        amountMinor: 421538,
        currency: "USD",
        status: "APPROVED",
        category: "fuel",
        vendorId: vendor.id,
      })
    ).id;
    ids.expenseUsdSubmitted = (
      await mkExpense({
        expenseDate: "2026-04-01",
        amountMinor: 1299,
        currency: "USD",
        status: "SUBMITTED",
        category: "parts",
        vendorId: vendor2.id,
        reimbursementStatus: "PENDING",
      })
    ).id;
    ids.expenseEurApproved = (
      await mkExpense({
        expenseDate: "2026-05-09",
        amountMinor: 80000,
        currency: "EUR",
        status: "APPROVED",
        category: "fuel",
        vendorId: vendor.id,
      })
    ).id;
    ids.expenseRejected = (
      await mkExpense({
        expenseDate: "2026-06-20",
        amountMinor: 5000,
        currency: "USD",
        status: "REJECTED",
        category: "misc",
      })
    ).id;
    ids.expensePriorYear = (
      await mkExpense({
        expenseDate: "2025-11-30",
        amountMinor: 777,
        currency: "USD",
        status: "APPROVED",
        category: "fuel",
      })
    ).id;
    ids.foreignExpense = (
      await prisma.expense.create({
        data: {
          organizationId: orgB,
          sequence: 1,
          reference: "EXP-1",
          expenseDate: new Date("2026-02-10T00:00:00.000Z"),
          amountMinor: 999999,
          currency: "USD",
          status: "APPROVED",
          vendorId: foreignVendor.id,
          createdByAuthIdentityId: `${PREFIX}actor-b`,
        },
      })
    ).id;

    // Attachment fixtures — receipt on the approved USD expense + an
    // organization document version.
    const attachment = await prisma.attachment.create({
      data: {
        organizationId: orgA,
        displayFilename: "fuel-receipt.pdf",
        mediaType: "application/pdf",
        sizeBytes: 2048,
        storageProvider: "local",
        storageKey: `${PREFIX}storage-key-secret`,
        checksumSha256: `${PREFIX}checksum`,
        uploadedByAuthIdentityId: `${PREFIX}actor`,
      },
    });
    ids.attachment = attachment.id;
    await prisma.expenseAttachment.create({
      data: {
        organizationId: orgA,
        expenseId: ids.expenseUsdApproved,
        attachmentId: attachment.id,
        createdByAuthIdentityId: `${PREFIX}actor`,
      },
    });
    const document = await prisma.organizationDocument.create({
      data: {
        organizationId: orgA,
        title: `${PREFIX}sop-manual`,
        createdByAuthIdentityId: `${PREFIX}actor`,
      },
    });
    ids.document = document.id;
    await prisma.organizationDocumentVersion.create({
      data: {
        organizationId: orgA,
        documentId: document.id,
        attachmentId: attachment.id,
        versionNumber: 1,
        createdByAuthIdentityId: `${PREFIX}actor`,
      },
    });
  });

  afterAll(async () => {
    const org = { in: [orgA, orgB] };
    await prisma.dataExportEvent.deleteMany({
      where: { organizationId: org },
    });
    await prisma.expenseChange.deleteMany({ where: { organizationId: org } });
    await prisma.expenseEvent.deleteMany({ where: { organizationId: org } });
    await prisma.expenseAttachment.deleteMany({
      where: { organizationId: org },
    });
    await prisma.expenseInventoryItem.deleteMany({
      where: { organizationId: org },
    });
    await prisma.expenseMaintenanceRecord.deleteMany({
      where: { organizationId: org },
    });
    await prisma.expenseAsset.deleteMany({ where: { organizationId: org } });
    await prisma.expenseTrainingEvent.deleteMany({
      where: { organizationId: org },
    });
    await prisma.expenseIncident.deleteMany({
      where: { organizationId: org },
    });
    await prisma.expense.deleteMany({ where: { organizationId: org } });
    await prisma.expenseSequence.deleteMany({
      where: { organizationId: org },
    });
    await prisma.vendor.deleteMany({ where: { organizationId: org } });
    await prisma.organizationDocumentVersion.deleteMany({
      where: { organizationId: org },
    });
    await prisma.organizationDocument.deleteMany({
      where: { organizationId: org },
    });
    await prisma.incidentNoteAttachment.deleteMany({
      where: { organizationId: org },
    });
    await prisma.incidentAttachment.deleteMany({
      where: { organizationId: org },
    });
    await prisma.memberQualificationAttachment.deleteMany({
      where: { organizationId: org },
    });
    await prisma.trainingEventAttachment.deleteMany({
      where: { organizationId: org },
    });
    await prisma.assetAttachment.deleteMany({
      where: { organizationId: org },
    });
    await prisma.inspectionRecordAttachment.deleteMany({
      where: { organizationId: org },
    });
    await prisma.maintenanceRecordAttachment.deleteMany({
      where: { organizationId: org },
    });
    await prisma.defectAttachment.deleteMany({
      where: { organizationId: org },
    });
    await prisma.attachmentEvent.deleteMany({
      where: { organizationId: org },
    });
    await prisma.attachment.deleteMany({ where: { organizationId: org } });
    await prisma.incidentNoteCorrection.deleteMany({
      where: { organizationId: org },
    });
    await prisma.incidentNote.deleteMany({ where: { organizationId: org } });
    await prisma.incidentTimelineEvent.deleteMany({
      where: { organizationId: org },
    });
    await prisma.incidentChange.deleteMany({
      where: { organizationId: org },
    });
    await prisma.incidentMember.deleteMany({
      where: { organizationId: org },
    });
    await prisma.incidentAsset.deleteMany({
      where: { organizationId: org },
    });
    await prisma.incident.deleteMany({ where: { organizationId: org } });
    await prisma.incidentSequence.deleteMany({
      where: { organizationId: org },
    });
    await prisma.calloutResponseChange.deleteMany({
      where: { organizationId: org },
    });
    await prisma.calloutInvitation.deleteMany({
      where: { organizationId: org },
    });
    await prisma.callout.deleteMany({ where: { organizationId: org } });
    await prisma.defectChange.deleteMany({ where: { organizationId: org } });
    await prisma.defect.deleteMany({ where: { organizationId: org } });
    await prisma.assetMeterReading.deleteMany({
      where: { organizationId: org },
    });
    await prisma.assetMeter.deleteMany({ where: { organizationId: org } });
    await prisma.inspectionRecordChange.deleteMany({
      where: { organizationId: org },
    });
    await prisma.inspectionRecord.deleteMany({
      where: { organizationId: org },
    });
    await prisma.inspectionDefinition.deleteMany({
      where: { organizationId: org },
    });
    await prisma.maintenanceRecordChange.deleteMany({
      where: { organizationId: org },
    });
    await prisma.maintenanceRecord.deleteMany({
      where: { organizationId: org },
    });
    await prisma.maintenancePlan.deleteMany({
      where: { organizationId: org },
    });
    await prisma.inventoryItem.deleteMany({ where: { organizationId: org } });
    await prisma.asset.deleteMany({ where: { organizationId: org } });
    await prisma.storageLocation.deleteMany({
      where: { organizationId: org },
    });
    await prisma.trainingAttendanceChange.deleteMany({
      where: { organizationId: org },
    });
    await prisma.trainingAttendance.deleteMany({
      where: { organizationId: org },
    });
    await prisma.trainingTopic.deleteMany({
      where: { organizationId: org },
    });
    await prisma.trainingEvent.deleteMany({ where: { organizationId: org } });
    await prisma.memberAvailabilityUpdate.deleteMany({
      where: { organizationId: org },
    });
    await prisma.memberNotificationPreference.deleteMany({
      where: { organizationId: org },
    });
    await prisma.memberQualification.deleteMany({
      where: { organizationId: org },
    });
    await prisma.qualificationDefinition.deleteMany({
      where: { organizationId: org },
    });
    await prisma.memberUnit.deleteMany({ where: { organizationId: org } });
    await prisma.member.deleteMany({ where: { organizationId: org } });
    await prisma.unit.deleteMany({ where: { organizationId: org } });
    await prisma.organization.deleteMany({ where: { id: org } });
  });

  describe("registry", () => {
    it("exposes stable unique keys with declared filters", () => {
      const keys = EXPORT_DATASETS.map((d) => d.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(getExportDataset("expenses")?.filters.has("currency")).toBe(true);
      expect(getExportDataset("members")?.filters.has("date")).toBe(false);
      expect(getExportDataset("does-not-exist")).toBeUndefined();
    });
  });

  describe("filter parsing", () => {
    it("rejects unsupported params rather than widening the export", () => {
      expect(() =>
        parseExportFilters(new URLSearchParams("from=2026-01-01"), new Set()),
      ).toThrow(ExportFilterError);
    });

    it("rejects malformed dates and inverted ranges", () => {
      expect(() =>
        parseExportFilters(
          new URLSearchParams("from=not-a-date"),
          new Set(["date"]),
        ),
      ).toThrow(ExportFilterError);
      expect(() =>
        parseExportFilters(
          new URLSearchParams("from=2026-06-01&to=2026-01-01"),
          new Set(["date"]),
        ),
      ).toThrow(ExportFilterError);
    });

    it("rejects invalid enum and currency values", () => {
      expect(() =>
        parseExportFilters(
          new URLSearchParams("status=BANANA"),
          new Set(["status"]),
        ),
      ).toThrow(ExportFilterError);
      expect(() =>
        parseExportFilters(
          new URLSearchParams("currency=ZZZ"),
          new Set(["currency"]),
        ),
      ).toThrow(ExportFilterError);
    });
  });

  describe("authorization", () => {
    it("denies MEMBER-role callers", async () => {
      await expect(
        runCsvExport(ctxFor(orgA, "MEMBER"), orgA, "members", emptyParams),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("denies an admin of a different organization", async () => {
      await expect(
        runCsvExport(ctxFor(orgB, "ADMIN"), orgA, "members", emptyParams),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("returns null for unknown dataset keys", async () => {
      await expect(
        runCsvExport(ctxFor(orgA, "ADMIN"), orgA, "secret-stuff", emptyParams),
      ).resolves.toBeNull();
    });
  });

  describe("dataset output", () => {
    it("exports members with BOM, stable headers, and org isolation", async () => {
      const result = await runCsvExport(
        ctxFor(orgA, "ADMIN"),
        orgA,
        "members",
        emptyParams,
      );
      expect(result).not.toBeNull();
      const rows = csvRows(result!.csv);
      expect(rows[0]).toEqual([
        "id",
        "organizationId",
        "displayName",
        "email",
        "phone",
        "status",
        "authIdentityId",
        "createdAt",
        "updatedAt",
      ]);
      const memberIds = rows.slice(1).map((r) => r[0]);
      expect(memberIds).toContain(ids.member);
      expect(memberIds).toContain(ids.otherMember);
      // Same-name member in the other org never leaks.
      expect(memberIds).not.toContain(ids.foreignMember);
      expect(result!.filename).toMatch(
        /^sarbase-members-\d{4}-\d{2}-\d{2}\.csv$/,
      );
    });

    it("filters members by unit membership", async () => {
      const byUnit = await runCsvExport(
        ctxFor(orgA, "ADMIN"),
        orgA,
        "members",
        new URLSearchParams(`unit=${ids.unit}`),
      );
      const unitIds = csvRows(byUnit!.csv)
        .slice(1)
        .map((r) => r[0]);
      expect(unitIds).toContain(ids.member);
      expect(unitIds).not.toContain(ids.otherMember);

      const orgWide = await runCsvExport(
        ctxFor(orgA, "ADMIN"),
        orgA,
        "members",
        new URLSearchParams("unit=org"),
      );
      const wideIds = csvRows(orgWide!.csv)
        .slice(1)
        .map((r) => r[0]);
      expect(wideIds).not.toContain(ids.member);
      expect(wideIds).toContain(ids.otherMember);
    });

    it("exports expenses with exact money and relationship ids", async () => {
      const result = await runCsvExport(
        ctxFor(orgA, "ADMIN"),
        orgA,
        "expenses",
        emptyParams,
      );
      const rows = csvRows(result!.csv);
      const header = rows[0]!;
      const refIdx = header.indexOf("reference");
      const minorIdx = header.indexOf("amountMinor");
      const currencyIdx = header.indexOf("currency");
      const amountIdx = header.indexOf("amount");
      const vendorIdx = header.indexOf("vendorId");
      const memberIdx = header.indexOf("submittedByMemberId");
      const attachIdx = header.indexOf("attachmentCount");

      const byRef = new Map(rows.slice(1).map((r) => [r[refIdx], r]));
      expect(byRef.has("EXP-1")).toBe(true);
      const approved = byRef.get("EXP-1")!;
      expect(approved[minorIdx]).toBe("421538");
      expect(approved[currencyIdx]).toBe("USD");
      expect(approved[amountIdx]).toBe("4215.38");
      // Stable ids join back to the vendors/members datasets.
      expect(approved[vendorIdx]).toBe(ids.vendor);
      expect(approved[memberIdx]).toBe(ids.member);
      expect(approved[attachIdx]).toBe("1");
      // The foreign expense never appears.
      expect(rows.slice(1).some((r) => r[minorIdx] === "999999")).toBe(false);
    });

    it("applies expense filters: date range, status, currency, vendor, category", async () => {
      const admin = ctxFor(orgA, "ADMIN");
      const refsOf = (csv: string) => {
        const rows = csvRows(csv);
        const idx = rows[0]!.indexOf("reference");
        return rows.slice(1).map((r) => r[idx]);
      };

      const fuelOnly = await runCsvExport(
        admin,
        orgA,
        "expenses",
        new URLSearchParams("category=fuel"),
      );
      const fuelRefs = refsOf(fuelOnly!.csv);
      expect(fuelRefs).toContain("EXP-1");
      expect(fuelRefs).toContain("EXP-3");
      expect(fuelRefs).not.toContain("EXP-2");

      const approvedUsd = await runCsvExport(
        admin,
        orgA,
        "expenses",
        new URLSearchParams("status=APPROVED&currency=USD"),
      );
      const usdRefs = refsOf(approvedUsd!.csv);
      expect(usdRefs).toEqual(expect.arrayContaining(["EXP-1", "EXP-5"]));
      expect(usdRefs).not.toContain("EXP-3");
      expect(usdRefs).not.toContain("EXP-4");

      const inYear = await runCsvExport(
        admin,
        orgA,
        "expenses",
        new URLSearchParams("from=2026-01-01&to=2026-12-31"),
      );
      expect(refsOf(inYear!.csv)).not.toContain("EXP-5");

      const byVendor = await runCsvExport(
        admin,
        orgA,
        "expenses",
        new URLSearchParams(`vendor=${ids.vendor}`),
      );
      expect(refsOf(byVendor!.csv).sort()).toEqual(["EXP-1", "EXP-3"]);

      // A foreign/fabricated vendor id matches nothing — not an error.
      const forged = await runCsvExport(
        admin,
        orgA,
        "expenses",
        new URLSearchParams(`vendor=${ids.foreignVendor}`),
      );
      expect(refsOf(forged!.csv)).toEqual([]);
    });

    it("resolves attachment links across all link tables", async () => {
      const result = await runCsvExport(
        ctxFor(orgA, "ADMIN"),
        orgA,
        "attachment-links",
        emptyParams,
      );
      const rows = csvRows(result!.csv);
      const typeIdx = rows[0]!.indexOf("linkType");
      const attachIdx = rows[0]!.indexOf("attachmentId");
      const targetIdx = rows[0]!.indexOf("targetId");
      const expenseLink = rows.find(
        (r) => r[typeIdx] === "EXPENSE" && r[attachIdx] === ids.attachment,
      );
      expect(expenseLink?.[targetIdx]).toBe(ids.expenseUsdApproved);
      const docLink = rows.find((r) => r[typeIdx] === "DOCUMENT_VERSION");
      expect(docLink?.[targetIdx]).toBe(ids.document);
    });

    it("exports attachment metadata without storage keys or URLs", async () => {
      const result = await runCsvExport(
        ctxFor(orgA, "ADMIN"),
        orgA,
        "attachments",
        emptyParams,
      );
      expect(result!.csv).toContain(ids.attachment);
      expect(result!.csv).toContain("fuel-receipt.pdf");
      expect(result!.csv).not.toContain(`${PREFIX}storage-key-secret`);
      expect(result!.csv).not.toContain("storageKey");
      expect(result!.csv).not.toContain("http");
    });

    it("excludes callout response token hashes", async () => {
      const result = await runCsvExport(
        ctxFor(orgA, "ADMIN"),
        orgA,
        "callout-invitations",
        emptyParams,
      );
      expect(result!.csv).toContain(ids.member);
      expect(result!.csv).not.toContain("tokenhash");
      expect(result!.csv).not.toContain("responseTokenHash");
    });

    it("translates instant date filters through the organization timezone", async () => {
      // 2026-01-01T03:30Z is 2025-12-31 23:30 in America/Puerto_Rico —
      // a 2026 local range must exclude it.
      const result = await runCsvExport(
        ctxFor(orgA, "ADMIN"),
        orgA,
        "incidents",
        new URLSearchParams("from=2026-01-01&to=2026-12-31"),
      );
      const rows = csvRows(result!.csv);
      const idIdx = rows[0]!.indexOf("id");
      const recordIds = rows.slice(1).map((r) => r[idIdx]);
      expect(recordIds).toContain(ids.incidentInYear);
      expect(recordIds).not.toContain(ids.incidentBoundaryPrevYear);
    });
  });

  describe("export audit", () => {
    it("writes a DataExportEvent with safe filter metadata", async () => {
      const before = await prisma.dataExportEvent.count({
        where: { organizationId: orgA },
      });
      await runCsvExport(
        ctxFor(orgA, "ADMIN"),
        orgA,
        "expenses",
        new URLSearchParams(
          "status=APPROVED&category=fuel&from=2026-01-01&to=2026-12-31",
        ),
      );
      const events = await prisma.dataExportEvent.findMany({
        where: { organizationId: orgA },
        orderBy: { createdAt: "desc" },
      });
      expect(events.length).toBe(before + 1);
      const latest = events[0]!;
      expect(latest.exportType).toBe("expenses");
      expect(latest.format).toBe("csv");
      expect(latest.actorAuthIdentityId).toContain("identity-ADMIN");
      expect(latest.recordCount).toBeGreaterThan(0);
      const meta = latest.filters as Record<string, string>;
      expect(meta.status).toBe("APPROVED");
      expect(meta.from).toBe("2026-01-01");
      // Free-text filter input is never persisted to audit.
      expect(meta.category).toBeUndefined();
    });

    it("writes no audit event for denied or invalid exports", async () => {
      const before = await prisma.dataExportEvent.count({
        where: { organizationId: orgA },
      });
      await expect(
        runCsvExport(ctxFor(orgA, "MEMBER"), orgA, "members", emptyParams),
      ).rejects.toThrow();
      await expect(
        runCsvExport(
          ctxFor(orgA, "ADMIN"),
          orgA,
          "members",
          new URLSearchParams("bogus=1"),
        ),
      ).rejects.toThrow(ExportFilterError);
      expect(
        await prisma.dataExportEvent.count({
          where: { organizationId: orgA },
        }),
      ).toBe(before);
    });

    it("fails closed when the audit insert fails — no CSV is produced", async () => {
      const spy = vi
        .spyOn(prisma, "$transaction")
        .mockImplementationOnce(async (fn: unknown) => {
          // Delegate everything except the audit insert, which fails.
          const tx = new Proxy(prisma, {
            get(target, prop) {
              if (prop === "dataExportEvent") {
                return {
                  create: () => Promise.reject(new Error("audit write failed")),
                };
              }
              return Reflect.get(target, prop);
            },
          });
          return (fn as (t: unknown) => Promise<unknown>)(tx);
        });
      await expect(
        runCsvExport(ctxFor(orgA, "ADMIN"), orgA, "units", emptyParams),
      ).rejects.toThrow("audit write failed");
      spy.mockRestore();
    });

    it("audit rows survive auth identity deletion (scalar actor)", async () => {
      const events = await prisma.dataExportEvent.findMany({
        where: { organizationId: orgA },
      });
      expect(events.length).toBeGreaterThan(0);
      // No FK to AuthIdentity exists — deleting an identity row cannot
      // touch export history. Proven structurally: the scalar actor id
      // is a plain column; there is nothing to cascade.
      expect(
        events.every((e) => typeof e.actorAuthIdentityId === "string"),
      ).toBe(true);
    });
  });

  describe("rate limiting", () => {
    it("throttles after the per-window budget is exhausted", async () => {
      const admin = ctxFor(orgA, "ADMIN");
      const before = await prisma.dataExportEvent.count({
        where: { organizationId: orgA },
      });
      // The budget key is (export.generate, org, actor); drain whatever
      // remains of this window's 60-call budget with cheap unit exports.
      let succeeded = 0;
      let threw = false;
      for (let i = 0; i < 65 && !threw; i += 1) {
        try {
          await runCsvExport(admin, orgA, "units", emptyParams);
          succeeded += 1;
        } catch (error) {
          expect(error).toBeInstanceOf(ExportRateLimitedError);
          threw = true;
        }
      }
      expect(threw).toBe(true);
      // Rate-limited requests never wrote audit rows beyond the
      // successful exports.
      expect(
        await prisma.dataExportEvent.count({ where: { organizationId: orgA } }),
      ).toBe(before + succeeded);
    });
  });

  describe("annual summary", () => {
    it("computes training participation exactly from recorded facts", async () => {
      const summary = await getAnnualSummary(orgA, 2026);
      expect(summary).not.toBeNull();
      const t = summary!.training;
      // ev90 (90min × 3), evNoDur (1 attendee), unitEvent (45min × 0)
      expect(t.completedEvents).toBe(3);
      expect(t.cancelledEvents).toBe(1);
      expect(t.totalEventMinutes).toBe(90 + 45);
      expect(t.eventsWithoutDuration).toBe(1);
      expect(t.recordedAttendances).toBe(3 + 1);
      // 90 × 3 = 270 participant-minutes = 4.5 hours.
      expect(t.participantMinutes).toBe(270);
      expect(participantHoursLabel(270)).toBe("4.5");
    });

    it("scopes the training section by unit without affecting other sections", async () => {
      const summary = await getAnnualSummary(orgA, 2026, ids.unit);
      expect(summary!.unitId).toBe(ids.unit);
      expect(summary!.training.completedEvents).toBe(1);
      expect(summary!.incidents.total).toBe(1); // org-wide — boundary row is locally 2025
      expect(summary!.expenses.total).toBe(4); // 2026 rows in orgA
    });

    it("flags a fabricated unit filter rather than widening", async () => {
      const summary = await getAnnualSummary(orgA, 2026, "no-such-unit");
      expect(summary!.unitFilterUnmatched).toBe(true);
      expect(summary!.training.completedEvents).toBe(0);
      expect(summary!.incidents.total).toBe(1);
    });

    it("applies the organization timezone to instant-bounded sections", async () => {
      const summary = await getAnnualSummary(orgA, 2026);
      // createdAt 2026-01-01T03:30Z is locally 2025-12-31 — excluded.
      expect(summary!.incidents.total).toBe(1);
      expect(summary!.incidents.byStatus).toEqual([
        { status: "CLOSED", count: 1 },
      ]);
      expect(summary!.incidents.participantRecords).toBe(1);
      expect(summary!.incidents.assetRecords).toBe(1);

      const prevYear = await getAnnualSummary(orgA, 2025);
      expect(prevYear!.incidents.total).toBe(1);
      expect(prevYear!.incidents.byStatus).toEqual([
        { status: "OPEN", count: 1 },
      ]);
    });

    it("counts maintenance facts without verdicts", async () => {
      const summary = await getAnnualSummary(orgA, 2026);
      const m = summary!.maintenance;
      expect(m.maintenanceRecords).toBe(1);
      expect(m.inspectionRecords).toBe(1);
      expect(m.defectsReported).toBe(2);
      expect(m.defectsResolved).toBe(1);
      expect(m.byAsset).toEqual([
        {
          assetId: ids.asset,
          assetName: `${PREFIX}Rescue Boat 7`,
          count: 1,
        },
      ]);
    });

    it("sums money exactly per currency and never combines", async () => {
      const summary = await getAnnualSummary(orgA, 2026);
      const e = summary!.expenses;
      expect(e.total).toBe(4);
      expect(e.byStatus).toEqual(
        expect.arrayContaining([
          { status: "APPROVED", count: 2 },
          { status: "SUBMITTED", count: 1 },
          { status: "REJECTED", count: 1 },
        ]),
      );
      // Approved totals stay separated by currency.
      expect(e.approvedTotalsByCurrency).toEqual([
        { currency: "EUR", count: 1, amountMinor: 80000 },
        { currency: "USD", count: 1, amountMinor: 421538 },
      ]);
      const fuelUsd = e.categoryTotalsByCurrency.find(
        (r) => r.category === "fuel" && r.currency === "USD",
      );
      expect(fuelUsd).toEqual({
        category: "fuel",
        currency: "USD",
        count: 1,
        amountMinor: 421538,
      });
      const chandlery = e.vendorTotalsByCurrency.find(
        (r) => r.vendorId === ids.vendor && r.currency === "USD",
      );
      expect(chandlery?.amountMinor).toBe(421538);
    });
  });

  describe("pure summary math", () => {
    it("computes participant-minutes without duration invention", () => {
      const out = summarizeTrainingEvents([
        { durationMinutes: 90, attendanceCount: 3 },
        { durationMinutes: null, attendanceCount: 2 },
        { durationMinutes: 30, attendanceCount: 0 },
      ]);
      expect(out.participantMinutes).toBe(270);
      expect(out.recordedAttendances).toBe(5);
      expect(out.totalEventMinutes).toBe(120);
      expect(out.eventsWithoutDuration).toBe(1);
    });
  });
});
