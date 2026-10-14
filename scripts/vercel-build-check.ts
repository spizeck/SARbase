/**
 * Verifies the EFFECTIVE Vercel build command still runs
 * `scripts/vercel-build.ts` — the wrapper that performs database
 * identity checks and applies committed Prisma migrations during every
 * Vercel build.
 *
 * Why this exists: the project-level Build Command setting in the
 * Vercel dashboard/API overrides vercel.json. In the PR #49 lifecycle
 * validation the project was found set to `npm run build` — every
 * deployment built and promoted successfully while silently skipping
 * migrations and the production/preview identity guards. Neither a
 * repo-side test nor a comment can see that setting, so this check
 * reads it back through the Vercel API.
 *
 * Read-only: a single GET. The token is masked before first use; only
 * command strings and HTTP status codes are ever printed.
 *
 * Outcomes (distinct exit codes so a genuine mismatch is never confused
 * with an inability to verify):
 *   0 ok            — the effective command is the required one
 *   1 mismatch      — verified, and the effective command bypasses
 *                     vercel-build.ts
 *   2 unverifiable  — the check could not reach a verdict (missing
 *                     config, API error, insufficient permissions);
 *                     fails the workflow rather than reporting success
 *
 * Required env: VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID.
 * Optional env: GITHUB_STEP_SUMMARY.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  assessBuildCommand,
  REQUIRED_VERCEL_BUILD_COMMAND,
  type BuildCommandAssessment,
} from "./lib/vercel-build-config";

const TAG = "[vercel-build-check]";
const VERCEL_API = "https://api.vercel.com";

export type Env = Record<string, string | undefined>;
export type Fetcher = typeof fetch;

export const EXIT_OK = 0;
export const EXIT_MISMATCH = 1;
export const EXIT_UNVERIFIABLE = 2;

export type CheckResult =
  | { kind: "ok"; assessment: BuildCommandAssessment }
  | { kind: "mismatch"; assessment: BuildCommandAssessment }
  | { kind: "unverifiable"; reason: string };

function mask(value: string): void {
  console.log(`::add-mask::${value}`);
}

function writeSummary(env: Env, markdown: string): void {
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
}

/** vercel.json's declared buildCommand; null when absent/unreadable. */
export function readRepoBuildCommand(path = "vercel.json"): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "buildCommand" in parsed &&
      typeof (parsed as { buildCommand?: unknown }).buildCommand === "string"
    ) {
      return (parsed as { buildCommand: string }).buildCommand;
    }
    return null;
  } catch {
    return null;
  }
}

async function getProjectBuildCommand(
  env: Env,
  fetcher: Fetcher,
): Promise<string | null> {
  const res = await fetcher(
    `${VERCEL_API}/v9/projects/${env.VERCEL_PROJECT_ID}?teamId=${env.VERCEL_TEAM_ID}`,
    {
      headers: { authorization: `Bearer ${env.VERCEL_TOKEN}` },
    },
  );
  if (!res.ok) {
    const detail =
      res.status === 401 || res.status === 403
        ? "the token lacks permission to read this project"
        : "Vercel API request failed";
    throw new CheckUnverifiable(
      `GET /v9/projects -> ${res.status}: ${detail} — the build command could not be verified`,
    );
  }
  const data = (await res.json()) as { buildCommand?: unknown };
  return typeof data.buildCommand === "string" ? data.buildCommand : null;
}

class CheckUnverifiable extends Error {}

function summarize(result: CheckResult): string {
  const rows: string[] = [
    "## Vercel build-command check",
    "",
    `Required: \`${REQUIRED_VERCEL_BUILD_COMMAND}\``,
    "",
  ];
  if (result.kind === "unverifiable") {
    rows.push(`**Result: UNVERIFIABLE** — ${result.reason}`);
  } else {
    const a = result.assessment;
    rows.push(`Effective command (\`${a.source}\`): \`${a.effective}\``);
    rows.push(
      result.kind === "ok"
        ? "**Result: OK** — identity checks and migrations run on every Vercel build."
        : `**Result: MISMATCH** — ${a.problems.join("; ")}`,
    );
  }
  return rows.join("\n");
}

export async function runVercelBuildCheck(
  env: Env,
  fetcher: Fetcher = fetch,
  readRepoCommand: () => string | null = readRepoBuildCommand,
): Promise<number> {
  let result: CheckResult;
  const missing = [
    "VERCEL_TOKEN",
    "VERCEL_TEAM_ID",
    "VERCEL_PROJECT_ID",
  ].filter((k) => !env[k]);
  if (missing.length > 0) {
    result = {
      kind: "unverifiable",
      reason: `missing configuration: ${missing.join(", ")}`,
    };
  } else {
    mask(env.VERCEL_TOKEN!);
    try {
      const projectCommand = await getProjectBuildCommand(env, fetcher);
      const assessment = assessBuildCommand(projectCommand, readRepoCommand());
      result = assessment.ok
        ? { kind: "ok", assessment }
        : { kind: "mismatch", assessment };
    } catch (err) {
      if (err instanceof CheckUnverifiable) {
        result = { kind: "unverifiable", reason: err.message };
      } else {
        result = {
          kind: "unverifiable",
          reason: `unexpected error — ${
            err instanceof Error ? err.name : String(err)
          }`,
        };
      }
    }
  }

  if (result.kind === "ok") {
    console.log(
      `${TAG} effective build command (${result.assessment.source}): ` +
        `"${result.assessment.effective}" — verified`,
    );
  } else if (result.kind === "mismatch") {
    for (const p of result.assessment.problems) {
      console.error(`${TAG} ${p}`);
    }
  } else {
    console.error(
      `${TAG} could not verify the build command — ${result.reason}`,
    );
  }
  writeSummary(env, summarize(result));

  return result.kind === "ok"
    ? EXIT_OK
    : result.kind === "mismatch"
      ? EXIT_MISMATCH
      : EXIT_UNVERIFIABLE;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runVercelBuildCheck(process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(
        `${TAG} unexpected failure — ${err instanceof Error ? err.name : String(err)}`,
      );
      process.exitCode = EXIT_UNVERIFIABLE;
    });
}
