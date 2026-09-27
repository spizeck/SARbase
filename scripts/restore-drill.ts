import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

import { parsePostgresqlUrl } from "../src/lib/env";

import {
  buildPgPassContent,
  buildPostgresEnv,
  parsePostgresCredentials,
  sanitizeCommandForLogging,
} from "./lib/postgres-credentials";

/**
 * Restore drill: prove the backup path actually restores.
 *
 * Extracted from the Sea Saba `scripts/restore-drill.ts`, generalized
 * to the repository's bootstrap `BootstrapItem` model. A backup that has
 * never been restored is not a backup — this script creates a scratch
 * database, seeds a synthetic row, dumps, deletes, restores, and
 * verifies recovery, then drops the scratch database.
 *
 * Hard limits (fail-closed):
 * - `--target development` only — preview/production drills are manual
 *   operator procedures, never scripted against real infrastructure.
 * - Source database must be localhost — the drill creates and drops
 *   databases; it must be impossible to aim at a remote database.
 * - Requires `--confirm`; refuses when the environment looks like
 *   production.
 *
 * Client tools: prefers `docker compose exec postgres ...` when the
 * compose service is running (matches the server major version exactly
 * and works on Windows without host pg tools); falls back to host
 * psql/pg_dump/pg_restore.
 */

type DrillTarget = "development";
type PostgresClientRunner = "host" | "docker";

const VALID_TARGETS: DrillTarget[] = ["development"];
const POSTGRES_TOOL_BINARIES = ["psql", "pg_dump", "pg_restore"] as const;
const DOCKER_COMPOSE_SERVICE = "postgres";

export interface RestoreDrillArgs {
  target: DrillTarget;
  confirm: boolean;
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
): RestoreDrillArgs {
  let target: DrillTarget | undefined;
  let confirm = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--target" || arg === "-t") {
      const value = argv[++i];
      if (!value || !VALID_TARGETS.includes(value as DrillTarget)) {
        throw new Error(
          `Invalid --target. Must be one of: ${VALID_TARGETS.join(", ")}`,
        );
      }
      target = value as DrillTarget;
    } else if (arg === "--confirm") {
      confirm = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  if (!target) {
    target = env.RESTORE_DRILL_TARGET as DrillTarget | undefined;
  }

  if (!target || !VALID_TARGETS.includes(target)) {
    throw new Error(
      `--target is required (or RESTORE_DRILL_TARGET). Must be one of: ${VALID_TARGETS.join(", ")}`,
    );
  }

  return {
    target,
    confirm,
    dryRun,
  };
}

export function assertSafeDrillTarget(
  args: RestoreDrillArgs,
  env: Record<string, string | undefined>,
): void {
  if (!args.confirm) {
    throw new Error(
      "Refusing to run: --confirm was not provided. This command creates and drops databases.",
    );
  }

  if (args.target !== "development") {
    throw new Error(
      "This drill is restricted to local development targets. Preview/production drills must be performed manually with a documented procedure.",
    );
  }

  if (looksLikeProduction(env)) {
    throw new Error(
      "Refusing to run: the current environment looks like Production.",
    );
  }
}

export function resolveDrillSourceDatabaseUrl(
  env: Record<string, string | undefined>,
): string {
  const url = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;

  if (!url) {
    throw new Error(
      "DATABASE_URL is required. Provide the source database connection string.",
    );
  }

  const parsed = parsePostgresqlUrl(url);

  if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error(
      "Restore drill is only allowed against a local database (localhost or 127.0.0.1).",
    );
  }

  return url;
}

export function buildAdminConnectionString(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  url.pathname = "/postgres";
  return url.toString();
}

export function buildDrillDatabaseName(): string {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString("hex");
  return `sarbase_drill_${timestamp}_${random}`;
}

export function buildDrillConnectionString(
  sourceUrl: string,
  drillDatabaseName: string,
): string {
  const url = new URL(sourceUrl);
  url.pathname = `/${drillDatabaseName}`;
  return url.toString();
}

export function commandExists(command: string): boolean {
  const result = spawnSync(`${command} --version`, {
    stdio: "ignore",
    shell: true,
  });
  return result.status === 0;
}

export function dockerComposeServiceHealthy(service: string): boolean {
  const result = spawnSync(
    "docker",
    ["compose", "ps", service, "--format", "json"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf-8",
    },
  );

  if (result.status !== 0 || !result.stdout) {
    return false;
  }

  let parsed: unknown;
  try {
    const text = result.stdout.toString().trim();
    parsed = JSON.parse(text.startsWith("[") ? text : `[${text}]`);
  } catch {
    return false;
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.some(
    (entry) =>
      entry != null &&
      typeof entry === "object" &&
      "State" in entry &&
      typeof entry.State === "string" &&
      entry.State.toLowerCase() === "running",
  );
}

export function resolveClientRunner(): PostgresClientRunner {
  if (dockerComposeServiceHealthy(DOCKER_COMPOSE_SERVICE)) {
    return "docker";
  }

  const missing = POSTGRES_TOOL_BINARIES.filter(
    (binary) => !commandExists(binary),
  );

  if (missing.length === 0) {
    console.log(
      "Docker Compose PostgreSQL service is not running; falling back to host PostgreSQL client tools.",
    );
    return "host";
  }

  throw new Error(
    "Restore drill requires either the Docker Compose PostgreSQL service " +
      `'${DOCKER_COMPOSE_SERVICE}' to be running, or the PostgreSQL client tools ` +
      `(${POSTGRES_TOOL_BINARIES.join(", ")}) to be installed on the host. ` +
      "Docker is unavailable or the service is not running, and the following " +
      `host binaries are missing: ${missing.join(", ")}.`,
  );
}

function logDryRunCommand(parts: readonly string[]): void {
  console.log("Would run:", sanitizeCommandForLogging(parts).join(" "));
}

/**
 * Inside the compose container the postgres server is always
 * localhost:5432 regardless of the host-side port mapping.
 */
function dockerClientToolCredentials(
  sourceUrl: string,
): ReturnType<typeof parsePostgresCredentials> {
  const parsed = parsePostgresCredentials(sourceUrl);
  return {
    ...parsed,
    host: "localhost",
    port: "5432",
  };
}

function prepareDockerPgPass(
  creds: ReturnType<typeof parsePostgresCredentials>,
): string {
  const tempPath = path.join(
    os.tmpdir(),
    `sarbase_drill_pgpass_${crypto.randomBytes(8).toString("hex")}`,
  );
  fs.writeFileSync(tempPath, buildPgPassContent(creds), { mode: 0o600 });
  return tempPath;
}

function copyPgPassToContainer(hostPath: string, containerPath: string): void {
  const copyResult = spawnSync(
    "docker",
    ["compose", "cp", hostPath, `${DOCKER_COMPOSE_SERVICE}:${containerPath}`],
    {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
      env: process.env,
    },
  );

  if (copyResult.status !== 0) {
    const stderr = copyResult.stderr?.toString().trim() ?? "";
    throw new Error(
      `docker compose cp failed: ${copyResult.status ?? copyResult.signal ?? "unknown"}${stderr ? ` (${stderr})` : ""}`,
    );
  }

  const chmodResult = spawnSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      DOCKER_COMPOSE_SERVICE,
      "chmod",
      "600",
      containerPath,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
      env: process.env,
    },
  );

  if (chmodResult.status !== 0) {
    const stderr = chmodResult.stderr?.toString().trim() ?? "";
    throw new Error(
      `docker compose chmod pgpass failed: ${chmodResult.status ?? chmodResult.signal ?? "unknown"}${stderr ? ` (${stderr})` : ""}`,
    );
  }
}

function removeContainerPath(containerPath: string): void {
  spawnSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      DOCKER_COMPOSE_SERVICE,
      "rm",
      "-f",
      containerPath,
    ],
    { stdio: "ignore", cwd: process.cwd(), env: process.env },
  );
}

function runSqlAdmin(
  runner: PostgresClientRunner,
  adminUrl: string,
  sql: string,
  dryRun: boolean,
): void {
  const creds =
    runner === "docker"
      ? dockerClientToolCredentials(adminUrl)
      : parsePostgresCredentials(adminUrl);

  const psqlArgs = [
    "--host",
    creds.host,
    "--port",
    creds.port,
    "--username",
    creds.user,
    "--dbname",
    "postgres",
    "-c",
    sql,
    "--quiet",
  ];

  if (runner === "docker") {
    const baseArgs = ["compose", "exec", "-T", DOCKER_COMPOSE_SERVICE, "psql"];
    if (dryRun) {
      logDryRunCommand(["docker", ...baseArgs, ...psqlArgs]);
      return;
    }

    const containerPgPassPath = `/tmp/sarbase_drill_pgpass_${crypto.randomBytes(8).toString("hex")}`;
    const hostPgPassPath = prepareDockerPgPass(creds);

    try {
      copyPgPassToContainer(hostPgPassPath, containerPgPassPath);

      const result = spawnSync("docker", [...baseArgs, ...psqlArgs], {
        stdio: "inherit",
        cwd: process.cwd(),
        env: {
          ...process.env,
          PGPASSFILE: containerPgPassPath,
        },
      });

      if (result.status !== 0) {
        throw new Error(
          `docker compose psql failed: ${result.status ?? result.signal ?? "unknown"}`,
        );
      }
    } finally {
      removeContainerPath(containerPgPassPath);
      try {
        fs.unlinkSync(hostPgPassPath);
      } catch {
        // ignore cleanup failure
      }
    }

    return;
  }

  if (dryRun) {
    logDryRunCommand(["psql", ...psqlArgs]);
    return;
  }

  const result = spawnSync("psql", psqlArgs, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, ...buildPostgresEnv(creds) },
  });

  if (result.status !== 0) {
    throw new Error(
      `psql failed: ${result.status ?? result.signal ?? "unknown"}`,
    );
  }
}

function runPrismaMigrateDeploy(databaseUrl: string, dryRun: boolean): void {
  const command =
    process.platform === "win32"
      ? "npx.cmd prisma migrate deploy"
      : "npx prisma migrate deploy";

  if (dryRun) {
    console.log("Would run:", command, "with DATABASE_URL=<drill-url>");
    return;
  }

  const result = spawnSync(command, {
    stdio: "inherit",
    shell: true,
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  if (result.status !== 0) {
    throw new Error(
      `prisma migrate deploy failed with exit code ${result.status ?? result.signal ?? "unknown"}`,
    );
  }
}

function runPgDump(
  runner: PostgresClientRunner,
  databaseUrl: string,
  outputPath: string,
  dryRun: boolean,
): void {
  const creds =
    runner === "docker"
      ? dockerClientToolCredentials(databaseUrl)
      : parsePostgresCredentials(databaseUrl);

  const pgDumpArgs = [
    "--format=custom",
    "--host",
    creds.host,
    "--port",
    creds.port,
    "--username",
    creds.user,
    "--dbname",
    creds.database,
  ];

  if (runner === "docker") {
    const baseArgs = [
      "compose",
      "exec",
      "-T",
      DOCKER_COMPOSE_SERVICE,
      "pg_dump",
    ];

    if (dryRun) {
      logDryRunCommand([
        "docker",
        ...baseArgs,
        ...pgDumpArgs,
        "--file",
        "/tmp/backup.dump",
      ]);
      return;
    }

    const containerPgPassPath = `/tmp/sarbase_drill_pgpass_${crypto.randomBytes(8).toString("hex")}`;
    const hostPgPassPath = prepareDockerPgPass(creds);

    try {
      copyPgPassToContainer(hostPgPassPath, containerPgPassPath);

      const result = spawnSync("docker", [...baseArgs, ...pgDumpArgs], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: process.cwd(),
        env: {
          ...process.env,
          PGPASSFILE: containerPgPassPath,
        },
        encoding: "buffer",
        maxBuffer: 1024 * 1024 * 1024,
      });

      if (result.status !== 0) {
        const stderr = result.stderr?.toString().trim() ?? "";
        throw new Error(
          `docker compose pg_dump failed: ${result.status ?? result.signal ?? "unknown"}${stderr ? ` (${stderr})` : ""}`,
        );
      }

      fs.writeFileSync(outputPath, result.stdout ?? Buffer.from(""));
    } finally {
      removeContainerPath(containerPgPassPath);
      try {
        fs.unlinkSync(hostPgPassPath);
      } catch {
        // ignore cleanup failure
      }
    }

    return;
  }

  const args = [...pgDumpArgs, "--file", outputPath];

  if (dryRun) {
    logDryRunCommand(["pg_dump", ...args]);
    return;
  }

  const result = spawnSync("pg_dump", args, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, ...buildPostgresEnv(creds) },
  });

  if (result.status !== 0) {
    throw new Error("pg_dump failed during drill");
  }
}

function runPgRestore(
  runner: PostgresClientRunner,
  databaseUrl: string,
  backupPath: string,
  dryRun: boolean,
): void {
  const creds =
    runner === "docker"
      ? dockerClientToolCredentials(databaseUrl)
      : parsePostgresCredentials(databaseUrl);

  const containerBackupPath = `/tmp/${path.basename(backupPath)}`;

  const pgRestoreArgs = [
    "--clean",
    "--if-exists",
    "--host",
    creds.host,
    "--port",
    creds.port,
    "--username",
    creds.user,
    "--dbname",
    creds.database,
  ];

  if (runner === "docker") {
    const baseArgs = [
      "compose",
      "exec",
      "-T",
      DOCKER_COMPOSE_SERVICE,
      "pg_restore",
    ];

    if (dryRun) {
      logDryRunCommand([
        "docker",
        "compose",
        "cp",
        backupPath,
        `${DOCKER_COMPOSE_SERVICE}:${containerBackupPath}`,
      ]);
      logDryRunCommand([
        "docker",
        ...baseArgs,
        ...pgRestoreArgs,
        containerBackupPath,
      ]);
      logDryRunCommand([
        "docker",
        "compose",
        "exec",
        DOCKER_COMPOSE_SERVICE,
        "rm",
        "-f",
        containerBackupPath,
      ]);
      return;
    }

    const copyResult = spawnSync(
      "docker",
      [
        "compose",
        "cp",
        backupPath,
        `${DOCKER_COMPOSE_SERVICE}:${containerBackupPath}`,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: process.cwd(),
        env: process.env,
      },
    );

    if (copyResult.status !== 0) {
      const stderr = copyResult.stderr?.toString().trim() ?? "";
      throw new Error(
        `docker compose cp failed: ${copyResult.status ?? copyResult.signal ?? "unknown"}${stderr ? ` (${stderr})` : ""}`,
      );
    }

    const containerPgPassPath = `/tmp/sarbase_drill_pgpass_${crypto.randomBytes(8).toString("hex")}`;
    const hostPgPassPath = prepareDockerPgPass(creds);

    try {
      copyPgPassToContainer(hostPgPassPath, containerPgPassPath);

      const result = spawnSync(
        "docker",
        [...baseArgs, ...pgRestoreArgs, containerBackupPath],
        {
          stdio: "inherit",
          cwd: process.cwd(),
          env: {
            ...process.env,
            PGPASSFILE: containerPgPassPath,
          },
        },
      );

      if (result.status !== 0) {
        throw new Error(
          `docker compose pg_restore failed: ${result.status ?? result.signal ?? "unknown"}`,
        );
      }
    } finally {
      removeContainerPath(containerPgPassPath);
      removeContainerPath(containerBackupPath);
      try {
        fs.unlinkSync(hostPgPassPath);
      } catch {
        // ignore cleanup failure
      }
    }

    return;
  }

  const args = [...pgRestoreArgs, backupPath];

  if (dryRun) {
    logDryRunCommand(["pg_restore", ...args]);
    return;
  }

  const result = spawnSync("pg_restore", args, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, ...buildPostgresEnv(creds) },
  });

  if (result.status !== 0) {
    throw new Error("pg_restore failed during drill");
  }
}

function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl });
}

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env);
  assertSafeDrillTarget(args, process.env);

  const sourceUrl = resolveDrillSourceDatabaseUrl(process.env);
  const parsedSource = parsePostgresqlUrl(sourceUrl);
  const adminUrl = buildAdminConnectionString(sourceUrl);
  const drillDatabaseName = buildDrillDatabaseName();
  const drillUrl = buildDrillConnectionString(sourceUrl, drillDatabaseName);

  console.log("Restore drill target:", args.target);
  console.log("Source host:", parsedSource.hostname);
  console.log("Source database:", parsedSource.database);
  console.log("Drill database:", drillDatabaseName);

  if (args.dryRun) {
    console.log("Dry run complete. No databases were created or modified.");
    return;
  }

  const runner = resolveClientRunner();
  console.log("PostgreSQL client runner:", runner);

  const tempBackupPath = path.join(os.tmpdir(), `${drillDatabaseName}.dump`);
  const cleanupDatabases = new Set<string>();

  try {
    runSqlAdmin(
      runner,
      adminUrl,
      `CREATE DATABASE "${drillDatabaseName}"`,
      args.dryRun,
    );
    cleanupDatabases.add(drillDatabaseName);

    runPrismaMigrateDeploy(drillUrl, args.dryRun);

    const prisma = createPrismaClient(drillUrl);
    const fixtureLabel = `drill-${Date.now()}`;
    const created = await prisma.bootstrapItem.create({
      data: { label: fixtureLabel },
    });
    const createdId = created.id;
    console.log("Created synthetic row:", createdId);
    await prisma.$disconnect();

    runPgDump(runner, drillUrl, tempBackupPath, args.dryRun);
    console.log("Backup created:", tempBackupPath);

    const prismaAfterDelete = createPrismaClient(drillUrl);
    await prismaAfterDelete.bootstrapItem.delete({ where: { id: createdId } });
    console.log("Deleted synthetic row to simulate data loss");
    await prismaAfterDelete.$disconnect();

    runPgRestore(runner, drillUrl, tempBackupPath, args.dryRun);

    const prismaAfterRestore = createPrismaClient(drillUrl);
    const restored = await prismaAfterRestore.bootstrapItem.findUnique({
      where: { id: createdId },
    });

    if (!restored) {
      throw new Error(
        "Restore validation failed: synthetic row was not recovered.",
      );
    }

    if (restored.label !== fixtureLabel) {
      throw new Error(
        "Restore validation failed: recovered row does not match.",
      );
    }

    console.log("Restore validation passed. Recovered row:", restored.id);
    await prismaAfterRestore.$disconnect();

    runPrismaMigrateDeploy(drillUrl, args.dryRun);
    console.log("Migration state is consistent after restore.");
  } finally {
    for (const dbName of cleanupDatabases) {
      try {
        runSqlAdmin(
          runner,
          adminUrl,
          `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`,
          args.dryRun,
        );
        console.log("Cleaned up drill database:", dbName);
      } catch (error) {
        console.error("Failed to clean up drill database:", dbName, error);
      }
    }

    try {
      if (fs.existsSync(tempBackupPath)) {
        fs.unlinkSync(tempBackupPath);
        console.log("Cleaned up temp backup:", tempBackupPath);
      }
    } catch (error) {
      console.error("Failed to clean up temp backup:", tempBackupPath, error);
    }
  }
}

if (
  import.meta.url ===
  pathToFileURL(process.argv[1] ?? "scripts/restore-drill.ts").href
) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
