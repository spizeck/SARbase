import { describe, expect, it } from "vitest";

import {
  arePostgresqlUrlsSameDatabase,
  normalizeDatabaseEndpoint,
  parseAppEnvironment,
  parseDatabaseAdminEnvironment,
  parseDatabaseEnvironment,
  parsePostgresqlUrl,
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
