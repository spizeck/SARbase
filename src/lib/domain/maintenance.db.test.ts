import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { createOrganization } from "@/lib/domain/organization";
import { createAsset, updateAsset } from "@/lib/domain/assets";
import {
  ArchivedMeterError,
  CrossOrganizationMaintenanceError,
  DefectTransitionError,
  InactiveInspectionDefinitionError,
  InactiveMaintenancePlanError,
  MeterReadingDecreaseError,
  createAssetMeter,
  createInspectionDefinition,
  createMaintenancePlan,
  listAssetDefects,
  listAssetInspections,
  listAssetMaintenanceRecords,
  listAssetMeters,
  listDueInspections,
  listDueMaintenance,
  listDefectChanges,
  listMeterReadings,
  listOpenDefects,
  recordInspection,
  recordMaintenance,
  recordMeterReading,
  reportDefect,
  setAssetMeterStatus,
  setInspectionDefinitionStatus,
  setMaintenancePlanStatus,
  transitionDefect,
  updateDefect,
  updateInspectionRecord,
  updateMaintenanceRecord,
} from "./maintenance";

/**
 * Database-backed issue #11 tests — `npm run test:db` only.
 * Distinct prefix: files may run on parallel workers, so cleanup must
 * never touch another suite's fixtures.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "mainttest-";

let counter = 0;
function uniq(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

async function createTestOrg(suffix = "org", timezone?: string) {
  return createOrganization({ name: uniq(suffix), timezone });
}

async function createTestAsset(orgId: string, suffix = "asset") {
  return createAsset(orgId, {
    name: uniq(suffix),
    status: "ACTIVE",
    condition: "UNKNOWN",
  });
}

async function createTestMember(orgId: string, suffix = "member") {
  return prisma.member.create({
    data: { organizationId: orgId, displayName: uniq(suffix) },
  });
}

async function createTestIdentity(suffix = "identity") {
  return prisma.authIdentity.create({
    data: {
      provider: "firebase",
      providerUid: uniq(suffix),
      email: `${uniq("ident")}@example.org`,
    },
  });
}

function planEntry(
  entries: import("./maintenance").MaintenanceDueEntry[],
  planId: string,
) {
  const entry = entries.find((e) => e.kind === "plan" && e.planId === planId);
  if (!entry || entry.kind !== "plan") {
    throw new Error("expected a plan due entry");
  }
  return entry;
}

describe.skipIf(!hasDb)("inspections / maintenance / defects", () => {
  afterAll(async () => {
    const orgFilter = { organization: { name: { startsWith: PREFIX } } };
    await prisma.assetMeterReading.deleteMany({ where: orgFilter });
    await prisma.defectChange.deleteMany({ where: orgFilter });
    await prisma.defect.deleteMany({ where: orgFilter });
    await prisma.inspectionRecordChange.deleteMany({ where: orgFilter });
    await prisma.maintenanceRecordChange.deleteMany({ where: orgFilter });
    await prisma.maintenanceRecord.deleteMany({ where: orgFilter });
    await prisma.inspectionRecord.deleteMany({ where: orgFilter });
    await prisma.maintenancePlan.deleteMany({ where: orgFilter });
    await prisma.inspectionDefinition.deleteMany({ where: orgFilter });
    await prisma.assetMeter.deleteMany({ where: orgFilter });
    await prisma.member.deleteMany({ where: orgFilter });
    await prisma.authIdentity.deleteMany({
      where: { providerUid: { startsWith: PREFIX } },
    });
    await prisma.asset.updateMany({
      where: orgFilter,
      data: { parentAssetId: null, storageLocationId: null, unitId: null },
    });
    await prisma.asset.deleteMany({ where: orgFilter });
    await prisma.storageLocation.deleteMany({ where: orgFilter });
    await prisma.unit.deleteMany({ where: orgFilter });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  describe("inspection definitions", () => {
    it("creates an org-scoped definition with calendar recurrence", async () => {
      const org = await createTestOrg("def-org");
      const def = await createInspectionDefinition(org.id, {
        name: "Monthly visual",
        description: "Hull and fittings",
        recurrenceType: "CALENDAR_DAYS",
        intervalValue: 30,
      });
      expect(def.organizationId).toBe(org.id);
      expect(def.recurrenceType).toBe("CALENDAR_DAYS");
      expect(def.intervalValue).toBe(30);
    });

    it("rejects a duplicate name within the same organization", async () => {
      const org = await createTestOrg("def-dupe-org");
      const name = uniq("def");
      await createInspectionDefinition(org.id, {
        name,
        recurrenceType: "NONE",
      });
      await expect(
        createInspectionDefinition(org.id, { name, recurrenceType: "NONE" }),
      ).rejects.toMatchObject({ code: "P2002" });
    });
  });

  describe("inspection records", () => {
    it("derives nextDueOn from the definition's recurrence when absent", async () => {
      const org = await createTestOrg("irec-org");
      const asset = await createTestAsset(org.id);
      const def = await createInspectionDefinition(org.id, {
        name: uniq("monthly"),
        recurrenceType: "CALENDAR_DAYS",
        intervalValue: 30,
      });
      const record = await recordInspection(asset.id, {
        definitionId: def.id,
        performedOn: D("2026-09-15"),
      });
      expect(record.nextDueOn).toEqual(D("2026-10-15"));
    });

    it("honors an explicit nextDueOn over the derived recurrence", async () => {
      const org = await createTestOrg("irec-org2");
      const asset = await createTestAsset(org.id);
      const def = await createInspectionDefinition(org.id, {
        name: uniq("monthly"),
        recurrenceType: "CALENDAR_DAYS",
        intervalValue: 30,
      });
      const record = await recordInspection(asset.id, {
        definitionId: def.id,
        performedOn: D("2026-09-15"),
        nextDueOn: D("2026-12-01"),
      });
      expect(record.nextDueOn).toEqual(D("2026-12-01"));
    });

    it("leaves nextDueOn null for a non-recurring definition", async () => {
      const org = await createTestOrg("irec-org3");
      const asset = await createTestAsset(org.id);
      const def = await createInspectionDefinition(org.id, {
        name: uniq("adhoc"),
        recurrenceType: "NONE",
      });
      const record = await recordInspection(asset.id, {
        definitionId: def.id,
        performedOn: D("2026-09-15"),
      });
      expect(record.nextDueOn).toBeNull();
    });

    it("appends history — a second inspection never overwrites the first", async () => {
      const org = await createTestOrg("irec-org4");
      const asset = await createTestAsset(org.id);
      const def = await createInspectionDefinition(org.id, {
        name: uniq("annual"),
        recurrenceType: "CALENDAR_MONTHS",
        intervalValue: 12,
      });
      await recordInspection(asset.id, {
        definitionId: def.id,
        performedOn: D("2025-09-15"),
      });
      await recordInspection(asset.id, {
        definitionId: def.id,
        performedOn: D("2026-09-15"),
      });
      const records = await listAssetInspections(asset.id);
      expect(records).toHaveLength(2);
      expect(records[0]!.performedOn).toEqual(D("2026-09-15"));
      expect(records[1]!.performedOn).toEqual(D("2025-09-15"));
    });

    it("stores an inspector member and free-text inspector name", async () => {
      const org = await createTestOrg("irec-org5");
      const asset = await createTestAsset(org.id);
      const member = await createTestMember(org.id);
      const def = await createInspectionDefinition(org.id, {
        name: uniq("check"),
        recurrenceType: "NONE",
      });
      const record = await recordInspection(asset.id, {
        definitionId: def.id,
        performedOn: D("2026-09-15"),
        inspectorMemberId: member.id,
        inspectorName: "External surveyor",
      });
      expect(record.inspectorMemberId).toBe(member.id);
      expect(record.inspectorName).toBe("External surveyor");
    });

    it("rejects a definition, inspector, or meter from another org", async () => {
      const orgA = await createTestOrg("irec-a");
      const orgB = await createTestOrg("irec-b");
      const assetA = await createTestAsset(orgA.id);
      const defB = await createInspectionDefinition(orgB.id, {
        name: uniq("foreign-def"),
        recurrenceType: "NONE",
      });
      const memberB = await createTestMember(orgB.id);
      const assetB = await createTestAsset(orgB.id);
      const meterB = await createAssetMeter(assetB.id, {
        name: uniq("meter"),
        unit: "hours",
      });
      const defA = await createInspectionDefinition(orgA.id, {
        name: uniq("local-def"),
        recurrenceType: "NONE",
      });

      await expect(
        recordInspection(assetA.id, {
          definitionId: defB.id,
          performedOn: D("2026-09-15"),
        }),
      ).rejects.toBeInstanceOf(CrossOrganizationMaintenanceError);
      await expect(
        recordInspection(assetA.id, {
          definitionId: defA.id,
          performedOn: D("2026-09-15"),
          inspectorMemberId: memberB.id,
        }),
      ).rejects.toBeInstanceOf(CrossOrganizationMaintenanceError);
      await expect(
        recordInspection(assetA.id, {
          definitionId: defA.id,
          performedOn: D("2026-09-15"),
          meterId: meterB.id,
          meterReading: "10",
        }),
      ).rejects.toBeInstanceOf(CrossOrganizationMaintenanceError);
    });

    it("rejects a meter belonging to a different asset in the same org", async () => {
      const org = await createTestOrg("irec-org6");
      const boat = await createTestAsset(org.id, "boat");
      const trailer = await createTestAsset(org.id, "trailer");
      const trailerMeter = await createAssetMeter(trailer.id, {
        name: uniq("odo"),
        unit: "km",
      });
      const def = await createInspectionDefinition(org.id, {
        name: uniq("check"),
        recurrenceType: "NONE",
      });
      await expect(
        recordInspection(boat.id, {
          definitionId: def.id,
          performedOn: D("2026-09-15"),
          meterId: trailerMeter.id,
          meterReading: "100",
        }),
      ).rejects.toBeInstanceOf(CrossOrganizationMaintenanceError);
    });

    it("writes a captured meter reading through to AssetMeterReading", async () => {
      const org = await createTestOrg("irec-org7");
      const asset = await createTestAsset(org.id);
      const meter = await createAssetMeter(asset.id, {
        name: uniq("hours"),
        unit: "hours",
      });
      const def = await createInspectionDefinition(org.id, {
        name: uniq("check"),
        recurrenceType: "NONE",
      });
      const record = await recordInspection(asset.id, {
        definitionId: def.id,
        performedOn: D("2026-09-15"),
        meterId: meter.id,
        meterReading: "812.4",
      });
      const readings = await listMeterReadings(meter.id);
      expect(readings).toHaveLength(1);
      expect(readings[0]!.reading.toString()).toBe("812.4");
      expect(readings[0]!.inspectionRecordId).toBe(record.id);
      expect(readings[0]!.maintenanceRecordId).toBeNull();
    });

    it("an inactive definition keeps its history but rejects new records", async () => {
      const org = await createTestOrg("irec-org8");
      const asset = await createTestAsset(org.id);
      const def = await createInspectionDefinition(org.id, {
        name: uniq("retired-type"),
        recurrenceType: "NONE",
      });
      await recordInspection(asset.id, {
        definitionId: def.id,
        performedOn: D("2026-09-15"),
      });
      await setInspectionDefinitionStatus(def.id, "INACTIVE");
      await expect(
        recordInspection(asset.id, {
          definitionId: def.id,
          performedOn: D("2026-09-16"),
        }),
      ).rejects.toBeInstanceOf(InactiveInspectionDefinitionError);
      const records = await listAssetInspections(asset.id);
      expect(records).toHaveLength(1);
    });

    it("corrects a record in place — asset and definition stay immutable", async () => {
      const org = await createTestOrg("irec-org9");
      const asset = await createTestAsset(org.id);
      const actor = await createTestIdentity("irec-actor");
      const def = await createInspectionDefinition(org.id, {
        name: uniq("check"),
        recurrenceType: "NONE",
      });
      const record = await recordInspection(asset.id, {
        definitionId: def.id,
        performedOn: D("2026-09-14"),
      });
      const corrected = await updateInspectionRecord(
        record.id,
        {
          performedOn: D("2026-09-15"),
          nextDueOn: D("2026-12-15"),
          notes: "Corrected date",
        },
        actor.id,
      );
      expect(corrected.performedOn).toEqual(D("2026-09-15"));
      expect(corrected.assetId).toBe(asset.id);
      expect(corrected.definitionId).toBe(def.id);
      expect(corrected.updatedAt.getTime()).toBeGreaterThan(
        corrected.createdAt.getTime(),
      );
      expect(await listAssetInspections(asset.id)).toHaveLength(1);

      // The material correction appended an immutable before/after row.
      const changes = await prisma.inspectionRecordChange.findMany({
        where: { recordId: record.id },
      });
      expect(changes).toHaveLength(1);
      expect(changes[0]!.actorAuthIdentityId).toBe(actor.id);
      expect(changes[0]!.beforePerformedOn).toEqual(D("2026-09-14"));
      expect(changes[0]!.afterPerformedOn).toEqual(D("2026-09-15"));
      expect(changes[0]!.afterNextDueOn).toEqual(D("2026-12-15"));
      expect(changes[0]!.beforeNotes).toBeNull();
      expect(changes[0]!.afterNotes).toBe("Corrected date");
    });

    it("PostgreSQL rejects a cross-org record write outright", async () => {
      const orgA = await createTestOrg("irec-raw-a");
      const orgB = await createTestOrg("irec-raw-b");
      const assetA = await createTestAsset(orgA.id);
      const defB = await createInspectionDefinition(orgB.id, {
        name: uniq("raw-def"),
        recurrenceType: "NONE",
      });
      // Mismatched organizationId: record says org A but definition
      // lives in org B — the composite FK must refuse the row.
      await expect(
        prisma.inspectionRecord.create({
          data: {
            organizationId: orgA.id,
            assetId: assetA.id,
            definitionId: defB.id,
            performedOn: D("2026-09-15"),
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    });
  });

  describe("meters", () => {
    it("creates a meter and appends exact-decimal readings", async () => {
      const org = await createTestOrg("meter-org");
      const asset = await createTestAsset(org.id);
      const meter = await createAssetMeter(asset.id, {
        name: uniq("engine"),
        unit: "hours",
      });
      await recordMeterReading(meter.id, {
        reading: "812.435",
        recordedOn: D("2026-09-10"),
      });
      await recordMeterReading(meter.id, {
        reading: "830.1",
        recordedOn: D("2026-09-15"),
      });
      const meters = await listAssetMeters(asset.id);
      expect(meters[0]!.readings[0]!.reading.toString()).toBe("830.1");
      const all = await listMeterReadings(meter.id);
      expect(all).toHaveLength(2);
      expect(all[1]!.reading.toString()).toBe("812.435");
    });

    it("rejects a lower reading — meters are monotonic within a lifetime", async () => {
      const org = await createTestOrg("meter-org2");
      const asset = await createTestAsset(org.id);
      const meter = await createAssetMeter(asset.id, {
        name: uniq("engine"),
        unit: "hours",
      });
      await recordMeterReading(meter.id, {
        reading: "900",
        recordedOn: D("2026-09-10"),
      });
      // A decrease dated on/after the latest observation is a data error.
      await expect(
        recordMeterReading(meter.id, {
          reading: "12.5",
          recordedOn: D("2026-09-15"),
          notes: "Meter replaced",
        }),
      ).rejects.toBeInstanceOf(MeterReadingDecreaseError);
      // Equal readings are legal (re-observation).
      await recordMeterReading(meter.id, {
        reading: "900",
        recordedOn: D("2026-09-12"),
      });
      // An increase is legal.
      const higher = await recordMeterReading(meter.id, {
        reading: "905",
        recordedOn: D("2026-09-15"),
      });
      expect(higher.reading.toString()).toBe("905");
      expect(await listMeterReadings(meter.id)).toHaveLength(3);
    });

    it("accepts a backdated reading that fits between its neighbors", async () => {
      const org = await createTestOrg("meter-org2b");
      const asset = await createTestAsset(org.id);
      const meter = await createAssetMeter(asset.id, {
        name: uniq("engine"),
        unit: "hours",
      });
      await recordMeterReading(meter.id, {
        reading: "100",
        recordedOn: D("2026-09-10"),
      });
      await recordMeterReading(meter.id, {
        reading: "150",
        recordedOn: D("2026-09-20"),
      });
      // Logged late but honestly dated — 120 on the 15th fits.
      const backdated = await recordMeterReading(meter.id, {
        reading: "120",
        recordedOn: D("2026-09-15"),
      });
      expect(backdated.reading.toString()).toBe("120");
      // A backdated value that contradicts the sequence is rejected:
      // 200 on the 15th would mean the meter ran backward by the 20th.
      await expect(
        recordMeterReading(meter.id, {
          reading: "200",
          recordedOn: D("2026-09-15"),
        }),
      ).rejects.toBeInstanceOf(MeterReadingDecreaseError);
      // And 90 on the 15th would mean it ran backward from the 10th.
      await expect(
        recordMeterReading(meter.id, {
          reading: "90",
          recordedOn: D("2026-09-15"),
        }),
      ).rejects.toBeInstanceOf(MeterReadingDecreaseError);
      // "Current" is still the latest-dated observation.
      const meters = await listAssetMeters(asset.id);
      expect(meters[0]!.readings[0]!.reading.toString()).toBe("150");
    });

    it("models meter replacement as archive + new meter", async () => {
      const org = await createTestOrg("meter-org2c");
      const asset = await createTestAsset(org.id);
      const meter = await createAssetMeter(asset.id, {
        name: uniq("engine"),
        unit: "hours",
      });
      await recordMeterReading(meter.id, {
        reading: "900",
        recordedOn: D("2026-09-10"),
      });
      // The reset/replacement workflow: archive, then a new meter starts
      // its own monotonic sequence — low first readings are legal there.
      await setAssetMeterStatus(meter.id, "ARCHIVED");
      const replacement = await createAssetMeter(asset.id, {
        name: uniq("engine-new"),
        unit: "hours",
      });
      const first = await recordMeterReading(replacement.id, {
        reading: "0.4",
        recordedOn: D("2026-09-15"),
        notes: "Replacement hour meter installed",
      });
      expect(first.reading.toString()).toBe("0.4");
      // The old meter keeps its history untouched.
      expect(await listMeterReadings(meter.id)).toHaveLength(1);
      await expect(
        recordMeterReading(meter.id, {
          reading: "950",
          recordedOn: D("2026-09-15"),
        }),
      ).rejects.toBeInstanceOf(ArchivedMeterError);
    });

    it("enforces monotonicity on readings captured via records", async () => {
      const org = await createTestOrg("meter-org2d");
      const asset = await createTestAsset(org.id);
      const meter = await createAssetMeter(asset.id, {
        name: uniq("engine"),
        unit: "hours",
      });
      await recordMeterReading(meter.id, {
        reading: "800",
        recordedOn: D("2026-09-10"),
      });
      // A service record dated later with a lower captured reading is
      // inconsistent with the meter's history — reject the whole record.
      await expect(
        recordMaintenance(asset.id, {
          title: uniq("svc"),
          performedOn: D("2026-09-12"),
          meterId: meter.id,
          meterReading: "700",
        }),
      ).rejects.toBeInstanceOf(MeterReadingDecreaseError);
      // Nothing was written — the record and the reading roll back together.
      expect(await listAssetMaintenanceRecords(asset.id)).toHaveLength(0);
      expect(await listMeterReadings(meter.id)).toHaveLength(1);
    });

    it("an archived meter keeps history but rejects new readings", async () => {
      const org = await createTestOrg("meter-org3");
      const asset = await createTestAsset(org.id);
      const meter = await createAssetMeter(asset.id, {
        name: uniq("engine"),
        unit: "hours",
      });
      await recordMeterReading(meter.id, {
        reading: "100",
        recordedOn: D("2026-09-10"),
      });
      await setAssetMeterStatus(meter.id, "ARCHIVED");
      await expect(
        recordMeterReading(meter.id, {
          reading: "110",
          recordedOn: D("2026-09-15"),
        }),
      ).rejects.toBeInstanceOf(ArchivedMeterError);
      expect(await listMeterReadings(meter.id)).toHaveLength(1);
    });

    it("PostgreSQL rejects a reading with two provenance sources", async () => {
      const org = await createTestOrg("meter-org4");
      const asset = await createTestAsset(org.id);
      const meter = await createAssetMeter(asset.id, {
        name: uniq("engine"),
        unit: "hours",
      });
      const [m1, m2] = await Promise.all([
        prisma.maintenanceRecord.create({
          data: {
            organizationId: org.id,
            assetId: asset.id,
            performedOn: D("2026-09-10"),
            title: uniq("svc-a"),
          },
        }),
        prisma.maintenanceRecord.create({
          data: {
            organizationId: org.id,
            assetId: asset.id,
            performedOn: D("2026-09-11"),
            title: uniq("svc-b"),
          },
        }),
      ]);
      const def = await createInspectionDefinition(org.id, {
        name: uniq("def"),
        recurrenceType: "NONE",
      });
      const insp = await prisma.inspectionRecord.create({
        data: {
          organizationId: org.id,
          assetId: asset.id,
          definitionId: def.id,
          performedOn: D("2026-09-10"),
        },
      });
      void m2;
      await expect(
        prisma.assetMeterReading.create({
          data: {
            organizationId: org.id,
            meterId: meter.id,
            reading: "10",
            recordedOn: D("2026-09-12"),
            maintenanceRecordId: m1.id,
            inspectionRecordId: insp.id,
          },
        }),
      ).rejects.toThrow(/AssetMeterReading_single_source/);
    });
  });

  describe("maintenance plans and records", () => {
    it("creates a calendar plan and records service against it", async () => {
      const org = await createTestOrg("plan-org");
      const asset = await createTestAsset(org.id);
      const plan = await createMaintenancePlan(asset.id, {
        name: uniq("oil"),
        intervalType: "CALENDAR_MONTHS",
        intervalValue: 12,
      });
      const record = await recordMaintenance(asset.id, {
        planId: plan.id,
        title: "Annual service",
        performedOn: D("2026-09-15"),
        providerName: "Marina Services",
      });
      expect(record.planId).toBe(plan.id);
      expect(record.organizationId).toBe(org.id);
    });

    it("creates a meter-interval plan tied to the asset's own meter", async () => {
      const org = await createTestOrg("plan-org2");
      const asset = await createTestAsset(org.id);
      const meter = await createAssetMeter(asset.id, {
        name: uniq("engine"),
        unit: "hours",
      });
      const plan = await createMaintenancePlan(asset.id, {
        name: uniq("oil-100h"),
        intervalType: "METER_INTERVAL",
        meterId: meter.id,
        meterInterval: "100",
      });
      expect(plan.meterId).toBe(meter.id);
      expect(plan.meterInterval?.toString()).toBe("100");
    });

    it("rejects a plan referencing another asset's meter", async () => {
      const org = await createTestOrg("plan-org3");
      const boat = await createTestAsset(org.id, "boat");
      const trailer = await createTestAsset(org.id, "trailer");
      const trailerMeter = await createAssetMeter(trailer.id, {
        name: uniq("odo"),
        unit: "km",
      });
      await expect(
        createMaintenancePlan(boat.id, {
          name: uniq("bad-plan"),
          intervalType: "METER_INTERVAL",
          meterId: trailerMeter.id,
          meterInterval: "100",
        }),
      ).rejects.toBeInstanceOf(CrossOrganizationMaintenanceError);
    });

    it("appends history — each service is a new row", async () => {
      const org = await createTestOrg("plan-org4");
      const asset = await createTestAsset(org.id);
      const plan = await createMaintenancePlan(asset.id, {
        name: uniq("annual"),
        intervalType: "CALENDAR_MONTHS",
        intervalValue: 12,
      });
      await recordMaintenance(asset.id, {
        planId: plan.id,
        title: "2025 service",
        performedOn: D("2025-09-15"),
      });
      await recordMaintenance(asset.id, {
        planId: plan.id,
        title: "2026 service",
        performedOn: D("2026-09-15"),
      });
      const records = await prisma.maintenanceRecord.findMany({
        where: { assetId: asset.id },
        orderBy: { performedOn: "desc" },
      });
      expect(records).toHaveLength(2);
      expect(records.map((r) => r.title)).toEqual([
        "2026 service",
        "2025 service",
      ]);
    });

    it("an inactive plan keeps history but rejects new records", async () => {
      const org = await createTestOrg("plan-org5");
      const asset = await createTestAsset(org.id);
      const plan = await createMaintenancePlan(asset.id, {
        name: uniq("retired-plan"),
        intervalType: "NONE",
      });
      await recordMaintenance(asset.id, {
        planId: plan.id,
        title: "Done before",
        performedOn: D("2026-01-01"),
      });
      await setMaintenancePlanStatus(plan.id, "INACTIVE");
      await expect(
        recordMaintenance(asset.id, {
          planId: plan.id,
          title: "After deactivation",
          performedOn: D("2026-09-15"),
        }),
      ).rejects.toBeInstanceOf(InactiveMaintenancePlanError);
      // Ad-hoc records on the same asset are unaffected.
      const adhoc = await recordMaintenance(asset.id, {
        title: "Unrelated fix",
        performedOn: D("2026-09-16"),
      });
      expect(adhoc.planId).toBeNull();
    });

    it("rejects a plan from another org or another asset", async () => {
      const orgA = await createTestOrg("plan-a");
      const orgB = await createTestOrg("plan-b");
      const assetA = await createTestAsset(orgA.id);
      const assetB = await createTestAsset(orgB.id);
      const assetA2 = await createTestAsset(orgA.id, "second");
      const planB = await createMaintenancePlan(assetB.id, {
        name: uniq("foreign-plan"),
        intervalType: "NONE",
      });
      const planAonA2 = await createMaintenancePlan(assetA2.id, {
        name: uniq("other-asset-plan"),
        intervalType: "NONE",
      });
      await expect(
        recordMaintenance(assetA.id, {
          planId: planB.id,
          title: "x",
          performedOn: D("2026-09-15"),
        }),
      ).rejects.toBeInstanceOf(CrossOrganizationMaintenanceError);
      await expect(
        recordMaintenance(assetA.id, {
          planId: planAonA2.id,
          title: "x",
          performedOn: D("2026-09-15"),
        }),
      ).rejects.toBeInstanceOf(CrossOrganizationMaintenanceError);
    });

    it("writes a captured meter reading through with provenance", async () => {
      const org = await createTestOrg("plan-org6");
      const asset = await createTestAsset(org.id);
      const meter = await createAssetMeter(asset.id, {
        name: uniq("engine"),
        unit: "hours",
      });
      const record = await recordMaintenance(asset.id, {
        title: "Oil change",
        performedOn: D("2026-09-15"),
        meterId: meter.id,
        meterReading: "812.4",
      });
      const readings = await listMeterReadings(meter.id);
      expect(readings).toHaveLength(1);
      expect(readings[0]!.maintenanceRecordId).toBe(record.id);
    });

    it("PostgreSQL rejects a record pinned to a foreign-org asset", async () => {
      const orgA = await createTestOrg("mrec-raw-a");
      const orgB = await createTestOrg("mrec-raw-b");
      const assetB = await createTestAsset(orgB.id);
      await expect(
        prisma.maintenanceRecord.create({
          data: {
            organizationId: orgA.id,
            assetId: assetB.id,
            performedOn: D("2026-09-15"),
            title: uniq("cross"),
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    });
  });

  describe("correction history", () => {
    it("writes immutable before/after history for a maintenance correction", async () => {
      const org = await createTestOrg("chg-org1");
      const asset = await createTestAsset(org.id);
      const actor = await createTestIdentity("chg-actor1");
      const record = await recordMaintenance(asset.id, {
        title: "Oil change",
        performedOn: D("2026-09-10"),
        providerName: "Harbor Marine",
      });
      await updateMaintenanceRecord(
        record.id,
        {
          title: "Oil change — both engines",
          performedOn: D("2026-09-10"),
          providerName: "Harbor Marine",
          correctionNote: "Clarified scope",
        },
        actor.id,
      );
      const changes = await prisma.maintenanceRecordChange.findMany({
        where: { recordId: record.id },
      });
      expect(changes).toHaveLength(1);
      const c = changes[0]!;
      expect(c.actorAuthIdentityId).toBe(actor.id);
      expect(c.note).toBe("Clarified scope");
      expect(c.beforeTitle).toBe("Oil change");
      expect(c.afterTitle).toBe("Oil change — both engines");
      expect(c.beforeProviderName).toBe("Harbor Marine");
      expect(c.afterProviderName).toBe("Harbor Marine");
      // Immutable surface: change rows have no update path in the
      // application; a raw read confirms the snapshot is persisted.
      expect(c.organizationId).toBe(org.id);
    });

    it("appends corrections — each change's before equals the prior after", async () => {
      const org = await createTestOrg("chg-org2");
      const asset = await createTestAsset(org.id);
      const actor = await createTestIdentity("chg-actor2");
      const record = await recordMaintenance(asset.id, {
        title: "First title",
        performedOn: D("2026-09-10"),
      });
      await updateMaintenanceRecord(
        record.id,
        { title: "Second title", performedOn: D("2026-09-10") },
        actor.id,
      );
      await updateMaintenanceRecord(
        record.id,
        { title: "Third title", performedOn: D("2026-09-10") },
        actor.id,
      );
      const changes = await prisma.maintenanceRecordChange.findMany({
        where: { recordId: record.id },
        orderBy: { createdAt: "asc" },
      });
      expect(changes).toHaveLength(2);
      expect(changes[0]!.beforeTitle).toBe("First title");
      expect(changes[0]!.afterTitle).toBe("Second title");
      expect(changes[1]!.beforeTitle).toBe("Second title");
      expect(changes[1]!.afterTitle).toBe("Third title");
    });

    it("writes no history when validation fails or nothing changed", async () => {
      const org = await createTestOrg("chg-org3");
      const asset = await createTestAsset(org.id);
      const actor = await createTestIdentity("chg-actor3");
      const foreignOrg = await createTestOrg("chg-org3b");
      const foreignMember = await createTestMember(foreignOrg.id, "fm");
      const record = await recordInspection(asset.id, {
        definitionId: (
          await createInspectionDefinition(org.id, {
            name: uniq("def"),
            recurrenceType: "NONE",
          })
        ).id,
        performedOn: D("2026-09-14"),
      });
      // Cross-org member reference fails validation — nothing written.
      await expect(
        updateInspectionRecord(
          record.id,
          { performedOn: D("2026-09-15"), inspectorMemberId: foreignMember.id },
          actor.id,
        ),
      ).rejects.toBeInstanceOf(CrossOrganizationMaintenanceError);
      // A no-change submission writes no history row.
      await updateInspectionRecord(
        record.id,
        { performedOn: D("2026-09-14") },
        actor.id,
      );
      expect(
        await prisma.inspectionRecordChange.count({
          where: { recordId: record.id },
        }),
      ).toBe(0);
      expect(
        (await prisma.inspectionRecord.findUnique({ where: { id: record.id } }))
          ?.performedOn,
      ).toEqual(D("2026-09-14"));
    });

    it("rolls the record update back when the history write fails", async () => {
      const org = await createTestOrg("chg-org4");
      const asset = await createTestAsset(org.id);
      const record = await recordMaintenance(asset.id, {
        title: "Oil change",
        performedOn: D("2026-09-10"),
      });
      // A nonexistent actor id violates the change row's FK — forcing a
      // failure between the snapshot and the update. Neither may commit.
      await expect(
        updateMaintenanceRecord(
          record.id,
          { title: "Tampered", performedOn: D("2026-09-11") },
          "nonexistent-identity",
        ),
      ).rejects.toMatchObject({ code: "P2003" });
      const persisted = await prisma.maintenanceRecord.findUnique({
        where: { id: record.id },
      });
      expect(persisted?.title).toBe("Oil change");
      expect(persisted?.performedOn).toEqual(D("2026-09-10"));
      expect(
        await prisma.maintenanceRecordChange.count({
          where: { recordId: record.id },
        }),
      ).toBe(0);
    });

    it("pins the correction to the record's real organization", async () => {
      const org = await createTestOrg("chg-org5");
      const asset = await createTestAsset(org.id);
      const actor = await createTestIdentity("chg-actor5");
      const def = await createInspectionDefinition(org.id, {
        name: uniq("def"),
        recurrenceType: "NONE",
      });
      const record = await recordInspection(asset.id, {
        definitionId: def.id,
        performedOn: D("2026-09-14"),
      });
      await updateInspectionRecord(
        record.id,
        { performedOn: D("2026-09-15"), notes: "typo fix" },
        actor.id,
      );
      const change = await prisma.inspectionRecordChange.findFirstOrThrow({
        where: { recordId: record.id },
      });
      // The change row's composite FK proved same-org at write time.
      expect(change.organizationId).toBe(org.id);
    });
  });

  describe("defects", () => {
    it("reports a defect OPEN with a REPORTED history row", async () => {
      const org = await createTestOrg("defect-org");
      const asset = await createTestAsset(org.id);
      const actor = await createTestIdentity();
      const defect = await reportDefect(
        asset.id,
        {
          title: "Bilge pump intermittent",
          description: "Runs, then stalls",
          reportedOn: D("2026-09-15"),
        },
        actor.id,
      );
      expect(defect.status).toBe("OPEN");
      const changes = await listDefectChanges(defect.id);
      expect(changes).toHaveLength(1);
      expect(changes[0]!.action).toBe("REPORTED");
      expect(changes[0]!.actorAuthIdentityId).toBe(actor.id);
    });

    it("leaves asset status untouched unless explicitly marked", async () => {
      const org = await createTestOrg("defect-org2");
      const asset = await createTestAsset(org.id);
      const actor = await createTestIdentity();
      await reportDefect(
        asset.id,
        { title: "Cracked mic", reportedOn: D("2026-09-15") },
        actor.id,
      );
      expect(
        (await prisma.asset.findUnique({ where: { id: asset.id } }))?.status,
      ).toBe("ACTIVE");

      await reportDefect(
        asset.id,
        {
          title: "Hull damage",
          reportedOn: D("2026-09-15"),
        },
        actor.id,
        { markOutOfService: true },
      );
      expect(
        (await prisma.asset.findUnique({ where: { id: asset.id } }))?.status,
      ).toBe("OUT_OF_SERVICE");
    });

    it("resolves and reopens with an auditable change history", async () => {
      const org = await createTestOrg("defect-org3");
      const asset = await createTestAsset(org.id);
      const actor = await createTestIdentity();
      const defect = await reportDefect(
        asset.id,
        { title: "Oil leak", reportedOn: D("2026-09-10") },
        actor.id,
      );
      const resolved = await transitionDefect(
        defect.id,
        {
          status: "RESOLVED",
          resolvedOn: D("2026-09-15"),
          resolutionNotes: "New gasket fitted",
          note: "Verified on run-up",
        },
        actor.id,
      );
      expect(resolved.status).toBe("RESOLVED");
      expect(resolved.resolvedOn).toEqual(D("2026-09-15"));

      const reopened = await transitionDefect(
        defect.id,
        { status: "OPEN", note: "Leak observed again" },
        actor.id,
      );
      expect(reopened.status).toBe("OPEN");
      // The last resolution stays as a recorded fact.
      expect(reopened.resolvedOn).toEqual(D("2026-09-15"));

      const changes = await listDefectChanges(defect.id);
      expect(changes.map((c) => c.action)).toEqual([
        "REPORTED",
        "RESOLVED",
        "REOPENED",
      ]);
    });

    it("rejects a resolution earlier than the report date", async () => {
      const org = await createTestOrg("defect-org4");
      const asset = await createTestAsset(org.id);
      const actor = await createTestIdentity();
      const defect = await reportDefect(
        asset.id,
        { title: "Leak", reportedOn: D("2026-09-15") },
        actor.id,
      );
      await expect(
        transitionDefect(
          defect.id,
          { status: "RESOLVED", resolvedOn: D("2026-09-10") },
          actor.id,
        ),
      ).rejects.toBeInstanceOf(DefectTransitionError);
    });

    it("rejects a no-op transition", async () => {
      const org = await createTestOrg("defect-org5");
      const asset = await createTestAsset(org.id);
      const actor = await createTestIdentity();
      const defect = await reportDefect(
        asset.id,
        { title: "Leak", reportedOn: D("2026-09-15") },
        actor.id,
      );
      await expect(
        transitionDefect(defect.id, { status: "OPEN" }, actor.id),
      ).rejects.toBeInstanceOf(DefectTransitionError);
    });

    it("keeps defects readable on retired assets; edits are factual corrections", async () => {
      const org = await createTestOrg("defect-org6");
      const asset = await createTestAsset(org.id);
      const actor = await createTestIdentity();
      const defect = await reportDefect(
        asset.id,
        { title: "Old defect", reportedOn: D("2026-01-01") },
        actor.id,
      );
      await updateAsset(asset.id, {
        name: asset.name,
        status: "RETIRED",
        condition: "UNKNOWN",
      });
      const defects = await listAssetDefects(asset.id);
      expect(defects).toHaveLength(1);
      expect(defects[0]!.status).toBe("OPEN");

      const corrected = await updateDefect(defect.id, {
        title: "Old defect (amended)",
        reportedOn: D("2026-01-01"),
      });
      expect(corrected.title).toBe("Old defect (amended)");
    });

    it("PostgreSQL rejects a defect pinned to a foreign-org asset", async () => {
      const orgA = await createTestOrg("defect-raw-a");
      const orgB = await createTestOrg("defect-raw-b");
      const assetB = await createTestAsset(orgB.id);
      await expect(
        prisma.defect.create({
          data: {
            organizationId: orgA.id,
            assetId: assetB.id,
            reportedOn: D("2026-09-15"),
            title: uniq("cross"),
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    });
  });

  describe("due lists — organization-local date facts", () => {
    it("classifies due-today and overdue-next-day against org-local today", async () => {
      const org = await createTestOrg("due-org");
      const asset = await createTestAsset(org.id);
      const def = await createInspectionDefinition(org.id, {
        name: uniq("monthly"),
        recurrenceType: "NONE",
      });
      await recordInspection(asset.id, {
        definitionId: def.id,
        performedOn: D("2026-09-01"),
        nextDueOn: D("2026-10-15"),
      });

      // On the due date itself: still due, not overdue.
      let entries = await listDueInspections(org.id, D("2026-10-15"));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.due.state).toBe("due_today");
      expect(entries[0]!.due.daysUntil).toBe(0);

      // The next local day: overdue by 1.
      entries = await listDueInspections(org.id, D("2026-10-16"));
      expect(entries[0]!.due.state).toBe("overdue");
      expect(entries[0]!.due.daysUntil).toBe(-1);
    });

    it("uses the latest record per (asset, definition) only", async () => {
      const org = await createTestOrg("due-org2");
      const asset = await createTestAsset(org.id);
      const def = await createInspectionDefinition(org.id, {
        name: uniq("monthly"),
        recurrenceType: "NONE",
      });
      await recordInspection(asset.id, {
        definitionId: def.id,
        performedOn: D("2026-08-01"),
        nextDueOn: D("2026-09-01"),
      });
      await recordInspection(asset.id, {
        definitionId: def.id,
        performedOn: D("2026-09-01"),
        nextDueOn: D("2027-09-01"),
      });
      const entries = await listDueInspections(org.id, D("2026-09-15"));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.nextDueOn).toEqual(D("2027-09-01"));
      expect(entries[0]!.due.state).toBe("scheduled");
    });

    it("computes calendar-plan due from the latest linked record", async () => {
      const org = await createTestOrg("due-org3");
      const asset = await createTestAsset(org.id, "boat");
      const plan = await createMaintenancePlan(asset.id, {
        name: uniq("annual-service"),
        intervalType: "CALENDAR_MONTHS",
        intervalValue: 12,
      });
      await recordMaintenance(asset.id, {
        planId: plan.id,
        title: "2025 annual",
        performedOn: D("2025-09-15"),
      });
      let entries = await listDueMaintenance(org.id, D("2026-09-20"));
      let entry = planEntry(entries, plan.id);
      expect(entry.due?.state).toBe("overdue");
      expect(entry.nextDueOn).toEqual(D("2026-09-15"));

      // A newer service moves the baseline.
      await recordMaintenance(asset.id, {
        planId: plan.id,
        title: "2026 annual",
        performedOn: D("2026-09-21"),
      });
      entries = await listDueMaintenance(org.id, D("2026-09-22"));
      entry = planEntry(entries, plan.id);
      expect(entry.nextDueOn).toEqual(D("2027-09-21"));
      expect(entry.due?.state).toBe("scheduled");
      expect(entry.neverPerformed).toBe(false);
    });

    it("reports never-performed plans without inventing a date", async () => {
      const org = await createTestOrg("due-org4");
      const asset = await createTestAsset(org.id);
      const plan = await createMaintenancePlan(asset.id, {
        name: uniq("annual"),
        intervalType: "CALENDAR_MONTHS",
        intervalValue: 12,
      });
      const entries = await listDueMaintenance(org.id, D("2026-09-15"));
      const entry = planEntry(entries, plan.id);
      expect(entry.neverPerformed).toBe(true);
      expect(entry.nextDueOn).toBeNull();
      expect(entry.due).toBeNull();
    });

    it("computes meter-plan due from baseline + interval + current reading", async () => {
      const org = await createTestOrg("due-org5");
      const asset = await createTestAsset(org.id, "engine");
      const meter = await createAssetMeter(asset.id, {
        name: uniq("engine-hours"),
        unit: "hours",
      });
      const plan = await createMaintenancePlan(asset.id, {
        name: uniq("oil-100h"),
        intervalType: "METER_INTERVAL",
        meterId: meter.id,
        meterInterval: "100",
      });
      await recordMaintenance(asset.id, {
        planId: plan.id,
        title: "Oil change",
        performedOn: D("2026-09-01"),
        meterId: meter.id,
        meterReading: "812.4",
      });

      // Below threshold: 912.4 due, current 850.
      await recordMeterReading(meter.id, {
        reading: "850",
        recordedOn: D("2026-09-10"),
      });
      let entries = await listDueMaintenance(org.id, D("2026-09-15"));
      let entry = planEntry(entries, plan.id);
      expect(entry.meter?.state).toBe("below_threshold");
      expect(entry.meter?.dueReading?.toString()).toBe("912.4");
      expect(entry.meter?.remaining?.toString()).toBe("62.4");

      // Past threshold by an exact decimal amount.
      await recordMeterReading(meter.id, {
        reading: "934.2",
        recordedOn: D("2026-09-20"),
      });
      entries = await listDueMaintenance(org.id, D("2026-09-21"));
      entry = planEntry(entries, plan.id);
      expect(entry.meter?.state).toBe("threshold_reached");
      expect(entry.meter?.overBy?.toString()).toBe("21.8");
    });

    it("surfaces the latest ad-hoc next-due per asset", async () => {
      const org = await createTestOrg("due-org6");
      const asset = await createTestAsset(org.id);
      await recordMaintenance(asset.id, {
        title: "Haul-out",
        performedOn: D("2026-03-01"),
        nextDueOn: D("2026-10-01"),
      });
      await recordMaintenance(asset.id, {
        title: "Impeller swap",
        performedOn: D("2026-09-01"),
        nextDueOn: D("2026-11-01"),
      });
      const entries = await listDueMaintenance(org.id, D("2026-09-15"));
      const adhoc = entries.filter((e) => e.kind === "ad_hoc");
      expect(adhoc).toHaveLength(1);
      expect(adhoc[0]!.nextDueOn).toEqual(D("2026-11-01"));
    });

    it("scopes every due list to the owning organization", async () => {
      const orgA = await createTestOrg("due-scope-a");
      const orgB = await createTestOrg("due-scope-b");
      const assetA = await createTestAsset(orgA.id);
      await createTestAsset(orgB.id);
      const defA = await createInspectionDefinition(orgA.id, {
        name: uniq("def-a"),
        recurrenceType: "NONE",
      });
      await recordInspection(assetA.id, {
        definitionId: defA.id,
        performedOn: D("2026-09-01"),
        nextDueOn: D("2026-09-10"),
      });
      expect(await listDueInspections(orgB.id, D("2026-09-15"))).toHaveLength(
        0,
      );
      expect(await listDueMaintenance(orgB.id, D("2026-09-15"))).toHaveLength(
        0,
      );
      expect(await listOpenDefects(orgB.id)).toHaveLength(0);
    });
  });
});
