import { PrismaClient } from "@prisma/client";

import { parsePostgresqlUrl } from "../src/lib/env";

/**
 * Seeds the database with SYNTHETIC placeholder rows for development,
 * preview, and CI environments. Never run against production — the
 * guard below refuses on any host that looks like one, but the real
 * control is environment isolation (see docs/database.md): this script
 * should only ever see a disposable database.
 *
 * Seed data must be generated here or in fixtures — never copied or
 * derived from production data.
 */
const prisma = new PrismaClient();

async function main() {
  const host = parsePostgresqlUrl(
    process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "",
  ).hostname;
  if (
    process.env.APP_PRODUCTION_DB_HOST &&
    host === process.env.APP_PRODUCTION_DB_HOST
  ) {
    throw new Error(
      "Refusing to seed: DATABASE_URL resolves to the production host.",
    );
  }

  // Synthetic organization → unit → member fixture exercising the full
  // domain chain. All rows use fixed seed ids so reseeding is idempotent.
  const organization = await prisma.organization.upsert({
    where: { id: "seed-organization" },
    update: {},
    create: {
      id: "seed-organization",
      name: "Example Volunteer SAR Organization",
    },
  });

  const unit = await prisma.unit.upsert({
    where: {
      organizationId_name: {
        organizationId: organization.id,
        name: "Example Station",
      },
    },
    update: {},
    create: {
      id: "seed-unit",
      organizationId: organization.id,
      name: "Example Station",
    },
  });

  const member = await prisma.member.upsert({
    where: { id: "seed-member" },
    update: {},
    create: {
      id: "seed-member",
      organizationId: organization.id,
      displayName: "Example Member",
      email: "member@example.test",
    },
  });

  await prisma.memberUnit.upsert({
    where: {
      memberId_unitId: { memberId: member.id, unitId: unit.id },
    },
    update: {},
    create: {
      organizationId: organization.id,
      memberId: member.id,
      unitId: unit.id,
    },
  });

  // Issue #10 fixture — a small asset/inventory/location chain that
  // exercises nested locations, a vessel locker (location inside an
  // asset), a parent-child asset, and a quantity item.
  const boathouse = await prisma.storageLocation.upsert({
    where: { id: "seed-location-boathouse" },
    update: {},
    create: {
      id: "seed-location-boathouse",
      organizationId: organization.id,
      name: "Example Boathouse",
    },
  });
  const shelf = await prisma.storageLocation.upsert({
    where: { id: "seed-location-shelf" },
    update: {},
    create: {
      id: "seed-location-shelf",
      organizationId: organization.id,
      parentLocationId: boathouse.id,
      name: "Shelf A",
    },
  });
  const boat = await prisma.asset.upsert({
    where: { id: "seed-asset-boat" },
    update: {},
    create: {
      id: "seed-asset-boat",
      organizationId: organization.id,
      unitId: unit.id,
      storageLocationId: boathouse.id,
      name: "Example Rescue Boat",
      category: "Vessel",
      manufacturer: "Example Marine",
      model: "RHIB-600",
      serialNumber: "EX-0001",
      assetTag: "SAR-0001",
      condition: "GOOD",
    },
  });
  await prisma.asset.upsert({
    where: { id: "seed-asset-engine" },
    update: {},
    create: {
      id: "seed-asset-engine",
      organizationId: organization.id,
      parentAssetId: boat.id,
      name: "Port Engine",
      category: "Outboard",
      condition: "GOOD",
    },
  });
  const locker = await prisma.storageLocation.upsert({
    where: { id: "seed-location-locker" },
    update: {},
    create: {
      id: "seed-location-locker",
      organizationId: organization.id,
      containingAssetId: boat.id,
      name: "Forward locker",
    },
  });
  await prisma.inventoryItem.upsert({
    where: { id: "seed-item-flares" },
    update: {},
    create: {
      id: "seed-item-flares",
      organizationId: organization.id,
      storageLocationId: locker.id,
      name: "Handheld flares",
      category: "Pyrotechnics",
      quantity: "6",
      unitOfMeasure: "each",
    },
  });
  await prisma.inventoryItem.upsert({
    where: { id: "seed-item-line" },
    update: {},
    create: {
      id: "seed-item-line",
      organizationId: organization.id,
      storageLocationId: shelf.id,
      name: "3/8 double-braid line",
      category: "Rope",
      quantity: "2.5",
      unitOfMeasure: "rolls",
      vendor: "Example Chandlery",
    },
  });

  // Issue #11 fixture — an inspection type + record, an engine-hours
  // meter with a reading, a meter-interval maintenance plan with one
  // service record, and one open defect. Factual rows only.
  const monthlyInspection = await prisma.inspectionDefinition.upsert({
    where: { id: "seed-inspection-monthly" },
    update: {},
    create: {
      id: "seed-inspection-monthly",
      organizationId: organization.id,
      name: "Monthly vessel visual inspection",
      description: "Hull, fittings, and fittings-adjacent checks.",
      recurrenceType: "CALENDAR_DAYS",
      intervalValue: 30,
    },
  });
  await prisma.inspectionRecord.upsert({
    where: { id: "seed-inspection-record-1" },
    update: {},
    create: {
      id: "seed-inspection-record-1",
      organizationId: organization.id,
      assetId: boat.id,
      definitionId: monthlyInspection.id,
      performedOn: new Date("2026-09-15T00:00:00.000Z"),
      inspectorMemberId: member.id,
      nextDueOn: new Date("2026-10-15T00:00:00.000Z"),
      conditionObserved: "GOOD",
    },
  });
  const engineMeter = await prisma.assetMeter.upsert({
    where: { id: "seed-meter-engine-hours" },
    update: {},
    create: {
      id: "seed-meter-engine-hours",
      organizationId: organization.id,
      assetId: boat.id,
      name: "Engine hours",
      unit: "hours",
    },
  });
  const servicePlan = await prisma.maintenancePlan.upsert({
    where: { id: "seed-plan-oil" },
    update: {},
    create: {
      id: "seed-plan-oil",
      organizationId: organization.id,
      assetId: boat.id,
      name: "Engine oil change",
      intervalType: "METER_INTERVAL",
      meterId: engineMeter.id,
      meterInterval: "100",
    },
  });
  const serviceRecord = await prisma.maintenanceRecord.upsert({
    where: { id: "seed-maintenance-oil-1" },
    update: {},
    create: {
      id: "seed-maintenance-oil-1",
      organizationId: organization.id,
      assetId: boat.id,
      planId: servicePlan.id,
      performedOn: new Date("2026-09-01T00:00:00.000Z"),
      title: "Engine oil change",
      providerName: "Example Marine Services",
      meterId: engineMeter.id,
      meterReading: "812.4",
    },
  });
  await prisma.assetMeterReading.upsert({
    where: { id: "seed-reading-service-1" },
    update: {},
    create: {
      id: "seed-reading-service-1",
      organizationId: organization.id,
      meterId: engineMeter.id,
      reading: "812.4",
      recordedOn: new Date("2026-09-01T00:00:00.000Z"),
      maintenanceRecordId: serviceRecord.id,
    },
  });
  const seedDefect = await prisma.defect.upsert({
    where: { id: "seed-defect-bilge" },
    update: {},
    create: {
      id: "seed-defect-bilge",
      organizationId: organization.id,
      assetId: boat.id,
      reportedOn: new Date("2026-09-20T00:00:00.000Z"),
      reportedByMemberId: member.id,
      title: "Bilge pump intermittent",
      description: "Pump runs, then stalls after a few minutes.",
    },
  });
  // Seed-time actor rows have no real sign-in identity; use a dedicated
  // synthetic identity so the append-only change history stays honest.
  const seedIdentity = await prisma.authIdentity.upsert({
    where: {
      provider_providerUid: {
        provider: "seed",
        providerUid: "seed-fixture",
      },
    },
    update: {},
    create: {
      id: "seed-identity",
      provider: "seed",
      providerUid: "seed-fixture",
      email: "seed@example.test",
    },
  });
  await prisma.defectChange.upsert({
    where: { id: "seed-defect-change-1" },
    update: {},
    create: {
      id: "seed-defect-change-1",
      organizationId: organization.id,
      defectId: seedDefect.id,
      action: "REPORTED",
      actorAuthIdentityId: seedIdentity.id,
    },
  });

  // Issue #12 fixture — one recorded availability statement and a
  // contact-preference row for the seed member. Factual seed data only.
  await prisma.memberAvailabilityUpdate.upsert({
    where: { id: "seed-availability-1" },
    update: {},
    create: {
      id: "seed-availability-1",
      organizationId: organization.id,
      memberId: member.id,
      status: "AVAILABLE",
      selfReported: false,
      actorAuthIdentityId: seedIdentity.id,
    },
  });
  await prisma.memberNotificationPreference.upsert({
    where: {
      memberId_organizationId: {
        memberId: member.id,
        organizationId: organization.id,
      },
    },
    update: {},
    create: {
      organizationId: organization.id,
      memberId: member.id,
      notifyEmail: true,
    },
  });

  console.log(
    `Seeded organization (${organization.id}) with 1 unit, 1 member, ` +
      `2 assets, 3 locations, 2 inventory items, 1 inspection type + ` +
      `record, 1 meter + reading, 1 maintenance plan + record, ` +
      `1 open defect, and 1 availability statement + contact ` +
      `preference row.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
