import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runTestingInit,
  type Env,
  type Fetcher,
  type Runner,
} from "./neon-testing-init";

/**
 * Mocked Neon API — no real provider calls are ever made. The runner
 * is faked the same way, so the migrate/seed/verify children never
 * spawn and no database is touched.
 */

type Call = { method: string; url: string };

type BranchFixture = { id: string; name: string; primary?: boolean };

type Fixture = {
  project?: { id?: string; name?: string };
  branches?: BranchFixture[];
  /** connection_uri responses keyed by `<branchId>:<pooled>`. */
  uris?: Record<string, string>;
  /** HTTP status override for every Neon call (default 200). */
  status?: number;
};

const PROJECT_ID = "rough-thunder-07294432";

const TESTING_URL =
  "postgresql://neondb_owner:s3cret@ep-testing-abc.us-east-2.aws.neon.tech/neondb?sslmode=require";
const TESTING_URL_POOLED =
  "postgresql://neondb_owner:s3cret@ep-testing-abc-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
const PROD_URL =
  "postgresql://neondb_owner:s3cret@ep-prod-xyz.us-east-2.aws.neon.tech/neondb?sslmode=require";

const TESTING_BRANCH: BranchFixture = {
  id: "br-testing",
  name: "testing",
};
const PROD_BRANCH: BranchFixture = {
  id: "br-main",
  name: "main",
  primary: true,
};

const GOOD: Fixture = {
  project: { id: PROJECT_ID, name: "SARBase-db" },
  branches: [TESTING_BRANCH, PROD_BRANCH],
  uris: {
    "br-testing:false": TESTING_URL,
    "br-testing:true": TESTING_URL_POOLED,
    "br-main:false": PROD_URL,
  },
};

const ENV: Env = {
  NEON_API_KEY: "neon-api-key-xyz",
  NEON_PROJECT_ID: PROJECT_ID,
  NEON_PROJECT_NAME: "SARBase-db",
};

function makeFetch(fixture: Fixture): { fetcher: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
    }) as Response;

  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push({ method: "GET", url: url.toString() });
    if (fixture.status && fixture.status >= 400) {
      return json({}, fixture.status);
    }
    if (url.pathname === `/api/v2/projects/${PROJECT_ID}`) {
      return json({ project: fixture.project ?? {} });
    }
    if (url.pathname === `/api/v2/projects/${PROJECT_ID}/branches`) {
      return json({ branches: fixture.branches ?? [] });
    }
    if (url.pathname === `/api/v2/projects/${PROJECT_ID}/connection_uri`) {
      const key = `${url.searchParams.get("branch_id")}:${url.searchParams.get("pooled")}`;
      const uri = fixture.uris?.[key];
      return uri ? json({ uri }) : json({}, 404);
    }
    return json({}, 500);
  }) as Fetcher;

  return { fetcher, calls };
}

const okRunner: Runner = () => ({ status: 0 });

function failingRunner(step: number): {
  runner: Runner;
  ran: string[][];
} {
  const ran: string[][] = [];
  return {
    ran,
    runner: (_cmd, args) => {
      ran.push(args);
      return { status: ran.length === step ? 1 : 0 };
    },
  };
}

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("resolveTestingTarget guards (via runTestingInit)", () => {
  it("rejects when the API resolves a different project id", async () => {
    const { fetcher } = makeFetch({
      ...GOOD,
      project: { id: "other-project", name: "SARBase-db" },
    });
    await expect(runTestingInit(ENV, fetcher, okRunner)).rejects.toThrow(
      /not the configured/,
    );
    expect(process.exitCode).toBe(1);
  });

  it("rejects when the project name does not match NEON_PROJECT_NAME", async () => {
    const { fetcher } = makeFetch({
      ...GOOD,
      project: { id: PROJECT_ID, name: "someone-elses-db" },
    });
    await expect(runTestingInit(ENV, fetcher, okRunner)).rejects.toThrow(
      /project name/,
    );
  });

  it("rejects when the testing branch does not exist", async () => {
    const { fetcher } = makeFetch({ ...GOOD, branches: [PROD_BRANCH] });
    await expect(runTestingInit(ENV, fetcher, okRunner)).rejects.toThrow(
      /no branch named "testing"/,
    );
  });

  it("rejects when testing is the primary branch", async () => {
    const { fetcher } = makeFetch({
      ...GOOD,
      branches: [
        { id: "br-testing", name: "testing", primary: true },
        { id: "br-x", name: "main" },
      ],
    });
    await expect(runTestingInit(ENV, fetcher, okRunner)).rejects.toThrow(
      /PRIMARY/,
    );
  });

  it("rejects when no primary branch exists to prove production", async () => {
    const { fetcher } = makeFetch({
      ...GOOD,
      branches: [TESTING_BRANCH],
    });
    await expect(runTestingInit(ENV, fetcher, okRunner)).rejects.toThrow(
      /exactly one primary/,
    );
  });

  it("rejects when multiple primary branches exist", async () => {
    const { fetcher } = makeFetch({
      ...GOOD,
      branches: [
        TESTING_BRANCH,
        PROD_BRANCH,
        { id: "br-main2", name: "main2", primary: true },
      ],
    });
    await expect(runTestingInit(ENV, fetcher, okRunner)).rejects.toThrow(
      /exactly one primary/,
    );
  });

  it("rejects when the testing URI resolves to the production host", async () => {
    const { fetcher } = makeFetch({
      ...GOOD,
      uris: {
        "br-testing:false": PROD_URL,
        "br-testing:true": PROD_URL,
        "br-main:false": PROD_URL,
      },
    });
    await expect(runTestingInit(ENV, fetcher, okRunner)).rejects.toThrow(
      /PRODUCTION/,
    );
  });

  it("rejects when pooled and unpooled URIs are different databases", async () => {
    const { fetcher } = makeFetch({
      ...GOOD,
      uris: {
        ...GOOD.uris,
        "br-testing:true": TESTING_URL_POOLED.replace(
          "neon.tech/neondb",
          "neon.tech/otherdb",
        ),
      },
    });
    await expect(runTestingInit(ENV, fetcher, okRunner)).rejects.toThrow(
      /same database/,
    );
  });

  it("rejects a malformed connection URI", async () => {
    const { fetcher } = makeFetch({
      ...GOOD,
      uris: { ...GOOD.uris, "br-testing:false": "not a url" },
    });
    await expect(runTestingInit(ENV, fetcher, okRunner)).rejects.toThrow();
  });

  it("rejects a connection URI with a routing-override query parameter", async () => {
    const { fetcher } = makeFetch({
      ...GOOD,
      uris: {
        ...GOOD.uris,
        "br-testing:false": `${TESTING_URL}&host=/tmp/socket`,
      },
    });
    await expect(runTestingInit(ENV, fetcher, okRunner)).rejects.toThrow(
      /overrides/,
    );
  });

  it("rejects a loopback host", async () => {
    const { fetcher } = makeFetch({
      ...GOOD,
      uris: {
        ...GOOD.uris,
        "br-testing:false": "postgresql://u:p@localhost:5432/neondb",
        "br-testing:true": "postgresql://u:p@localhost:5432/neondb",
      },
    });
    await expect(runTestingInit(ENV, fetcher, okRunner)).rejects.toThrow(
      /loopback/,
    );
  });

  it("rejects when NEON_API_KEY or NEON_PROJECT_ID is missing", async () => {
    const { fetcher } = makeFetch(GOOD);
    await expect(
      runTestingInit({ ...ENV, NEON_API_KEY: undefined }, fetcher, okRunner),
    ).rejects.toThrow(/missing required environment/);
    await expect(
      runTestingInit({ ...ENV, NEON_PROJECT_ID: undefined }, fetcher, okRunner),
    ).rejects.toThrow(/missing required environment/);
  });

  it("rejects on a Neon API failure", async () => {
    const { fetcher } = makeFetch({ ...GOOD, status: 500 });
    await expect(runTestingInit(ENV, fetcher, okRunner)).rejects.toThrow(
      /Neon API GET/,
    );
  });
});

describe("runTestingInit orchestration", () => {
  it("runs migrate, seed, verify in order with verified env", async () => {
    const { fetcher } = makeFetch(GOOD);
    const ran: { args: string[]; env: Env }[] = [];
    const runner: Runner = (_cmd, args, env) => {
      ran.push({ args, env });
      return { status: 0 };
    };
    await expect(runTestingInit(ENV, fetcher, runner)).resolves.toBe(0);

    expect(ran.map((r) => r.args.join(" "))).toEqual([
      "run db:migrate:deploy",
      "run db:seed -- --target testing --confirm",
      "run db:verify",
    ]);
    const childEnv = ran[0]!.env;
    expect(childEnv.DATABASE_URL).toBe(TESTING_URL_POOLED);
    expect(childEnv.DATABASE_URL_UNPOOLED).toBe(TESTING_URL);
    expect(childEnv.APP_TESTING_DB_HOST).toBe(
      "ep-testing-abc.us-east-2.aws.neon.tech",
    );
    expect(childEnv.APP_PRODUCTION_DB_HOST).toBe(
      "ep-prod-xyz.us-east-2.aws.neon.tech",
    );
  });

  it("aborts on a failed migration and never seeds", async () => {
    const { fetcher } = makeFetch(GOOD);
    const { runner, ran } = failingRunner(1);
    await expect(runTestingInit(ENV, fetcher, runner)).rejects.toThrow(
      /migrate deploy failed/,
    );
    expect(ran).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });

  it("aborts on a failed seed and never verifies", async () => {
    const { fetcher } = makeFetch(GOOD);
    const { runner, ran } = failingRunner(2);
    await expect(runTestingInit(ENV, fetcher, runner)).rejects.toThrow(
      /seed.*failed/,
    );
    expect(ran).toHaveLength(2);
  });

  it("fails on a failed verification", async () => {
    const { fetcher } = makeFetch(GOOD);
    const { runner, ran } = failingRunner(3);
    await expect(runTestingInit(ENV, fetcher, runner)).rejects.toThrow(
      /verify.*failed/,
    );
    expect(ran).toHaveLength(3);
  });

  it("is idempotent — a second run repeats the same steps", async () => {
    const { fetcher, calls } = makeFetch(GOOD);
    await runTestingInit(ENV, fetcher, okRunner);
    const firstRunCalls = calls.length;
    await runTestingInit(ENV, fetcher, okRunner);
    expect(calls.length).toBe(firstRunCalls * 2);
    expect(process.exitCode).toBeUndefined();
  });
});

describe("secret hygiene", () => {
  it("masks credentials and never puts them in the summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "neon-init-test-"));
    const summaryPath = join(dir, "summary.md");
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const { fetcher } = makeFetch(GOOD);
      await runTestingInit(
        { ...ENV, GITHUB_STEP_SUMMARY: summaryPath },
        fetcher,
        okRunner,
      );

      const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(printed).toContain(`::add-mask::${TESTING_URL}`);
      expect(printed).toContain(`::add-mask::${TESTING_URL_POOLED}`);
      expect(printed).toContain(`::add-mask::${ENV.NEON_API_KEY}`);

      const summary = readFileSync(summaryPath, "utf-8");
      expect(summary).not.toContain("postgresql://");
      expect(summary).not.toContain("s3cret");
      expect(summary).not.toContain(ENV.NEON_API_KEY!);
      // …but still reports a useful, sanitized identity.
      expect(summary).toContain("ep-testing-abc.us-east-2.aws.neon.tech");
      expect(summary).toContain("`testing`");
      expect(summary).toContain("passed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
