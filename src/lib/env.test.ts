import { afterEach, describe, expect, it, vi } from "vitest";

import {
  arePostgresqlUrlsSameDatabase,
  firebaseClientEnvironmentValues,
  normalizeDatabaseEndpoint,
  parseAppEnvironment,
  parseDatabaseAdminEnvironment,
  parseDatabaseEnvironment,
  parsePostgresqlUrl,
  tryParseFirebaseClientEnvironment,
} from "./env";

const POOLED =
  "postgresql://user:pass@ep-cool-pooler.us-east-2.aws.neon.tech/appdb?sslmode=require";
const UNPOOLED =
  "postgresql://user:pass@ep-cool.us-east-2.aws.neon.tech/appdb?sslmode=require";

describe("parsePostgresqlUrl", () => {
  it("parses a valid connection string", () => {
    const parsed = parsePostgresqlUrl(UNPOOLED);
    expect(parsed.hostname).toBe("ep-cool.us-east-2.aws.neon.tech");
    expect(parsed.database).toBe("appdb");
    expect(parsed.username).toBe("user");
    expect(parsed.password).toBe("pass");
  });

  it("rejects the Vercel [SENSITIVE] placeholder", () => {
    expect(() => parsePostgresqlUrl("[SENSITIVE]")).toThrow(
      "[SENSITIVE] placeholder",
    );
  });

  it("rejects non-postgres schemes", () => {
    expect(() => parsePostgresqlUrl("https://example.com/db")).toThrow(
      "postgres:// or postgresql://",
    );
  });

  it("rejects URLs without a database name", () => {
    expect(() =>
      parsePostgresqlUrl("postgresql://user:pass@host.example.com"),
    ).toThrow("database name");
  });
});

describe("normalizeDatabaseEndpoint", () => {
  it("strips the Neon -pooler suffix", () => {
    expect(
      normalizeDatabaseEndpoint("ep-cool-pooler.us-east-2.aws.neon.tech"),
    ).toBe("ep-cool.us-east-2.aws.neon.tech");
  });

  it("leaves non-Neon hostnames alone", () => {
    expect(normalizeDatabaseEndpoint("localhost")).toBe("localhost");
  });
});

describe("arePostgresqlUrlsSameDatabase", () => {
  it("is true for Neon pooled/unpooled endpoints of one branch", () => {
    expect(arePostgresqlUrlsSameDatabase(POOLED, UNPOOLED)).toBe(true);
  });

  it("is false for different databases on the same endpoint", () => {
    const other = UNPOOLED.replace("/appdb", "/otherdb");
    expect(arePostgresqlUrlsSameDatabase(POOLED, other)).toBe(false);
  });

  it("is false for different Neon endpoints", () => {
    const other = UNPOOLED.replace("ep-cool", "ep-other");
    expect(arePostgresqlUrlsSameDatabase(POOLED, other)).toBe(false);
  });
});

describe("parseDatabaseEnvironment", () => {
  it("returns DATABASE_URL when valid", () => {
    expect(
      parseDatabaseEnvironment({ DATABASE_URL: POOLED }).DATABASE_URL,
    ).toBe(POOLED);
  });

  it("fails when DATABASE_URL is missing", () => {
    expect(() => parseDatabaseEnvironment({})).toThrow();
  });
});

describe("parseDatabaseAdminEnvironment", () => {
  it("accepts pooled + unpooled endpoints of the same database", () => {
    const env = parseDatabaseAdminEnvironment({
      DATABASE_URL: POOLED,
      DATABASE_URL_UNPOOLED: UNPOOLED,
    });
    expect(env.DATABASE_URL_UNPOOLED).toBe(UNPOOLED);
  });

  it("rejects pooled/unpooled URLs pointing at different databases", () => {
    expect(() =>
      parseDatabaseAdminEnvironment({
        DATABASE_URL: POOLED,
        DATABASE_URL_UNPOOLED: UNPOOLED.replace("/appdb", "/otherdb"),
      }),
    ).toThrow("same database");
  });
});

const FIREBASE_CLIENT_ENV_KEYS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
] as const;

const FIREBASE_CLIENT_ENV = {
  NEXT_PUBLIC_FIREBASE_API_KEY: "test-api-key",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "test.firebaseapp.com",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "test-project",
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:0:web:test",
} as const;

function stubFirebaseClientEnv() {
  for (const key of FIREBASE_CLIENT_ENV_KEYS) {
    vi.stubEnv(key, FIREBASE_CLIENT_ENV[key]);
  }
}

function clearFirebaseClientEnv() {
  for (const key of FIREBASE_CLIENT_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
}

describe("firebaseClientEnvironmentValues", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads each NEXT_PUBLIC_FIREBASE_* variable by explicit reference", () => {
    stubFirebaseClientEnv();

    expect(firebaseClientEnvironmentValues()).toEqual(FIREBASE_CLIENT_ENV);
  });

  it("reports absent variables as undefined rather than dropping keys", () => {
    clearFirebaseClientEnv();

    const values = firebaseClientEnvironmentValues();
    for (const key of FIREBASE_CLIENT_ENV_KEYS) {
      expect(values[key]).toBeUndefined();
    }
  });
});

describe("tryParseFirebaseClientEnvironment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses an explicit values object", () => {
    expect(tryParseFirebaseClientEnvironment(FIREBASE_CLIENT_ENV)).toEqual(
      FIREBASE_CLIENT_ENV,
    );
  });

  it("returns null for explicit missing or partial values", () => {
    expect(tryParseFirebaseClientEnvironment({})).toBeNull();

    const partial: Record<string, string> = { ...FIREBASE_CLIENT_ENV };
    delete partial.NEXT_PUBLIC_FIREBASE_APP_ID;
    expect(tryParseFirebaseClientEnvironment(partial)).toBeNull();
  });

  it("parses the default public env values when they are set", () => {
    stubFirebaseClientEnv();

    expect(tryParseFirebaseClientEnvironment()).toEqual(FIREBASE_CLIENT_ENV);
  });

  it("returns null when the default public env values are absent", () => {
    clearFirebaseClientEnv();

    expect(tryParseFirebaseClientEnvironment()).toBeNull();
  });
});

describe("parseAppEnvironment", () => {
  it("accepts a plain production DB hostname", () => {
    expect(
      parseAppEnvironment({
        APP_PRODUCTION_DB_HOST: "ep-prod.us-east-2.aws.neon.tech",
      }).APP_PRODUCTION_DB_HOST,
    ).toBe("ep-prod.us-east-2.aws.neon.tech");
  });

  it("rejects a production host containing a URL", () => {
    expect(() =>
      parseAppEnvironment({
        APP_PRODUCTION_DB_HOST: "postgresql://host/db",
      }),
    ).toThrow();
  });
});
