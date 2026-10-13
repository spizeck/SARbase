import { pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

import { normalizeDatabaseEndpoint } from "../src/lib/env";
import {
  LOOPBACK_HOSTS,
  parseDatabaseTargetUrl,
} from "../scripts/lib/db-target";

/**
 * Seeds the database with SYNTHETIC placeholder rows for development,
 * the permanent `testing` baseline, preview/pr-<n> branches, and CI.
 * Never run against production — the guard below refuses on the
 * production host under every invocation, but the real control is
 * environment isolation (see docs/database.md): this script should
 * only ever see a disposable or fictional-data database.
 *
 * Target gate:
 * - loopback hosts (local dev, CI service containers) seed freely;
 * - any remote host requires `--target <name> --confirm` so a stray
 *   DATABASE_URL can never be written to by accident;
 * - `--target testing` additionally must resolve to the documented
 *   testing host (APP_TESTING_DB_HOST) — a positive identity binding,
 *   not just "any remote database the operator pointed at";
 * - the production host is refused under every invocation.
 *
 * Seeding is strictly additive and idempotent: predictable `seed-*` ids
 * + upserts mean re-runs converge to the same state and never delete.
 * Seed data must be generated here or in fixtures — never copied or
 * derived from production data.
 */

export interface SeedRequest {
  target?: string;
  confirm: boolean;
}

export function parseSeedArgs(argv: string[]): SeedRequest {
  let target: string | undefined;
  let confirm = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") {
      const operand = argv[++i];
      if (!operand || operand.startsWith("-")) {
        throw new Error(
          "--target requires a name operand (e.g. --target testing)",
        );
      }
      target = operand;
    } else if (arg === "--confirm") {
      confirm = true;
    } else {
      throw new Error(
        `Unknown argument ${JSON.stringify(arg)}. Usage: db:seed [--target <name> --confirm]`,
      );
    }
  }
  return { target, confirm };
}

/**
 * Fail-closed seed-target check. `databaseUrl` is the URL the seed
 * client will actually use — the caller must pass the resolved
 * (unpooled-preferred) string, not re-read env inside here.
 */
export function assertSeedTargetAllowed(
  args: SeedRequest,
  databaseUrl: string,
  env: Record<string, string | undefined>,
): void {
  // The strict parser also rejects target-override query parameters —
  // a `?host=` slipstream could otherwise redirect the driver past the
  // hostname this guard is about to trust.
  const parsed = parseDatabaseTargetUrl(databaseUrl);
  const host = normalizeDatabaseEndpoint(parsed.hostname);

  const productionHost = env.APP_PRODUCTION_DB_HOST
    ? normalizeDatabaseEndpoint(env.APP_PRODUCTION_DB_HOST.trim())
    : undefined;
  if (productionHost && host === productionHost) {
    throw new Error(
      "Refusing to seed: database URL resolves to the production host.",
    );
  }

  if (LOOPBACK_HOSTS.has(host)) {
    return;
  }

  if (!(args.target && args.confirm)) {
    throw new Error(
      `Refusing to seed remote database at ${host}:${parsed.port}. ` +
        "Remote seeding requires an explicit --target <name> --confirm " +
        "(e.g. `npm run db:seed -- --target testing --confirm`).",
    );
  }

  // Positive identity for the permanent baseline: --target testing
  // must resolve to the documented testing host, not merely "any
  // remote database the operator happened to point at".
  if (args.target === "testing") {
    const testingHost = env.APP_TESTING_DB_HOST
      ? normalizeDatabaseEndpoint(env.APP_TESTING_DB_HOST.trim())
      : undefined;
    if (!testingHost) {
      throw new Error(
        "--target testing requires APP_TESTING_DB_HOST (the non-secret " +
          "testing-branch hostname) so the target name is bound to a " +
          "verified database, not a stray connection string.",
      );
    }
    if (host !== testingHost) {
      throw new Error(
        `Refusing to seed: --target testing but the database URL resolves ` +
          `to ${host}, not the configured testing host.`,
      );
    }
  }

  console.log(
    `Seeding remote database ${host}:${parsed.port}` +
      `/${parsed.database} (target: ${args.target}, confirmed).`,
  );
}

async function main() {
  // Bind the client to the same canonical URL the production-host guard
  // inspects — without this, Prisma falls back to pooled DATABASE_URL
  // while the guard checks DATABASE_URL_UNPOOLED, and the two can
  // diverge.
  const seedUrl =
    process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "";
  if (!seedUrl) {
    throw new Error(
      "DATABASE_URL_UNPOOLED or DATABASE_URL must be set to seed.",
    );
  }

  const args = parseSeedArgs(process.argv.slice(2));
  assertSeedTargetAllowed(args, seedUrl, process.env);

  const prisma = new PrismaClient({ datasources: { db: { url: seedUrl } } });
  try {
    // Synthetic organization → unit → member fixture exercising the
    // full domain chain. All rows use fixed seed ids so reseeding is
    // idempotent.
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
        id: "seed-member-unit",
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
    // Seed-time actor rows have no real sign-in identity; use a
    // dedicated synthetic identity so the append-only change history
    // stays honest.
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
    // contact-preference row for the seed member. Factual seed data
    // only.
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
        id: "seed-notification-pref",
        organizationId: organization.id,
        memberId: member.id,
        notifyEmail: true,
      },
    });

    // Qualification fixture (issue #8 domain) — one org-defined
    // qualification type and one member record, including an expiry so
    // expiry-window queries have a row to find. Fictional issuer.
    const firstAid = await prisma.qualificationDefinition.upsert({
      where: { id: "seed-qualdef-first-aid" },
      update: {},
      create: {
        id: "seed-qualdef-first-aid",
        organizationId: organization.id,
        name: "First Aid Certificate",
        description: "Example qualification definition for seed data.",
      },
    });
    await prisma.memberQualification.upsert({
      where: { id: "seed-qualification-1" },
      update: {},
      create: {
        id: "seed-qualification-1",
        organizationId: organization.id,
        memberId: member.id,
        definitionId: firstAid.id,
        issuedOn: new Date("2026-03-01T00:00:00.000Z"),
        expiresOn: new Date("2028-03-01T00:00:00.000Z"),
        issuer: "Example Training Board",
      },
    });

    console.log(
      `Seeded organization (${organization.id}) with 1 unit, 1 member, ` +
        `2 assets, 3 locations, 2 inventory items, 1 inspection type + ` +
        `record, 1 meter + reading, 1 maintenance plan + record, ` +
        `1 open defect, 1 availability statement + contact ` +
        `preference row, and 1 qualification definition + record.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
