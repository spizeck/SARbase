import { z } from "zod";

/**
 * Lazy, per-concern environment parsing.
 *
 * Derived from the Sea Saba `src/env.ts` pattern — the canonical model
 * across the audited repositories:
 *
 * - LAZY: nothing in this module reads `process.env` at import time.
 *   Each `parse*Environment(values?)` call validates only the variables
 *   its concern needs, at the moment they are needed. `next build` with
 *   zero env vars must keep working — never call a parser at module
 *   top level or in a shared import chain.
 * - PER-CONCERN: a malformed unrelated variable must not break a
 *   feature that doesn't use it. Add a new narrow parser per concern
 *   rather than growing one monolithic env schema.
 * - FAIL AT THE BOUNDARY: invalid configuration throws a named error at
 *   parse time, not a cryptic driver failure later.
 */

const DEFAULT_POSTGRESQL_PORT = 5432;

export interface ParsedPostgresqlUrl {
  protocol: string;
  username: string;
  password: string;
  hostname: string;
  port: string;
  database: string;
}

/**
 * Parse a PostgreSQL connection string into components.
 * Rejects Vercel's `[SENSITIVE]` placeholder values — a real class of
 * production bug where a masked variable is copied verbatim into a
 * second environment and fails as an opaque connection error.
 */
export function parsePostgresqlUrl(
  value: string,
  variable = "DATABASE_URL",
): ParsedPostgresqlUrl {
  if (value.startsWith("[SENSITIVE]")) {
    throw new Error(`${variable} is a Vercel [SENSITIVE] placeholder`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} is not a valid URL`);
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(
      `${variable} must use the postgres:// or postgresql:// scheme, got ${url.protocol}`,
    );
  }

  if (!url.hostname) {
    throw new Error(`${variable} must include a hostname`);
  }

  const database = url.pathname.replace(/^\//, "");
  if (!database) {
    throw new Error(`${variable} must include a database name`);
  }

  return {
    protocol: url.protocol,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    hostname: url.hostname,
    port: url.port,
    database,
  };
}

function isNeonHostname(hostname: string): boolean {
  return hostname.endsWith(".neon.tech") || hostname.endsWith(".neon.build");
}

/**
 * Neon pooled and unpooled endpoints for the same branch differ only by
 * a `-pooler` suffix on the first hostname label. Normalizing removes
 * it so pooled/unpooled URLs can be compared for same-database safety.
 */
export function normalizeDatabaseEndpoint(hostname: string): string {
  if (!isNeonHostname(hostname)) {
    return hostname;
  }

  const labels = hostname.split(".");
  if (labels[0]?.endsWith("-pooler")) {
    labels[0] = labels[0].slice(0, -"-pooler".length);
  }

  return labels.join(".");
}

function effectivePostgresqlPort(parsed: ParsedPostgresqlUrl): number {
  if (!parsed.port) {
    return DEFAULT_POSTGRESQL_PORT;
  }

  const port = Number.parseInt(parsed.port, 10);
  return Number.isNaN(port) ? DEFAULT_POSTGRESQL_PORT : port;
}

/**
 * True when two connection strings resolve to the same database —
 * used to prove DATABASE_URL and DATABASE_URL_UNPOOLED are the pooled
 * and direct endpoints of ONE database rather than two different ones
 * (a misconfiguration that silently migrates the wrong database).
 */
export function arePostgresqlUrlsSameDatabase(
  pooledUrl: string,
  unpooledUrl: string,
): boolean {
  const pooled = parsePostgresqlUrl(pooledUrl);
  const unpooled = parsePostgresqlUrl(unpooledUrl);

  return (
    normalizeDatabaseEndpoint(pooled.hostname) ===
      normalizeDatabaseEndpoint(unpooled.hostname) &&
    effectivePostgresqlPort(pooled) === effectivePostgresqlPort(unpooled) &&
    pooled.database === unpooled.database
  );
}

const postgresqlUrlSchema = (variable: string) =>
  z.string({ message: `${variable} is required` }).superRefine((value, ctx) => {
    try {
      parsePostgresqlUrl(value, variable);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message:
          error instanceof Error
            ? error.message
            : `${variable} must be a valid PostgreSQL connection string`,
      });
    }
  });

/** Runtime queries: the pooled endpoint. */
export const databaseEnvironmentSchema = z.object({
  DATABASE_URL: postgresqlUrlSchema("DATABASE_URL"),
});

export type DatabaseEnvironment = z.infer<typeof databaseEnvironmentSchema>;

export function parseDatabaseEnvironment(
  values: Record<string, string | undefined> = process.env,
): DatabaseEnvironment {
  return databaseEnvironmentSchema.parse(values);
}

/**
 * Migration/seed/backup concern: the unpooled endpoint plus proof that
 * pooled and unpooled URLs point at the same database. PgBouncer-pooled
 * connections break session-level migration locks — admin operations
 * must never go through the pooler.
 */
export const databaseAdminEnvironmentSchema = z
  .object({
    DATABASE_URL: postgresqlUrlSchema("DATABASE_URL"),
    DATABASE_URL_UNPOOLED: postgresqlUrlSchema(
      "DATABASE_URL_UNPOOLED",
    ).optional(),
  })
  .superRefine((env, ctx) => {
    if (
      env.DATABASE_URL_UNPOOLED &&
      !arePostgresqlUrlsSameDatabase(
        env.DATABASE_URL,
        env.DATABASE_URL_UNPOOLED,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_URL_UNPOOLED"],
        message:
          "DATABASE_URL_UNPOOLED must be the direct endpoint of the same database as DATABASE_URL (pooled and unpooled resolve to different databases)",
      });
    }
  });

export type DatabaseAdminEnvironment = z.infer<
  typeof databaseAdminEnvironmentSchema
>;

export function parseDatabaseAdminEnvironment(
  values: Record<string, string | undefined> = process.env,
): DatabaseAdminEnvironment {
  return databaseAdminEnvironmentSchema.parse(values);
}

/** Deployment/topology concern used by migration gating and scripts. */
export const appEnvironmentSchema = z.object({
  APP_PRODUCTION_DB_HOST: z
    .string()
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9\-.]*[a-zA-Z0-9]$/,
      "APP_PRODUCTION_DB_HOST must be a plain hostname",
    )
    .optional(),
  VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
});

export type AppEnvironment = z.infer<typeof appEnvironmentSchema>;

export function parseAppEnvironment(
  values: Record<string, string | undefined> = process.env,
): AppEnvironment {
  return appEnvironmentSchema.parse(values);
}

/**
 * Browser-side Firebase Auth configuration (NEXT_PUBLIC_* — embedded in
 * the client bundle by definition, never secret). Required only where
 * the sign-in UI runs; absent config must degrade to "authentication
 * not configured", never to a crash or a permissive path.
 */
export const firebaseClientEnvironmentSchema = z.object({
  NEXT_PUBLIC_FIREBASE_API_KEY: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_APP_ID: z.string().min(1),
});

export type FirebaseClientEnvironment = z.infer<
  typeof firebaseClientEnvironmentSchema
>;

/** Non-throwing variant — the login UI checks "is auth configured?" */
export function tryParseFirebaseClientEnvironment(
  values: Record<string, string | undefined> = process.env,
): FirebaseClientEnvironment | null {
  const result = firebaseClientEnvironmentSchema.safeParse(values);
  return result.success ? result.data : null;
}

/**
 * Server-side Firebase Admin credentials — used only to verify ID
 * tokens and mint/revoke session cookies. Never imported into client
 * bundles. PRIVATE_KEY arrives with escaped newlines from every env
 * provider; normalize here so consumers get a real PEM.
 */
export const firebaseAdminEnvironmentSchema = z.object({
  FIREBASE_ADMIN_PROJECT_ID: z.string().min(1),
  FIREBASE_ADMIN_CLIENT_EMAIL: z.string().min(1),
  FIREBASE_ADMIN_PRIVATE_KEY: z
    .string()
    .min(1)
    .transform((key) => key.replace(/\\n/g, "\n")),
});

export type FirebaseAdminEnvironment = z.infer<
  typeof firebaseAdminEnvironmentSchema
>;

export function parseFirebaseAdminEnvironment(
  values: Record<string, string | undefined> = process.env,
): FirebaseAdminEnvironment {
  return firebaseAdminEnvironmentSchema.parse(values);
}

/** Non-throwing variant for "is server auth configured?" checks. */
export function isFirebaseAdminConfigured(
  values: Record<string, string | undefined> = process.env,
): boolean {
  return firebaseAdminEnvironmentSchema.safeParse(values).success;
}
