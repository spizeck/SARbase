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

  const item = await prisma.bootstrapItem.upsert({
    where: { id: "seed-bootstrap-item" },
    update: {},
    create: { id: "seed-bootstrap-item", label: "Seed bootstrap item" },
  });
  console.log(`Seeded 1 bootstrap item (${item.id}).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
