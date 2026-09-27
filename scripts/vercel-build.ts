import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Vercel build wrapper: applies committed Prisma migrations during the
 * build for Production deployments and for Preview deployments whose
 * database clears the production-host exclusion check.
 *
 * Derived from the RISE Saba implementation (its issues #86/#91
 * iteration), generalized to APP_PRODUCTION_DB_HOST.
 *
 * Ordering guarantee: Vercel runs install → buildCommand → promote. A
 * non-zero exit here fails the build, so a failed migration means the
 * deployment is never promoted and the previous release keeps serving.
 * The trade-off to be aware of: migrations apply before the new build
 * exists, so migrations must stay backward-compatible with the
 * currently-serving release (expand/contract discipline — see
 * docs/database.md).
 *
 * Environment gating uses VERCEL_ENV, Vercel's authoritative deployment
 * signal — available at build time and independent of which environment
 * variables a deployment can see.
 *
 * Preview safety: the Neon-managed Vercel integration injects a
 * per-deployment DATABASE_URL for the `preview/<git-branch>` branch —
 * database isolation for previews is guaranteed by that integration's
 * configuration, not by this script. What this script adds is
 * defense-in-depth: APP_PRODUCTION_DB_HOST (a non-secret hostname, set
 * on the Preview environment) is an exclusion check, so a preview whose
 * DATABASE_URL still points at the Production host fails the build
 * rather than running migrations against it. The check does not prove
 * the URL is the intended preview branch — a stale or wrong
 * non-production URL would also pass — so a missing marker skips
 * migrations instead of guessing.
 *
 * If your team prefers operator-gated production migrations instead
 * (the Sea Saba posture), delete the production branch of this gate and
 * run `prisma migrate deploy` manually per docs/database.md — do not
 * silently keep both.
 */

type RunResult = { status: number | null };
export type Runner = (command: string, args: string[]) => RunResult;

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

const defaultRunner: Runner = (command, args) =>
  // shell is required for npm.cmd resolution on Windows dev machines;
  // on Vercel's Linux builders it changes nothing (fixed literal args).
  spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

const TAG = "[vercel-build]";

/** Hostname of a Postgres connection string, lowercased — null if unparseable. */
function dbHostname(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function runMigrations(run: Runner): number | null {
  const migrate = run(npmCmd, ["run", "db:migrate:deploy"]);
  if (migrate.status !== 0) {
    console.error(
      `${TAG} migration step failed (exit ${migrate.status ?? "unknown"}) — build aborted; the deployment will not be promoted.`,
    );
    return migrate.status ?? 1;
  }
  console.log(`${TAG} migrations applied or already current — building`);
  return null;
}

export function runVercelBuild(
  env: Record<string, string | undefined> = process.env,
  run: Runner = defaultRunner,
): number {
  if (env.VERCEL_ENV === "production") {
    // Fail closed: a production release without database access would
    // deploy new code against an unmigrated schema — the exact incident
    // this automation exists to prevent.
    if (!env.DATABASE_URL) {
      console.error(
        `${TAG} VERCEL_ENV=production but DATABASE_URL is not set — refusing to build against an unknown migration state.`,
      );
      return 1;
    }
    console.log(
      `${TAG} production deployment — applying committed migrations (npm run db:migrate:deploy)`,
    );
    const failed = runMigrations(run);
    if (failed !== null) return failed;
  } else if (env.VERCEL_ENV === "preview") {
    if (!env.DATABASE_URL) {
      console.log(
        `${TAG} preview deployment without DATABASE_URL — no preview branch injected; skipping migrations`,
      );
    } else {
      const prodHost = env.APP_PRODUCTION_DB_HOST?.trim().toLowerCase();
      if (!prodHost) {
        console.warn(
          `${TAG} preview has DATABASE_URL but APP_PRODUCTION_DB_HOST is not configured — cannot exclude the production host; skipping migrations. See docs/database.md.`,
        );
      } else if (dbHostname(env.DATABASE_URL) === prodHost) {
        console.error(
          `${TAG} preview DATABASE_URL resolves to the configured production host — refusing to migrate or build against Production.`,
        );
        return 1;
      } else {
        console.log(
          `${TAG} preview database differs from configured production host — applying committed migrations (npm run db:migrate:deploy)`,
        );
        const failed = runMigrations(run);
        if (failed !== null) return failed;
      }
    }
  } else {
    console.log(
      `${TAG} VERCEL_ENV=${env.VERCEL_ENV ?? "unset"} — skipping migrations (local/CI build)`,
    );
  }
  const build = run(npmCmd, ["run", "build"]);
  return build.status ?? 1;
}

// Runs only when executed directly (`tsx scripts/vercel-build.ts`), not on
// import by tests.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(runVercelBuild());
}
