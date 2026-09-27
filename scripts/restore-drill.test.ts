import { describe, expect, it } from "vitest";

import {
  assertSafeDrillTarget,
  buildAdminConnectionString,
  buildDrillConnectionString,
  buildDrillDatabaseName,
  parseArgs,
  resolveDrillSourceDatabaseUrl,
} from "./restore-drill";

const baseArgs = {
  target: "development" as const,
  confirm: true,
  dryRun: false,
};

describe("restore-drill argument parsing", () => {
  it("parses a confirmed development drill", () => {
    const args = parseArgs(["--target", "development", "--confirm"], {});
    expect(args.target).toBe("development");
    expect(args.confirm).toBe(true);
  });

  it("falls back to RESTORE_DRILL_TARGET", () => {
    const args = parseArgs(["--confirm"], {
      RESTORE_DRILL_TARGET: "development",
    });
    expect(args.target).toBe("development");
  });

  it("rejects non-development targets", () => {
    expect(() => parseArgs(["--target", "production"], {})).toThrow(
      "Invalid --target",
    );
  });

  it("rejects a missing target", () => {
    expect(() => parseArgs(["--confirm"], {})).toThrow("--target is required");
  });
});

describe("restore-drill safety checks", () => {
  it("rejects missing confirmation", () => {
    expect(() =>
      assertSafeDrillTarget({ ...baseArgs, confirm: false }, {}),
    ).toThrow("--confirm was not provided");
  });

  it("rejects in a production-looking environment", () => {
    expect(() =>
      assertSafeDrillTarget(baseArgs, { VERCEL_ENV: "production" }),
    ).toThrow("looks like Production");
  });
});

describe("drill source restrictions", () => {
  it("accepts a localhost source", () => {
    const url = resolveDrillSourceDatabaseUrl({
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/sarbase_dev",
    });
    expect(url).toContain("localhost");
  });

  it("prefers the unpooled URL", () => {
    const url = resolveDrillSourceDatabaseUrl({
      DATABASE_URL: "postgresql://u:p@localhost:5433/pooled",
      DATABASE_URL_UNPOOLED: "postgresql://u:p@localhost:5433/direct",
    });
    expect(url).toContain("/direct");
  });

  it("refuses a remote host — the drill creates and drops databases", () => {
    expect(() =>
      resolveDrillSourceDatabaseUrl({
        DATABASE_URL: "postgresql://u:p@ep-cool.neon.tech/appdb",
      }),
    ).toThrow("only allowed against a local database");
  });

  it("rejects missing URLs", () => {
    expect(() => resolveDrillSourceDatabaseUrl({})).toThrow(
      "DATABASE_URL is required",
    );
  });
});

describe("drill database naming", () => {
  it("builds a collision-resistant drill database name", () => {
    const a = buildDrillDatabaseName();
    const b = buildDrillDatabaseName();
    expect(a).toMatch(/^sarbase_drill_\d+_[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });

  it("targets the postgres admin database for DDL", () => {
    const admin = buildAdminConnectionString(
      "postgresql://u:p@localhost:5433/sarbase_dev",
    );
    expect(new URL(admin).pathname).toBe("/postgres");
  });

  it("points the drill URL at the scratch database", () => {
    const drill = buildDrillConnectionString(
      "postgresql://u:p@localhost:5433/sarbase_dev",
      "sarbase_drill_1_abcdef12",
    );
    expect(new URL(drill).pathname).toBe("/sarbase_drill_1_abcdef12");
  });
});
