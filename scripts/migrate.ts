/**
 * Guarded wrapper for destructive-capable Prisma CLI commands
 * (issue #88).
 *
 * Usage:
 *   npm run db:migrate:dev -- <extra prisma migrate dev args>
 *   npm run db:migrate:reset -- <extra prisma migrate reset args>
 *   npm run db:push -- <extra prisma db push args>
 *
 * For a remote target that is NOT production/testing (a personal Neon
 * dev branch), confirm the resolved hostname positively:
 *   npm run db:migrate:dev -- --confirm-host <exact-hostname>
 *
 * The wrapper validates DATABASE_URL_UNPOOLED ?? DATABASE_URL — the
 * same connection Prisma's directUrl uses for migrations — before
 * spawning `prisma`, so a remote database can never be targeted
 * silently by a stale .env.
 */

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  assertDestructiveTarget,
  DestructiveTargetError,
} from "./lib/destructive-db-guard";
import { DatabaseTargetError } from "./lib/db-target";

const SUBCOMMANDS: Record<string, { prisma: string[]; label: string }> = {
  dev: { prisma: ["migrate", "dev"], label: "prisma migrate dev" },
  reset: { prisma: ["migrate", "reset"], label: "prisma migrate reset" },
  push: { prisma: ["db", "push"], label: "prisma db push" },
};

const CONFIRM_FLAG = "--confirm-host";

export function run(argv: string[]): number {
  const [subcommand, ...rest] = argv;
  const spec = subcommand ? SUBCOMMANDS[subcommand] : undefined;
  if (!spec) {
    console.error(
      `Usage: migrate.ts <${Object.keys(SUBCOMMANDS).join("|")}> ` +
        `[prisma args] [${CONFIRM_FLAG} <hostname>]`,
    );
    return 2;
  }

  // Extract the confirmation flag; everything else passes through.
  const prismaArgs: string[] = [];
  let confirmHost: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === CONFIRM_FLAG) {
      confirmHost = rest[i + 1];
      i += 1;
      if (!confirmHost) {
        console.error(`${CONFIRM_FLAG} requires a hostname value.`);
        return 2;
      }
    } else {
      prismaArgs.push(arg);
    }
  }

  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "DATABASE_URL / DATABASE_URL_UNPOOLED are not set — load .env " +
        "before running a migration command.",
    );
    return 2;
  }

  try {
    assertDestructiveTarget(
      url,
      {
        productionHost: process.env.APP_PRODUCTION_DB_HOST,
        testingHost: process.env.APP_TESTING_DB_HOST,
        confirmHost,
      },
      spec.label,
    );
  } catch (error) {
    if (
      error instanceof DestructiveTargetError ||
      error instanceof DatabaseTargetError
    ) {
      console.error(`Refused: ${error.message}`);
      return 1;
    }
    throw error;
  }

  const result = spawnSync("npx", ["prisma", ...spec.prisma, ...prismaArgs], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  return result.status ?? 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(run(process.argv.slice(2)));
}
