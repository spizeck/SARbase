import { describe, expect, it, vi } from "vitest";

import { assertSeedTargetAllowed, parseSeedArgs } from "./seed";

const LOCAL = "postgresql://u:p@localhost:5432/sarbase";
const TESTING_HOST = "ep-testing.us-east-2.aws.neon.tech";
const TESTING_DB = `postgresql://u:p@${TESTING_HOST}/db`;
const PROD_HOST = "ep-prod.us-east-2.aws.neon.tech";
const PROD_DB = `postgresql://u:p@${PROD_HOST}/db`;

const MARKERS = {
  APP_PRODUCTION_DB_HOST: PROD_HOST,
  APP_TESTING_DB_HOST: TESTING_HOST,
};

describe("parseSeedArgs", () => {
  it("parses --target and --confirm", () => {
    expect(parseSeedArgs(["--target", "testing", "--confirm"])).toEqual({
      target: "testing",
      confirm: true,
    });
  });

  it("defaults to local/argless", () => {
    expect(parseSeedArgs([])).toEqual({ target: undefined, confirm: false });
  });

  it("rejects unknown arguments and a missing target operand", () => {
    expect(() => parseSeedArgs(["--force"])).toThrow(/Unknown argument/);
    expect(() => parseSeedArgs(["--target"])).toThrow(/--target requires/);
    expect(() => parseSeedArgs(["--target", "--confirm"])).toThrow(
      /--target requires/,
    );
  });
});

describe("assertSeedTargetAllowed", () => {
  it("allows loopback targets without flags", () => {
    expect(() =>
      assertSeedTargetAllowed({ confirm: false }, LOCAL, MARKERS),
    ).not.toThrow();
  });

  it("always refuses the production host — flags or not", () => {
    expect(() =>
      assertSeedTargetAllowed(
        { target: "testing", confirm: true },
        PROD_DB,
        MARKERS,
      ),
    ).toThrow(/production host/);
    expect(() =>
      assertSeedTargetAllowed(
        { target: "preview", confirm: true },
        PROD_DB,
        MARKERS,
      ),
    ).toThrow(/production host/);
  });

  it("refuses remote hosts without --target --confirm", () => {
    expect(() =>
      assertSeedTargetAllowed({ confirm: false }, TESTING_DB, MARKERS),
    ).toThrow(/--target <name> --confirm/);
    expect(() =>
      assertSeedTargetAllowed(
        { target: "testing", confirm: false },
        TESTING_DB,
        MARKERS,
      ),
    ).toThrow(/--target <name> --confirm/);
  });

  it("binds --target testing to the documented testing host", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() =>
      assertSeedTargetAllowed(
        { target: "testing", confirm: true },
        TESTING_DB,
        MARKERS,
      ),
    ).not.toThrow();
    log.mockRestore();
  });

  it("refuses --target testing against a different remote host", () => {
    expect(() =>
      assertSeedTargetAllowed(
        { target: "testing", confirm: true },
        "postgresql://u:p@ep-random.us-east-2.aws.neon.tech/db",
        MARKERS,
      ),
    ).toThrow(/not the configured testing host/);
  });

  it("refuses --target testing when APP_TESTING_DB_HOST is unset", () => {
    expect(() =>
      assertSeedTargetAllowed(
        { target: "testing", confirm: true },
        TESTING_DB,
        { APP_PRODUCTION_DB_HOST: PROD_HOST },
      ),
    ).toThrow(/APP_TESTING_DB_HOST/);
  });

  it("allows other confirmed remote targets (e.g. a preview branch)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() =>
      assertSeedTargetAllowed(
        { target: "preview-42", confirm: true },
        "postgresql://u:p@ep-prev.us-east-2.aws.neon.tech/db",
        MARKERS,
      ),
    ).not.toThrow();
    log.mockRestore();
  });

  it("still refuses the production host when APP_PRODUCTION_DB_HOST is pooled-spelled", () => {
    expect(() =>
      assertSeedTargetAllowed(
        { target: "x", confirm: true },
        `postgresql://u:p@ep-prod-pooler.us-east-2.aws.neon.tech/db`,
        MARKERS,
      ),
    ).toThrow(/production host/);
  });

  it("rejects connection strings that retarget via query parameters", () => {
    expect(() =>
      assertSeedTargetAllowed(
        { target: "testing", confirm: true },
        `${TESTING_DB}?host=${PROD_HOST}`,
        MARKERS,
      ),
    ).toThrow(/overrides "host"/i);
  });
});
