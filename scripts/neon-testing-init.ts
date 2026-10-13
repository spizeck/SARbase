/**
 * Manual initialization of the permanent `testing` Neon branch.
 *
 * Runs from `.github/workflows/neon-testing-init.yml` (workflow_dispatch
 * only). The script is the security boundary: it resolves the testing
 * branch and its connection URIs through the Neon API, proves the
 * target is the fictional-data baseline — not production — and only
 * then runs the committed lifecycle tooling:
 *
 *   1. `npm run db:migrate:deploy`  (unpooled endpoint via directUrl)
 *   2. `npm run db:seed -- --target testing --confirm`  (idempotent upserts)
 *   3. `npm run db:verify`          (read-only fictional-baseline audit)
 *
 * Safeguards, all fail-closed before any database mutation:
 *   - the Neon project is verified (id + optional name);
 *   - the target branch must be named exactly `testing` and must not
 *     be the project's primary branch;
 *   - the production host is resolved from the PRIMARY branch's own
 *     connection URI — not from configuration the run could be fed —
 *     and both testing URIs must resolve elsewhere;
 *   - pooled and unpooled testing URIs must parse under the strict
 *     target parser (no `?host=`/`?hostaddr=`/`?service=` routing
 *     overrides), resolve to the same database, and never be loopback;
 *   - every step inherits APP_TESTING_DB_HOST / APP_PRODUCTION_DB_HOST
 *     derived from these verified hosts, so the seed's own target
 *     binding and the verifier's production exclusion re-verify the
 *     same identities independently.
 *
 * Connection strings and the API key are masked before use and never
 * printed; logs and the job summary show host:port/database only.
 */

import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  arePostgresqlUrlsSameDatabase,
  normalizeDatabaseEndpoint,
} from "../src/lib/env";
import {
  describeDatabaseTarget,
  LOOPBACK_HOSTS,
  parseDatabaseTargetUrl,
} from "./lib/db-target";

const TAG = "[neon-testing-init]";
const NEON_API = "https://console.neon.tech/api/v2";

export type Env = Record<string, string | undefined>;
export type Fetcher = typeof fetch;
export type RunResult = { status: number | null };
export type Runner = (command: string, args: string[], env: Env) => RunResult;

type NeonBranch = {
  id: string;
  name: string;
  primary?: boolean;
};

const TESTING_BRANCH_NAME = "testing";

function fail(message: string): never {
  console.error(`${TAG} ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function requireEnv(env: Env, keys: string[]): void {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    fail(`missing required environment: ${missing.join(", ")}`);
  }
}

function mask(value: string): void {
  console.log(`::add-mask::${value}`);
}

function writeSummary(env: Env, markdown: string): void {
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
}

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

const defaultRunner: Runner = (command, args, env) =>
  // shell is required for npm.cmd resolution on Windows dev machines;
  // on GitHub's Linux runners it changes nothing (fixed literal args).
  spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });

async function neonJson<T>(
  env: Env,
  fetcher: Fetcher,
  path: string,
): Promise<T> {
  const res = await fetcher(`${NEON_API}${path}`, {
    headers: {
      authorization: `Bearer ${env.NEON_API_KEY}`,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    fail(`Neon API GET ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

/** GET /projects/{id} returns `{ project }`; tolerate a bare object. */
async function getProject(
  env: Env,
  fetcher: Fetcher,
): Promise<{ id?: string; name?: string }> {
  const data = await neonJson<
    { project: { id?: string; name?: string } } | { id?: string; name?: string }
  >(env, fetcher, `/projects/${env.NEON_PROJECT_ID}`);
  return "project" in data ? data.project : data;
}

async function connectionUri(
  env: Env,
  fetcher: Fetcher,
  branchId: string,
  pooled: boolean,
): Promise<string> {
  const params = new URLSearchParams({
    branch_id: branchId,
    database_name: env.NEON_DATABASE ?? "neondb",
    role_name: env.NEON_ROLE ?? "neondb_owner",
    pooled: pooled ? "true" : "false",
  });
  const data = await neonJson<{ uri?: string }>(
    env,
    fetcher,
    `/projects/${env.NEON_PROJECT_ID}/connection_uri?${params}`,
  );
  if (!data.uri) {
    fail(`Neon API returned no connection URI for branch ${branchId}`);
  }
  return data.uri;
}

export interface ResolvedTarget {
  testingBranch: NeonBranch;
  productionBranch: NeonBranch;
  pooledUrl: string;
  unpooledUrl: string;
  testingHost: string;
  productionHost: string;
}

/**
 * Resolve + verify the testing target. Everything here is a guard —
 * no database mutation happens in this function, and every returned
 * value is proven against Neon API state rather than configuration
 * that could be pointed elsewhere.
 */
export async function resolveTestingTarget(
  env: Env,
  fetcher: Fetcher,
): Promise<ResolvedTarget> {
  requireEnv(env, ["NEON_API_KEY", "NEON_PROJECT_ID"]);
  mask(env.NEON_API_KEY!);

  // Project identity: the API key must be talking to the expected
  // project — an id or name mismatch means a misconfigured secret and
  // we refuse before touching anything.
  const project = await getProject(env, fetcher);
  if (project.id && project.id !== env.NEON_PROJECT_ID) {
    fail(
      `Neon API resolved project ${project.id}, not the configured ${env.NEON_PROJECT_ID} — refusing to initialize`,
    );
  }
  if (env.NEON_PROJECT_NAME && project.name !== env.NEON_PROJECT_NAME) {
    fail(
      `Neon project name is ${JSON.stringify(project.name ?? "?")}, expected ${JSON.stringify(env.NEON_PROJECT_NAME)} — refusing to initialize`,
    );
  }

  const { branches } = await neonJson<{ branches: NeonBranch[] }>(
    env,
    fetcher,
    `/projects/${env.NEON_PROJECT_ID}/branches`,
  );
  const testing = branches.find((b) => b.name === TESTING_BRANCH_NAME);
  if (!testing) {
    fail(
      `no branch named ${JSON.stringify(TESTING_BRANCH_NAME)} exists in the project — create it first (see docs/preview-databases.md)`,
    );
  }
  if (testing.primary) {
    fail(
      `the ${JSON.stringify(TESTING_BRANCH_NAME)} branch is the project PRIMARY branch — a primary branch holds production data; refusing to initialize it as the fictional baseline`,
    );
  }

  // Production identity is resolved from the primary branch itself, so
  // the exclusion below cannot be configured away.
  const primary = branches.filter((b) => b.primary === true);
  if (primary.length !== 1) {
    fail(
      `expected exactly one primary branch, found ${primary.length} — production identity cannot be proven; refusing to initialize`,
    );
  }
  const production = primary[0]!;
  if (production.name === TESTING_BRANCH_NAME) {
    fail(
      "the primary branch is named testing — refusing to initialize; this project layout cannot distinguish baseline from production",
    );
  }

  const unpooledUrl = await connectionUri(env, fetcher, testing.id, false);
  const pooledUrl = await connectionUri(env, fetcher, testing.id, true);
  const productionUrl = await connectionUri(env, fetcher, production.id, false);
  // Mask before anything else can echo these values.
  mask(unpooledUrl);
  mask(pooledUrl);

  // Strict parse: refuses malformed strings AND routing-override query
  // parameters (host/hostaddr/port/database/dbname/service) that could
  // redirect the driver past the hostnames verified below.
  const unpooled = parseDatabaseTargetUrl(unpooledUrl);
  const pooled = parseDatabaseTargetUrl(pooledUrl);
  const productionParsed = parseDatabaseTargetUrl(productionUrl);

  const testingHost = normalizeDatabaseEndpoint(unpooled.hostname);
  const productionHost = normalizeDatabaseEndpoint(productionParsed.hostname);

  for (const [label, host] of [
    ["pooled", pooled.hostname],
    ["unpooled", unpooled.hostname],
  ] as const) {
    if (LOOPBACK_HOSTS.has(normalizeDatabaseEndpoint(host))) {
      fail(
        `the testing ${label} connection resolves to a loopback host — refusing to initialize`,
      );
    }
  }

  if (!arePostgresqlUrlsSameDatabase(unpooledUrl, pooledUrl)) {
    fail(
      "the pooled and unpooled testing connection URIs do not resolve to the same database — refusing to initialize",
    );
  }
  if (
    testingHost === productionHost ||
    arePostgresqlUrlsSameDatabase(unpooledUrl, productionUrl)
  ) {
    fail(
      "the testing branch connection resolves to the PRODUCTION database — refusing to initialize",
    );
  }

  console.log(
    `${TAG} verified target: branch ${JSON.stringify(TESTING_BRANCH_NAME)} ` +
      `(id ${testing.id}), database ${describeDatabaseTarget(unpooledUrl)}, ` +
      `production host excluded (${productionHost})`,
  );
  return {
    testingBranch: testing,
    productionBranch: production,
    pooledUrl,
    unpooledUrl,
    testingHost,
    productionHost,
  };
}

/**
 * Run the full initialization. Returns a process exit code; every
 * guard violation throws via fail() instead, so a refused target can
 * never produce a half-run that looks successful.
 */
export async function runTestingInit(
  env: Env,
  fetcher: Fetcher = fetch,
  runner: Runner = defaultRunner,
): Promise<number> {
  const target = await resolveTestingTarget(env, fetcher);

  writeSummary(
    env,
    [
      "## Neon testing-branch initialization",
      "",
      `- Project: \`${env.NEON_PROJECT_ID}\` verified against the Neon API`,
      `- Branch: \`${TESTING_BRANCH_NAME}\` (id \`${target.testingBranch.id}\`, non-primary)`,
      `- Database: \`${describeDatabaseTarget(target.unpooledUrl)}\``,
      `- Production host excluded: \`${target.productionHost}\``,
      "",
      "| Step | Result |",
      "| ---- | ------ |",
    ].join("\n"),
  );

  const childEnv: Env = {
    DATABASE_URL: target.pooledUrl,
    DATABASE_URL_UNPOOLED: target.unpooledUrl,
    // The seed binds --target testing to APP_TESTING_DB_HOST and both
    // the seed and db:verify refuse when the URL resolves to
    // APP_PRODUCTION_DB_HOST — same hosts proven above, re-verified by
    // the tooling itself.
    APP_TESTING_DB_HOST: target.testingHost,
    APP_PRODUCTION_DB_HOST: target.productionHost,
  };

  const steps: [label: string, args: string[]][] = [
    ["prisma migrate deploy", ["run", "db:migrate:deploy"]],
    [
      "db:seed (fictional baseline)",
      ["run", "db:seed", "--", "--target", "testing", "--confirm"],
    ],
    ["db:verify (read-only audit)", ["run", "db:verify"]],
  ];

  for (const [label, args] of steps) {
    const result = runner(npmCmd, args, childEnv);
    if (result.status !== 0) {
      writeSummary(env, `| ${label} | failed (exit ${result.status ?? "?"}) |`);
      fail(
        `${label} failed (exit ${result.status ?? "unknown"}) — ` +
          `the run is safe to re-run once the cause is fixed; see docs/preview-databases.md`,
      );
    }
    writeSummary(env, `| ${label} | passed |`);
  }

  console.log(`${TAG} testing baseline initialized and verified`);
  return 0;
}

async function main(): Promise<void> {
  const code = await runTestingInit(process.env);
  if (code !== 0) {
    process.exitCode = code;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
