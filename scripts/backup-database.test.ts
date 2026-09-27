import { describe, expect, it } from "vitest";

import {
  assertSafeBackupTarget,
  buildBackupCommand,
  buildBackupFileName,
  parseArgs,
  resolveBackupDatabaseUrl,
} from "./backup-database";
import {
  parsePostgresCredentials,
  sanitizeCommandForLogging,
} from "./lib/postgres-credentials";

const baseArgs = {
  target: "development" as const,
  outputDir: "./backups",
  confirm: true,
  forceProduction: false,
  dryRun: false,
};

describe("backup argument parsing", () => {
  it("parses valid arguments from argv", () => {
    const args = parseArgs(
      ["--target", "preview", "--output-dir", "./backups", "--confirm"],
      {},
    );

    expect(args.target).toBe("preview");
    expect(args.outputDir).toMatch(/backups$/);
    expect(args.confirm).toBe(true);
    expect(args.forceProduction).toBe(false);
    expect(args.dryRun).toBe(false);
  });

  it("falls back to environment variables", () => {
    const args = parseArgs([], {
      BACKUP_TARGET: "staging",
      BACKUP_OUTPUT_DIR: "/tmp/backups",
    });

    expect(args.target).toBe("staging");
    expect(args.outputDir.replace(/\\/g, "/")).toMatch(/tmp\/backups$/);
  });

  it("rejects an invalid target", () => {
    expect(() => parseArgs(["--target", "qa"], {})).toThrow("Invalid --target");
  });

  it("rejects a missing target", () => {
    expect(() => parseArgs(["--output-dir", "./backups"], {})).toThrow(
      "--target is required",
    );
  });
});

describe("backup safety checks", () => {
  it("rejects missing confirmation", () => {
    expect(() =>
      assertSafeBackupTarget({ ...baseArgs, confirm: false }, {}),
    ).toThrow("--confirm was not provided");
  });

  it("allows a non-production target in a non-production environment", () => {
    expect(() => assertSafeBackupTarget(baseArgs, {})).not.toThrow();
  });

  it("rejects a production target without --force-production", () => {
    expect(() =>
      assertSafeBackupTarget({ ...baseArgs, target: "production" }, {}),
    ).toThrow("--force-production");
  });

  it("rejects when the ambient environment looks like production", () => {
    expect(() =>
      assertSafeBackupTarget(baseArgs, { VERCEL_ENV: "production" }),
    ).toThrow("looks like Production");
  });

  it("rejects --force-production on a non-production target", () => {
    expect(() =>
      assertSafeBackupTarget(
        { ...baseArgs, forceProduction: true },
        { VERCEL_ENV: "production" },
      ),
    ).toThrow("only valid with --target production");
  });
});

describe("backup database URL resolution", () => {
  it("prefers the unpooled URL", () => {
    const url = resolveBackupDatabaseUrl({
      DATABASE_URL: "postgresql://u:p@host-pooler.neon.tech/db",
      DATABASE_URL_UNPOOLED: "postgresql://u:p@host.neon.tech/db",
    });
    expect(url).toBe("postgresql://u:p@host.neon.tech/db");
  });

  it("rejects missing URLs", () => {
    expect(() => resolveBackupDatabaseUrl({})).toThrow(
      "DATABASE_URL is required",
    );
  });

  it("rejects a Vercel [SENSITIVE] placeholder", () => {
    expect(() =>
      resolveBackupDatabaseUrl({ DATABASE_URL: "[SENSITIVE]" }),
    ).toThrow();
  });
});

describe("backup command construction", () => {
  it("builds a pg_dump command without credentials in argv", () => {
    const cmd = buildBackupCommand(
      "postgresql://user:secret@host.neon.tech/appdb",
      "/tmp/out.dump",
    );
    expect(cmd[0]).toBe("pg_dump");
    expect(cmd).toContain("--format=custom");
    expect(cmd.join(" ")).not.toContain("secret");
  });

  it("generates collision-resistant dump filenames", () => {
    const a = buildBackupFileName(baseArgs);
    const b = buildBackupFileName(baseArgs);
    expect(a).toMatch(/^backup-development-.*\.dump$/);
    expect(a).not.toBe(b);
  });
});

describe("credential handling", () => {
  it("parses credentials for PG* env passing", () => {
    const creds = parsePostgresCredentials(
      "postgresql://user:secret@host.neon.tech:5433/appdb",
    );
    expect(creds.host).toBe("host.neon.tech");
    expect(creds.port).toBe("5433");
    expect(creds.password).toBe("secret");
  });

  it("redacts passwords in logged commands", () => {
    const sanitized = sanitizeCommandForLogging([
      "pg_dump",
      "postgresql://user:secret@host/db",
    ]);
    expect(sanitized[1]).toContain("REDACTED");
    expect(sanitized[1]).not.toContain("secret");
  });
});
