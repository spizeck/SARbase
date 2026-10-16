import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  assertDestructiveTarget,
  DestructiveTargetError,
} from "./lib/destructive-db-guard";
import { DatabaseTargetError } from "./lib/db-target";
import { datasourceEnvUrls } from "./migrate";

const remote =
  "postgresql://u:p@ep-example-12345.us-east-2.aws.neon.tech/mydb?sslmode=require";
const prodHost = "ep-prod-99999.us-east-2.aws.neon.tech";
const prodUrl = `postgresql://u:p@${prodHost}/prod?sslmode=require`;
const testingHost = "ep-testing-88888.us-east-2.aws.neon.tech";
const testingUrl = `postgresql://u:p@${testingHost}/testing?sslmode=require`;

describe("assertDestructiveTarget", () => {
  it("allows loopback targets unconditionally", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]) {
      expect(() =>
        assertDestructiveTarget(`postgresql://postgres:pg@${host}:5433/db`),
      ).not.toThrow();
    }
  });

  it("refuses remote targets without confirmation", () => {
    expect(() => assertDestructiveTarget(remote)).toThrow(
      DestructiveTargetError,
    );
    expect(() => assertDestructiveTarget(remote)).toThrow(
      /ep-example-12345\.us-east-2\.aws\.neon\.tech/,
    );
  });

  it("refuses the production host even with a matching confirmation", () => {
    expect(() =>
      assertDestructiveTarget(prodUrl, {
        productionHost: prodHost,
        confirmHost: prodHost,
      }),
    ).toThrow(/PRODUCTION database/);
  });

  it("refuses the testing baseline even with a matching confirmation", () => {
    expect(() =>
      assertDestructiveTarget(testingUrl, {
        testingHost,
        confirmHost: testingHost,
      }),
    ).toThrow(/testing baseline/);
  });

  it("refuses a remote target whose hostname matches production case-insensitively", () => {
    expect(() =>
      assertDestructiveTarget(
        `postgresql://u:p@${prodHost.toUpperCase()}/prod`,
        { productionHost: prodHost },
      ),
    ).toThrow(DestructiveTargetError);
  });

  it("refuses a mismatched confirmation hostname", () => {
    expect(() =>
      assertDestructiveTarget(remote, {
        confirmHost: "ep-other-00000.us-east-2.aws.neon.tech",
      }),
    ).toThrow(/must equal the resolved hostname/);
  });

  it("allows a remote target with an exact positive confirmation", () => {
    expect(() =>
      assertDestructiveTarget(remote, {
        confirmHost: "ep-example-12345.us-east-2.aws.neon.tech",
      }),
    ).not.toThrow();
  });

  it("refuses connection strings carrying target-override query params", () => {
    expect(() =>
      assertDestructiveTarget(
        "postgresql://u:p@localhost:5433/db?host=evil.example.com",
      ),
    ).toThrow(DatabaseTargetError);
  });

  it("refuses a pooled Neon target when the production marker is unpooled", () => {
    // Neon pooled endpoints carry -pooler on the FIRST label only.
    const pooled = `postgresql://u:p@${prodHost.replace(
      "ep-prod-99999",
      "ep-prod-99999-pooler",
    )}/prod?sslmode=require`;
    expect(() =>
      assertDestructiveTarget(pooled, {
        productionHost: prodHost,
        confirmHost: "ep-prod-99999-pooler.us-east-2.aws.neon.tech",
      }),
    ).toThrow(/PRODUCTION database/);
  });

  it("refuses an unpooled target when the production marker is pooled", () => {
    expect(() =>
      assertDestructiveTarget(prodUrl, {
        productionHost: prodHost.replace(
          "ep-prod-99999",
          "ep-prod-99999-pooler",
        ),
      }),
    ).toThrow(/PRODUCTION database/);
  });

  it("refuses a target whose hostname carries a trailing DNS dot", () => {
    expect(() =>
      assertDestructiveTarget(`postgresql://u:p@${prodHost}./prod`, {
        productionHost: prodHost,
      }),
    ).toThrow(/PRODUCTION database/);
  });

  it("matches production markers written as URLs or host:port pairs", () => {
    expect(() =>
      assertDestructiveTarget(prodUrl, {
        productionHost: `postgresql://u:p@${prodHost}/prod`,
      }),
    ).toThrow(/PRODUCTION database/);
    expect(() =>
      assertDestructiveTarget(prodUrl, {
        productionHost: `${prodHost}:5432`,
      }),
    ).toThrow(/PRODUCTION database/);
  });
});

describe("datasourceEnvUrls", () => {
  const dir = mkdtempSync(join(tmpdir(), "sarbase-guard-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns null for an unreadable schema", () => {
    expect(datasourceEnvUrls(join(dir, "missing.prisma"))).toBeNull();
  });

  it("extracts every datasource env reference and resolves it", () => {
    const schema = join(dir, "schema.prisma");
    writeFileSync(
      schema,
      `datasource db {
        provider = "postgresql"
        url = env("DATABASE_URL")
        directUrl = env("DATABASE_URL_UNPOOLED")
      }
      generator client { provider = "prisma-client-js" }
      // env("NOT_A_DATASOURCE") outside a datasource block is ignored.
      `,
    );
    expect(
      datasourceEnvUrls(schema, {
        DATABASE_URL: "postgresql://u:p@localhost/db",
        DATABASE_URL_UNPOOLED: "postgresql://u:p@localhost:5433/db",
        NOT_A_DATASOURCE: "postgresql://u:p@evil.example.com/db",
      }),
    ).toEqual([
      { variable: "DATABASE_URL", url: "postgresql://u:p@localhost/db" },
      {
        variable: "DATABASE_URL_UNPOOLED",
        url: "postgresql://u:p@localhost:5433/db",
      },
    ]);
  });

  it("skips env vars that are unset", () => {
    const schema = join(dir, "schema-unset.prisma");
    writeFileSync(
      schema,
      `datasource db {
        provider = "postgresql"
        url = env("MISSING_URL")
      }`,
    );
    expect(datasourceEnvUrls(schema, {})).toEqual([]);
  });
});
