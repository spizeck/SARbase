import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parsePostgresqlUrl } from "../src/lib/env";

import {
  buildPostgresEnv,
  parsePostgresCredentials,
  sanitizeCommandForLogging,
} from "./lib/postgres-credentials";

/**
 * Guarded logical backup via pg_dump.
 *
 * Extracted from the Sea Saba `scripts/backup-database.ts` (the pattern
 * RISE converged on independently), generalized:
 *
 * - Requires explicit `--target` AND `--confirm` — a backup reads the
 *   database and writes a credential-adjacent artifact; it must never
 *   be a reflex.
 * - Refuses to run for `--target production` without
 *   `--force-production`, and refuses entirely when the ambient
 *   environment looks like production unless forced.
 * - Prefers DATABASE_URL_UNPOOLED (pg_dump through PgBouncer can hang).
 * - Credentials go to pg_dump via PG* env vars, never argv; everything
 *   logged is run through sanitizeCommandForLogging.
 *
 * Neon PITR/snapshots remain the provider-layer recovery path — this
 * produces portable logical backups (see docs/database.md and
 * runbooks/database-backup-restore.md).
 */

type BackupTarget = "development" | "preview" | "staging" | "production";

const VALID_TARGETS: BackupTarget[] = [
  "development",
  "preview",
  "staging",
  "production",
];

export interface BackupArgs {
  target: BackupTarget;
  outputDir: string;
  confirm: boolean;
  forceProduction: boolean;
  dryRun: boolean;
}

function looksLikeProduction(env: Record<string, string | undefined>): boolean {
  return (
    env.VERCEL_ENV === "production" ||
    env.APP_ENV === "production" ||
    env.NODE_ENV === "production"
  );
}

export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): BackupArgs {
  let target: BackupTarget | undefined;
  let outputDir: string | undefined;
  let confirm = false;
  let forceProduction = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--target" || arg === "-t") {
      const value = argv[++i];
      if (!value || !VALID_TARGETS.includes(value as BackupTarget)) {
        throw new Error(
          `Invalid --target. Must be one of: ${VALID_TARGETS.join(", ")}`,
        );
      }
      target = value as BackupTarget;
    } else if (arg === "--output-dir" || arg === "-o") {
      outputDir = argv[++i];
    } else if (arg === "--confirm") {
      confirm = true;
    } else if (arg === "--force-production") {
      forceProduction = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  if (!target) {
    target = env.BACKUP_TARGET as BackupTarget | undefined;
  }

  if (!outputDir) {
    outputDir = env.BACKUP_OUTPUT_DIR ?? "./backups";
  }

  if (!target || !VALID_TARGETS.includes(target)) {
    throw new Error(
      `--target is required (or BACKUP_TARGET). Must be one of: ${VALID_TARGETS.join(", ")}`,
    );
  }

  return {
    target,
    outputDir: path.resolve(outputDir),
    confirm,
    forceProduction,
    dryRun,
  };
}

export function assertSafeBackupTarget(
  args: BackupArgs,
  env: Record<string, string | undefined>,
): void {
  if (!args.confirm) {
    throw new Error(
      "Refusing to run: --confirm was not provided. This command reads the target database; confirm explicitly.",
    );
  }

  if (args.forceProduction && args.target !== "production") {
    throw new Error(
      "Refusing to run: --force-production is only valid with --target production. It cannot override a production-like environment for non-production targets.",
    );
  }

  if (args.target === "production" && !args.forceProduction) {
    throw new Error(
      "Refusing to back up Production without --force-production. Production backups are performed by an authorized operator with a documented procedure.",
    );
  }

  if (looksLikeProduction(env) && !args.forceProduction) {
    throw new Error(
      "Refusing to run: the current environment looks like Production. Set --force-production only if you intend to back up Production.",
    );
  }
}

export function resolveBackupDatabaseUrl(
  env: Record<string, string | undefined>,
): string {
  const url = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;

  if (!url) {
    throw new Error(
      "DATABASE_URL is required. Provide the source database connection string.",
    );
  }

  const parsed = parsePostgresqlUrl(url);

  if (parsed.hostname.endsWith("[SENSITIVE]")) {
    throw new Error(
      "DATABASE_URL appears to be a Vercel placeholder. Provide a real connection string.",
    );
  }

  return url;
}

export function buildBackupFileName(args: BackupArgs): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const random = crypto.randomBytes(4).toString("hex");
  return `backup-${args.target}-${timestamp}-${random}.dump`;
}

export function buildBackupCommand(
  databaseUrl: string,
  outputPath: string,
): string[] {
  const creds = parsePostgresCredentials(databaseUrl);
  return [
    "pg_dump",
    "--format=custom",
    "--host",
    creds.host,
    "--port",
    creds.port,
    "--username",
    creds.user,
    "--dbname",
    creds.database,
    "--file",
    outputPath,
  ];
}

function commandExists(command: string): boolean {
  const result = spawnSync(`${command} --version`, {
    stdio: "ignore",
    shell: true,
  });
  return result.status === 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env);
  assertSafeBackupTarget(args, process.env);

  const databaseUrl = resolveBackupDatabaseUrl(process.env);
  const parsed = parsePostgresqlUrl(databaseUrl);
  const creds = parsePostgresCredentials(databaseUrl);

  if (!fs.existsSync(args.outputDir)) {
    fs.mkdirSync(args.outputDir, { recursive: true });
  }

  const outputPath = path.join(args.outputDir, buildBackupFileName(args));
  const command = buildBackupCommand(databaseUrl, outputPath);

  console.log("Backup target:", args.target);
  console.log("Source host:", parsed.hostname);
  console.log("Source database:", parsed.database);
  console.log("Output file:", outputPath);
  console.log("Command:", sanitizeCommandForLogging(command).join(" "));

  if (args.dryRun) {
    console.log("Dry run complete. No backup was created.");
    return;
  }

  if (!commandExists("pg_dump")) {
    throw new Error(
      "pg_dump was not found on PATH. Install PostgreSQL client tools to run backups.",
    );
  }

  const result = spawnSync(command[0]!, command.slice(1), {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, ...buildPostgresEnv(creds) },
  });

  if (result.status !== 0) {
    throw new Error(
      `pg_dump failed with exit code ${result.status ?? result.signal ?? "unknown"}`,
    );
  }

  console.log("Backup created:", outputPath);
}

if (
  import.meta.url ===
  pathToFileURL(process.argv[1] ?? "scripts/backup-database.ts").href
) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
