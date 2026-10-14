import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AUTODETECTED_BUILD_COMMAND,
  assessBuildCommand,
  normalizeBuildCommand,
  REQUIRED_VERCEL_BUILD_COMMAND,
} from "./lib/vercel-build-config";
import {
  EXIT_MISMATCH,
  EXIT_OK,
  EXIT_UNVERIFIABLE,
  readRepoBuildCommand,
  runVercelBuildCheck,
  type Env,
  type Fetcher,
} from "./vercel-build-check";

/**
 * The Vercel build command is the single switch that decides whether
 * database identity checks and `prisma migrate deploy` run inside a
 * deployment. These tests pin the contract from both ends: the
 * repository files declare it, and the remote check detects drift in
 * the project-level setting that overrides vercel.json.
 */

const ENV: Env = {
  VERCEL_TOKEN: "vercel-token-xyz",
  VERCEL_TEAM_ID: "team_abc",
  VERCEL_PROJECT_ID: "prj_abc",
};

function makeFetch(payload: unknown, status = 200): Fetcher {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    }) as Response) as Fetcher;
}

// --- repository configuration ------------------------------------------------

describe("repository build configuration", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const vercelJson = JSON.parse(readFileSync("vercel.json", "utf8")) as {
    buildCommand?: string;
  };

  it("vercel.json declares the required build command", () => {
    // The regression this guards: buildCommand removed or reverted to
    // `npm run build` — vercel.json is the version-controlled fallback
    // whenever the project-level override is unset.
    expect(vercelJson.buildCommand).toBe(REQUIRED_VERCEL_BUILD_COMMAND);
  });

  it("the required command invokes the identity-check + migration wrapper", () => {
    expect(pkg.scripts?.["build:vercel"]).toMatch(/scripts\/vercel-build\.ts/);
  });

  it("plain `npm run build` remains a bare `next build` (local/dev path)", () => {
    // If someone repoints `build` at the wrapper (or vice versa), the
    // distinction between a safe Vercel build and a local build is lost.
    expect(pkg.scripts?.build).toBe("next build");
  });
});

// --- assessment semantics ------------------------------------------------------

describe("normalizeBuildCommand", () => {
  it("trims and collapses whitespace; empty becomes null", () => {
    expect(normalizeBuildCommand("  npm  run  build:vercel \n")).toBe(
      REQUIRED_VERCEL_BUILD_COMMAND,
    );
    expect(normalizeBuildCommand("   ")).toBeNull();
    expect(normalizeBuildCommand(null)).toBeNull();
    expect(normalizeBuildCommand(undefined)).toBeNull();
  });
});

describe("assessBuildCommand", () => {
  it("accepts the required command at the project level", () => {
    const a = assessBuildCommand(REQUIRED_VERCEL_BUILD_COMMAND, null);
    expect(a.ok).toBe(true);
    expect(a.source).toBe("project");
    expect(a.effective).toBe(REQUIRED_VERCEL_BUILD_COMMAND);
  });

  it("accepts the required command at the vercel.json level", () => {
    const a = assessBuildCommand(null, REQUIRED_VERCEL_BUILD_COMMAND);
    expect(a.ok).toBe(true);
    expect(a.source).toBe("vercel.json");
  });

  it("detects the PR #49 regression: project set to `npm run build`", () => {
    const a = assessBuildCommand(
      "npm run build",
      REQUIRED_VERCEL_BUILD_COMMAND,
    );
    expect(a.ok).toBe(false);
    expect(a.source).toBe("project");
    expect(a.effective).toBe("npm run build");
    expect(a.problems[0]).toContain(REQUIRED_VERCEL_BUILD_COMMAND);
  });

  it("detects a vercel.json regression to `npm run build`", () => {
    const a = assessBuildCommand(null, "npm run build");
    expect(a.ok).toBe(false);
    expect(a.source).toBe("vercel.json");
  });

  it("flags auto-detection when neither layer declares a command", () => {
    const a = assessBuildCommand(null, null);
    expect(a.ok).toBe(false);
    expect(a.source).toBe("auto-detect");
    expect(a.effective).toBe(AUTODETECTED_BUILD_COMMAND);
  });

  it("normalizes whitespace before comparing", () => {
    expect(assessBuildCommand("  npm  run   build:vercel ", null).ok).toBe(
      true,
    );
  });

  it("flags a misleading repo declaration even when the project override is correct", () => {
    const a = assessBuildCommand(
      REQUIRED_VERCEL_BUILD_COMMAND,
      "npm run build",
    );
    expect(a.ok).toBe(false);
    expect(a.effective).toBe(REQUIRED_VERCEL_BUILD_COMMAND);
    expect(a.problems[0]).toContain("overrides");
  });
});

// --- remote check outcomes -----------------------------------------------------

describe("runVercelBuildCheck", () => {
  const summaryDir = mkdtempSync(join(tmpdir(), "vercel-build-check-"));
  const summaryPath = join(summaryDir, "summary.md");
  const envWithSummary: Env = { ...ENV, GITHUB_STEP_SUMMARY: summaryPath };

  afterEach(() => {
    rmSync(summaryPath, { force: true });
  });

  it("returns OK when the project runs the required command", async () => {
    const code = await runVercelBuildCheck(
      ENV,
      makeFetch({ buildCommand: REQUIRED_VERCEL_BUILD_COMMAND }),
      () => REQUIRED_VERCEL_BUILD_COMMAND,
    );
    expect(code).toBe(EXIT_OK);
  });

  it("returns OK when only vercel.json declares the command (project unset)", async () => {
    const code = await runVercelBuildCheck(
      ENV,
      makeFetch({ buildCommand: null }),
      () => REQUIRED_VERCEL_BUILD_COMMAND,
    );
    expect(code).toBe(EXIT_OK);
  });

  it("returns MISMATCH for the `npm run build` regression", async () => {
    const code = await runVercelBuildCheck(
      envWithSummary,
      makeFetch({ buildCommand: "npm run build" }),
      () => REQUIRED_VERCEL_BUILD_COMMAND,
    );
    expect(code).toBe(EXIT_MISMATCH);
    const summary = readFileSync(summaryPath, "utf8");
    expect(summary).toContain("MISMATCH");
    expect(summary).toContain(REQUIRED_VERCEL_BUILD_COMMAND);
  });

  it("returns MISMATCH when nothing declares the command (auto-detect)", async () => {
    const code = await runVercelBuildCheck(ENV, makeFetch({}), () => null);
    expect(code).toBe(EXIT_MISMATCH);
  });

  it("returns UNVERIFIABLE on a permission failure — not a mismatch", async () => {
    const code = await runVercelBuildCheck(ENV, makeFetch({}, 403), () => null);
    expect(code).toBe(EXIT_UNVERIFIABLE);
  });

  it("returns UNVERIFIABLE on an API error", async () => {
    const code = await runVercelBuildCheck(ENV, makeFetch({}, 500), () => null);
    expect(code).toBe(EXIT_UNVERIFIABLE);
  });

  it("returns UNVERIFIABLE on a network error", async () => {
    const fetcher: Fetcher = (async () => {
      throw new TypeError("fetch failed");
    }) as Fetcher;
    const code = await runVercelBuildCheck(ENV, fetcher, () => null);
    expect(code).toBe(EXIT_UNVERIFIABLE);
  });

  it("returns UNVERIFIABLE when required env is missing — without calling the API", async () => {
    let called = false;
    const fetcher: Fetcher = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as Fetcher;
    const code = await runVercelBuildCheck(
      { VERCEL_PROJECT_ID: "prj_abc" },
      fetcher,
      () => null,
    );
    expect(code).toBe(EXIT_UNVERIFIABLE);
    expect(called).toBe(false);
  });

  it("masks the token and never prints it into the summary", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (msg?: unknown) => logs.push(String(msg));
    console.error = (msg?: unknown) => logs.push(String(msg));
    try {
      await runVercelBuildCheck(
        envWithSummary,
        makeFetch({ buildCommand: "npm run build" }),
        () => null,
      );
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    expect(logs.join("\n")).toContain(`::add-mask::${ENV.VERCEL_TOKEN}`);
    expect(readFileSync(summaryPath, "utf8")).not.toContain(ENV.VERCEL_TOKEN);
  });
});

// --- vercel.json reader ----------------------------------------------------------

describe("readRepoBuildCommand", () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function withJson(contents: string): string {
    dir = mkdtempSync(join(tmpdir(), "vercel-json-"));
    const path = join(dir, "vercel.json");
    writeFileSync(path, contents);
    return path;
  }

  it("reads a declared buildCommand", () => {
    const path = withJson(
      JSON.stringify({ buildCommand: "npm run build:vercel" }),
    );
    expect(readRepoBuildCommand(path)).toBe("npm run build:vercel");
  });

  it("returns null when buildCommand is absent or not a string", () => {
    expect(readRepoBuildCommand(withJson("{}"))).toBeNull();
    expect(
      readRepoBuildCommand(withJson(JSON.stringify({ buildCommand: 42 }))),
    ).toBeNull();
  });

  it("returns null on a missing or invalid file", () => {
    expect(readRepoBuildCommand("does-not-exist.json")).toBeNull();
    expect(readRepoBuildCommand(withJson("{ not json"))).toBeNull();
  });
});
