/**
 * Canonical Vercel build-command contract for SARbase.
 *
 * The Vercel build MUST run `npm run build:vercel`
 * (→ `scripts/vercel-build.ts`): that wrapper performs the
 * database-identity checks and applies committed Prisma migrations
 * before `next build`. A plain `npm run build` deploys successfully
 * without touching the database — the silent failure mode discovered
 * during the PR #49 lifecycle validation.
 *
 * Vercel resolves the effective build command in this order:
 *   1. the project's Build Command setting (dashboard / API), which
 *      overrides everything below;
 *   2. `buildCommand` in vercel.json;
 *   3. framework auto-detection — for Next.js, `npm run build`.
 *
 * Both layer 1 and layer 2 are legitimate places to declare the
 * command; whichever wins must resolve to the required value. This
 * module is the single source of truth for that requirement — the
 * repository-side unit test and the scheduled remote check
 * (scripts/vercel-build-check.ts) both consume it.
 */

export const REQUIRED_VERCEL_BUILD_COMMAND = "npm run build:vercel";

/** What Vercel auto-detection runs for a Next.js project — unsafe here. */
export const AUTODETECTED_BUILD_COMMAND = "npm run build";

export type BuildCommandSource = "project" | "vercel.json" | "auto-detect";

export interface BuildCommandAssessment {
  /** The command Vercel will actually run. */
  effective: string;
  source: BuildCommandSource;
  ok: boolean;
  /** Human-readable problems; empty when ok. */
  problems: string[];
}

/** Collapse run-to-run whitespace differences without changing semantics. */
export function normalizeBuildCommand(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized === "" ? null : normalized;
}

/**
 * Compute the effective build command the same way Vercel does and
 * compare it to the required command.
 *
 * @param projectBuildCommand  the project-level Build Command setting
 *   (dashboard / Vercel API `buildCommand` field; null when unset)
 * @param repoBuildCommand     `buildCommand` from vercel.json (null when
 *   absent or the file is missing/invalid)
 */
export function assessBuildCommand(
  projectBuildCommand: string | null | undefined,
  repoBuildCommand: string | null | undefined,
): BuildCommandAssessment {
  const project = normalizeBuildCommand(projectBuildCommand);
  const repo = normalizeBuildCommand(repoBuildCommand);

  let effective: string;
  let source: BuildCommandSource;
  if (project !== null) {
    effective = project;
    source = "project";
  } else if (repo !== null) {
    effective = repo;
    source = "vercel.json";
  } else {
    effective = AUTODETECTED_BUILD_COMMAND;
    source = "auto-detect";
  }

  const problems: string[] = [];
  if (effective !== REQUIRED_VERCEL_BUILD_COMMAND) {
    problems.push(
      `effective build command (${source}: "${effective}") does not run ` +
        `vercel-build.ts — database identity checks and migrations are bypassed; ` +
        `required: "${REQUIRED_VERCEL_BUILD_COMMAND}"`,
    );
  }
  // A project-level override that disagrees with vercel.json is worth
  // flagging even when the effective value is still correct: the repo
  // declaration becomes misleading documentation.
  if (
    project !== null &&
    repo !== null &&
    project !== repo &&
    project === REQUIRED_VERCEL_BUILD_COMMAND
  ) {
    problems.push(
      `vercel.json declares "${repo}" but the project setting overrides it ` +
        `with "${project}" — align vercel.json so the repo documents the truth`,
    );
  }

  return { effective, source, ok: problems.length === 0, problems };
}
