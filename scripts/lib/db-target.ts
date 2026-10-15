/**
 * Shared database-target parsing for operator scripts (seed, verify,
 * provisioning). Distinct from src/lib/env.ts's parsePostgresqlUrl: this
 * variant also refuses connection strings whose QUERY PARAMETERS could
 * retarget the driver past the host the guard just validated — pg
 * tooling honors `host`/`hostaddr`/`port`/`database`/`dbname`/`service`
 * overrides, so an authority-level hostname check alone is not a
 * boundary.
 *
 * Provenance: the-bottom-line's scripts/lib/db-safety.ts (itself derived
 * from app-foundations modules/database-test-safety), reduced to the
 * target-identity primitives SARbase's lifecycle scripts need.
 */

export class DatabaseTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseTargetError";
  }
}

export interface ParsedDatabaseTarget {
  hostname: string;
  port: string;
  database: string;
}

/** Loopback hosts are definitionally local — a remote-database guard
 *  never needs to distrust them. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

// Query parameters that can retarget the connection past the URL the
// guard validated. pg-connection-string maps "host" and "port" over the
// URL authority; Prisma honors "host" as a Unix-socket directory;
// libpq-family tools accept "hostaddr", "database"/"dbname", and
// "service" (a pg_service.conf entry that can redefine every connection
// field). Compared case-insensitively — parameter name casing is not a
// safe signal across drivers.
const TARGET_OVERRIDE_PARAMS: ReadonlySet<string> = new Set([
  "host",
  "hostaddr",
  "port",
  "database",
  "dbname",
  "service",
]);

export function parseDatabaseTargetUrl(url: string): ParsedDatabaseTarget {
  if (url.startsWith("[SENSITIVE]")) {
    throw new DatabaseTargetError(
      "the connection string is a Vercel [SENSITIVE] placeholder, not a real URL",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DatabaseTargetError("the connection string is not a valid URL");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new DatabaseTargetError(
      `the connection string must use postgres:// or postgresql:// (got "${parsed.protocol}")`,
    );
  }
  for (const key of parsed.searchParams.keys()) {
    if (TARGET_OVERRIDE_PARAMS.has(key.toLowerCase())) {
      throw new DatabaseTargetError(
        `the connection string overrides "${key}" via query parameter — ` +
          `refused, because drivers can honor it over the URL's own ` +
          `host, port, or database`,
      );
    }
  }
  if (!parsed.hostname) {
    throw new DatabaseTargetError("the connection string has no hostname");
  }
  const database = parsed.pathname.replace(/^\//, "");
  if (!database) {
    throw new DatabaseTargetError("the connection string has no database name");
  }

  return {
    hostname: parsed.hostname,
    port: parsed.port || "5432",
    database,
  };
}

/** Safe-for-logs description: host, port, and database name only. Never
 *  the userinfo, password, or query string. */
export function describeDatabaseTarget(url: string): string {
  try {
    const { hostname, port, database } = parseDatabaseTargetUrl(url);
    return `${hostname}:${port}/${database}`;
  } catch {
    return "(unparseable connection string)";
  }
}
