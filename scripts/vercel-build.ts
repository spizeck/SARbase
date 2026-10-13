import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  arePostgresqlUrlsSameDatabase,
  normalizeDatabaseEndpoint,
} from "../src/lib/env";

/**
 * Vercel build wrapper: applies committed Prisma migrations during the
 * build for Production deployments and for Preview deployments whose
 * database passes positive-identity verification.
 *
 * Derived from the RISE Saba implementation (its issues #86/#91
 * iteration), generalized to APP_PRODUCTION_DB_HOST +
 * APP_PREVIEW_DB_HOST per the app-foundations database-lifecycle
 * standard (ADR-0001, model A).
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
 * Preview safety: the neon-preview workflow writes branch-scoped
 * Preview env vars for each PR — DATABASE_URL, DATABASE_URL_UNPOOLED,
 * and APP_PREVIEW_DB_HOST, the canonical host of that PR's
 * `preview/pr-<n>` Neon branch. This script enforces three checks
 * before migrating: APP_PRODUCTION_DB_HOST (a non-secret hostname, set
 * on the Preview AND Production environments) is an exclusion check
 * that fails the build if either URL points at Production;
 * APP_PREVIEW_DB_HOST is a positive identity check — a preview
 * DATABASE_URL whose host is not the verified preview-branch host fails
 * the build rather than running migrations against an unverifiable
 * database; and both URLs must resolve to the SAME database so the
 * pooled runtime and the unpooled migration endpoint cannot diverge.
 * A missing DATABASE_URL still skips migrations (a branch pushed
 * without a PR simply has no preview database), but a
 * present-but-unverifiable configuration fails closed — there is no
 * fallback to production or testing credentials.
 *
 * Production safety: the production deployment must positively prove it
 * is building against the production host — DATABASE_URL and
 * DATABASE_URL_UNPOOLED must both be present and both resolve to
 * APP_PRODUCTION_DB_HOST. A production deployment without that proof
 * fails the build rather than migrating an unknown database.
 *
 * Migration endpoint: the Prisma datasource declares
 * `directUrl = env("DATABASE_URL_UNPOOLED")`, so `migrate deploy`
 * always uses the direct endpoint — PgBouncer pooling breaks the
 * session-level advisory lock migrations depend on.
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

/**
 * Canonical hostname of a Postgres connection string — lowercased and
 * pooler-normalized so a Neon pooled URL cannot bypass a direct
 * production-host check. Null if unparseable.
 */
function dbHostname(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname;
    return hostname ? normalizeDatabaseEndpoint(hostname) : null;
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
    if (!env.DATABASE_URL_UNPOOLED) {
      console.error(
        `${TAG} VERCEL_ENV=production but DATABASE_URL_UNPOOLED is not set — migrations run on the direct endpoint; refusing to build.`,
      );
      return 1;
    }
    // Positive identity: the URLs must BE the production host, not
    // merely "a host that isn't excluded". Without the marker we cannot
    // distinguish production from a miswired preview database.
    const prodHost = env.APP_PRODUCTION_DB_HOST?.trim();
    if (!prodHost) {
      console.error(
        `${TAG} VERCEL_ENV=production but APP_PRODUCTION_DB_HOST is not configured — cannot verify the production database host; refusing to build. See docs/database.md.`,
      );
      return 1;
    }
    const normalizedProdHost = normalizeDatabaseEndpoint(prodHost);
    const candidateHosts = [env.DATABASE_URL, env.DATABASE_URL_UNPOOLED].map(
      dbHostname,
    );
    if (candidateHosts.some((h) => h === null)) {
      console.error(
        `${TAG} a configured database URL hostname could not be parsed — refusing to migrate.`,
      );
      return 1;
    }
    if (candidateHosts.some((h) => h !== normalizedProdHost)) {
      console.error(
        `${TAG} a database URL does not resolve to the configured production host (APP_PRODUCTION_DB_HOST) — refusing to migrate or build against an unverified database.`,
      );
      return 1;
    }
    if (
      !arePostgresqlUrlsSameDatabase(
        env.DATABASE_URL,
        env.DATABASE_URL_UNPOOLED,
      )
    ) {
      console.error(
        `${TAG} DATABASE_URL and DATABASE_URL_UNPOOLED resolve to different databases — refusing to migrate.`,
      );
      return 1;
    }
    console.log(
      `${TAG} production deployment verified against APP_PRODUCTION_DB_HOST — applying committed migrations (npm run db:migrate:deploy)`,
    );
    const failed = runMigrations(run);
    if (failed !== null) return failed;
  } else if (env.VERCEL_ENV === "preview") {
    if (!env.DATABASE_URL) {
      console.log(
        `${TAG} preview deployment without DATABASE_URL — no preview branch provisioned; skipping migrations`,
      );
    } else {
      // Fail closed on every identity gap: a preview that cannot prove
      // which database it targets must not migrate (or silently skip
      // while deploying) — the build fails instead.
      if (!env.DATABASE_URL_UNPOOLED) {
        console.error(
          `${TAG} preview has DATABASE_URL but DATABASE_URL_UNPOOLED is not set — migrations run on the direct endpoint; refusing to migrate or build.`,
        );
        return 1;
      }
      const prodHost = env.APP_PRODUCTION_DB_HOST?.trim();
      if (!prodHost) {
        console.error(
          `${TAG} preview has DATABASE_URL but APP_PRODUCTION_DB_HOST is not configured — cannot exclude the production host; refusing to migrate or build. See docs/database.md.`,
        );
        return 1;
      }
      const normalizedProdHost = normalizeDatabaseEndpoint(prodHost);
      const candidateHosts = [env.DATABASE_URL, env.DATABASE_URL_UNPOOLED].map(
        dbHostname,
      );
      if (candidateHosts.some((h) => h === null)) {
        console.error(
          `${TAG} a configured database URL hostname could not be parsed — refusing to migrate.`,
        );
        return 1;
      }
      if (candidateHosts.some((h) => h === normalizedProdHost)) {
        console.error(
          `${TAG} preview database URL resolves to the configured production host — refusing to migrate or build against Production.`,
        );
        return 1;
      }
      const expectedHost = env.APP_PREVIEW_DB_HOST?.trim();
      if (!expectedHost) {
        console.error(
          `${TAG} preview has DATABASE_URL but APP_PREVIEW_DB_HOST is not set — preview database identity cannot be verified; refusing to migrate or build. See docs/preview-databases.md.`,
        );
        return 1;
      }
      const normalizedExpected = normalizeDatabaseEndpoint(expectedHost);
      if (normalizedExpected === normalizedProdHost) {
        console.error(
          `${TAG} APP_PREVIEW_DB_HOST equals the production host — refusing to migrate; preview identity is misconfigured.`,
        );
        return 1;
      }
      if (candidateHosts.some((h) => h !== normalizedExpected)) {
        console.error(
          `${TAG} a preview database URL does not resolve to the verified preview host (APP_PREVIEW_DB_HOST) — refusing to migrate or build against an unverified database.`,
        );
        return 1;
      }
      if (
        !arePostgresqlUrlsSameDatabase(
          env.DATABASE_URL,
          env.DATABASE_URL_UNPOOLED,
        )
      ) {
        console.error(
          `${TAG} DATABASE_URL and DATABASE_URL_UNPOOLED resolve to different databases — refusing to migrate.`,
        );
        return 1;
      }
      console.log(
        `${TAG} preview database verified against APP_PREVIEW_DB_HOST — applying committed migrations (npm run db:migrate:deploy)`,
      );
      const failed = runMigrations(run);
      if (failed !== null) return failed;
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
