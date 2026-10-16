import { describe, expect, it } from "vitest";

import {
  assertDestructiveTarget,
  DestructiveTargetError,
} from "./lib/destructive-db-guard";
import { DatabaseTargetError } from "./lib/db-target";

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
});
