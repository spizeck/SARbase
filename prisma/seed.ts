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

  console.log(
    `Seeded organization (${organization.id}) with 1 unit and 1 member.`,
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
