import { parsePostgresqlUrl } from "../../src/lib/env";

/**
 * Shared Postgres credential handling for operator scripts.
 * Extracted from the Sea Saba scripts/lib implementation.
 */

export interface PostgresCredentials {
  readonly protocol: string;
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export function parsePostgresCredentials(url: string): PostgresCredentials {
  const parsed = parsePostgresqlUrl(url);
  return {
    protocol: parsed.protocol,
    host: parsed.hostname,
    port: parsed.port || "5432",
    user: parsed.username,
    password: parsed.password,
    database: parsed.database,
  };
}

/**
 * Credentials passed via environment, never on the command line —
 * process args are visible in `ps` and CI logs.
 */
export function buildPostgresEnv(
  creds: PostgresCredentials,
): Record<string, string> {
  return {
    PGHOST: creds.host,
    PGPORT: creds.port,
    PGUSER: creds.user,
    PGPASSWORD: creds.password,
    PGDATABASE: creds.database,
  };
}

export function buildPgPassContent(creds: PostgresCredentials): string {
  return `${creds.host}:${creds.port}:*:${creds.user}:${creds.password}`;
}

/** Strip credentials out of anything destined for a log line. */
export function sanitizeCommandForLogging(parts: readonly string[]): string[] {
  return parts.map((part) => {
    if (/^(postgresql|postgres):\/\//i.test(part)) {
      try {
        const url = new URL(part);
        url.password = "REDACTED";
        return url.toString();
      } catch {
        return part.replace(/\/\/.*@/, "//REDACTED@");
      }
    }

    return part;
  });
}
