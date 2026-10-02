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

/**
 * Reads the public Firebase client variables via explicit references.
 *
 * Next.js only embeds a NEXT_PUBLIC_* variable into the browser bundle
 * when it is referenced literally — `process.env.NEXT_PUBLIC_FOO` is
 * inlined at build time, while the ambient `process.env` object cannot
 * be enumerated client-side. Parsing `process.env` wholesale therefore
 * always sees an empty environment in the browser and reports a
 * configured deployment as unconfigured. Build the candidate object
 * here so server and browser share one code path.
 */
export function firebaseClientEnvironmentValues(): Record<
  keyof FirebaseClientEnvironment,
  string | undefined
> {
  return {
    NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN:
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID:
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };
}

/** Non-throwing variant — the login UI checks "is auth configured?" */
export function tryParseFirebaseClientEnvironment(
  values: Record<
    string,
    string | undefined
  > = firebaseClientEnvironmentValues(),
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

/**
 * Notification delivery configuration (issue #13) — server-only.
 *
 * - NOTIFICATION_PROVIDER: explicit provider selection, "resend" or
 *   "fake". Optional; when unset the resolver picks "resend" if
 *   RESEND_API_KEY is present and otherwise fails closed in production
 *   or falls back to "fake" in development/test (see
 *   src/lib/notifications/resolve.ts for the exact rules).
 * - RESEND_API_KEY: Resend API credential. SECRET — never in client
 *   bundles, CI, or logs.
 * - NOTIFICATION_EMAIL_FROM: verified sender identity, e.g.
 *   "SARbase Notifications <notify@example.org>". Required for the
 *   resend provider.
 */
export const notificationEnvironmentSchema = z.object({
  NOTIFICATION_PROVIDER: z.enum(["resend", "fake"]).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  NOTIFICATION_EMAIL_FROM: z.string().trim().min(1).max(320).optional(),
});

export type NotificationEnvironment = z.infer<
  typeof notificationEnvironmentSchema
>;

export function parseNotificationEnvironment(
  values: Record<string, string | undefined> = process.env,
): NotificationEnvironment {
  return notificationEnvironmentSchema.parse(values);
}

/**
 * File storage configuration (issue #16) — server-only.
 *
 * - FILE_STORAGE_PROVIDER: explicit selection, "local" or "s3". In a real
 *   production deployment the resolver fails closed when it is unset;
 *   development/test may leave it unset for the local provider (see
 *   src/lib/storage/resolve.ts for the exact rules).
 * - FILE_STORAGE_LOCAL_ROOT: absolute directory the local provider stores
 *   objects under. Required for "local" except that the resolver supplies
 *   a documented development default outside the repo.
 * - FILE_STORAGE_S3_*: endpoint/bucket/region/credentials for any
 *   S3-compatible object store (AWS S3, Cloudflare R2, MinIO, ...).
 *   SECRETS — never in client bundles, CI, or logs.
 *
 * Blank values (an uncommented-but-empty .env.example line, a Vercel var
 * saved empty) normalize to undefined rather than failing validation —
 * an unset option and an empty option mean the same thing.
 */
const storageBlankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export const storageEnvironmentSchema = z.object({
  FILE_STORAGE_PROVIDER: z.preprocess(
    storageBlankToUndefined,
    z.enum(["local", "s3"]).optional(),
  ),
  FILE_STORAGE_LOCAL_ROOT: z.preprocess(
    storageBlankToUndefined,
    z
      .string()
      .trim()
      .min(1)
      .max(1024)
      .refine((root) => !root.includes(".."), {
        message: "FILE_STORAGE_LOCAL_ROOT must not contain '..'",
      })
      .optional(),
  ),
  FILE_STORAGE_S3_ENDPOINT: z.preprocess(
    storageBlankToUndefined,
    z
      .string()
      .url("FILE_STORAGE_S3_ENDPOINT must be a valid URL")
      .max(2048)
      .optional(),
  ),
  FILE_STORAGE_S3_REGION: z.preprocess(
    storageBlankToUndefined,
    z.string().trim().min(1).max(128).optional(),
  ),
  FILE_STORAGE_S3_BUCKET: z.preprocess(
    storageBlankToUndefined,
    z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(
        /^[a-zA-Z0-9.\-_]+$/,
        "FILE_STORAGE_S3_BUCKET may only contain letters, digits, '.', '-' and '_'",
      )
      .optional(),
  ),
  FILE_STORAGE_S3_ACCESS_KEY_ID: z.preprocess(
    storageBlankToUndefined,
    z.string().trim().min(1).max(512).optional(),
  ),
  FILE_STORAGE_S3_SECRET_ACCESS_KEY: z.preprocess(
    storageBlankToUndefined,
    z.string().min(1).max(2048).optional(),
  ),
});

export type StorageEnvironment = z.infer<typeof storageEnvironmentSchema>;

export function parseStorageEnvironment(
  values: Record<string, string | undefined> = process.env,
): StorageEnvironment {
  return storageEnvironmentSchema.parse(values);
}
