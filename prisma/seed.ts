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

  console.log(
    `Seeded organization (${organization.id}) with 1 unit, 1 member, ` +
      `2 assets, 3 locations, and 2 inventory items.`,
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
