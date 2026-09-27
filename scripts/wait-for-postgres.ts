import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Bounded readiness gate for the docker-compose Postgres service.
 *
 * Why this exists: the postgres image entrypoint starts a temporary
 * initdb-time server that accepts connections on the unix socket only
 * (it is launched with `listen_addresses=''`), then shuts it down before
 * the final server starts. `pg_isready` probes the socket, so it can
 * report "ready" against the temporary server — and a following step
 * (createdb, migrate) then races the shutdown window. That exact race
 * produced an intermittent CI failure in this template's workflow.
 *
 * This gate instead runs a real query over TCP inside the container
 * (`psql -h 127.0.0.1`), which can only succeed against the final
 * server, and requires several consecutive successes before declaring
 * readiness — so a mid-startup flap cannot slip through either.
 *
 * Credentials come from the container's own POSTGRES_* environment via
 * `sh -c`, so nothing is hardcoded or logged.
 *
 * Usage: npm run db:wait   (or: tsx scripts/wait-for-postgres.ts)
 */

const DEFAULT_SERVICE = "postgres";
const DEFAULT_CONSECUTIVE = 3;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_INTERVAL_MS = 1_000;

export interface ProbeResult {
  ok: boolean;
  stderr: string;
}

export type Probe = (args: string[]) => ProbeResult;

export interface WaitOptions {
  service?: string;
  /** Consecutive successful probes required before declaring ready. */
  consecutive?: number;
  /** Overall deadline in ms. */
  timeoutMs?: number;
  /** Delay between attempts in ms. */
  intervalMs?: number;
  probe?: Probe;
  /** Service-log dump appended to the failure diagnostics. */
  dumpLogs?: (service: string) => string;
  log?: (message: string) => void;
}

/**
 * The probe runs a real SQL query over TCP inside the container. The
 * initdb-time server never listens on TCP, so a successful probe can
 * only mean the final server is up.
 */
export function buildProbeArgs(service: string): string[] {
  return [
    "compose",
    "exec",
    "-T",
    service,
    "sh",
    "-c",
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d postgres -tAc "select 1"',
  ];
}

const defaultProbe: Probe = (args) => {
  const result = spawnSync("docker", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  return {
    ok: result.status === 0 && (result.stdout ?? "").trim() === "1",
    stderr: (result.stderr ?? result.error?.message ?? "").trim(),
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function dumpServiceLogs(service: string): string {
  const result = spawnSync(
    "docker",
    ["compose", "logs", "--tail", "80", service],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
  );
  return (result.stdout ?? "") + (result.stderr ?? "");
}

export async function waitForPostgres(
  options: WaitOptions = {},
): Promise<void> {
  const service = options.service ?? DEFAULT_SERVICE;
  const consecutive = options.consecutive ?? DEFAULT_CONSECUTIVE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const probe = options.probe ?? defaultProbe;
  const dumpLogs = options.dumpLogs ?? dumpServiceLogs;
  const log = options.log ?? console.log;

  const args = buildProbeArgs(service);
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let streak = 0;
  let lastError = "";

  while (Date.now() < deadline) {
    attempts += 1;
    const result = probe(args);
    if (result.ok) {
      streak += 1;
      if (streak >= consecutive) {
        log(
          `postgres service "${service}" is ready: ${streak} consecutive successful probes over ${attempts} attempt(s)`,
        );
        return;
      }
    } else {
      if (streak > 0) {
        log(
          `readiness probe failed after ${streak} consecutive success(es) — resetting streak`,
        );
      }
      streak = 0;
      lastError = result.stderr;
    }
    await sleep(intervalMs);
  }

  const logs = dumpLogs(service);
  throw new Error(
    `postgres service "${service}" did not become ready within ${timeoutMs}ms ` +
      `(${attempts} attempts). Last probe error: ${lastError || "none"}\n` +
      `--- docker compose logs ${service} (tail) ---\n${logs.trim() || "(no output)"}`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flagIndex = argv.indexOf("--service");
  const service =
    flagIndex !== -1 && argv[flagIndex + 1]
      ? argv[flagIndex + 1]
      : DEFAULT_SERVICE;

  await waitForPostgres({ service });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
