# Preview databases (Model A)

SARbase implements the app-foundations database-lifecycle standard
(ADR-0001, `standards/database-lifecycle.md`): every eligible pull
request gets an isolated Neon branch `preview/pr-<n>` created from the
permanent `testing` branch — never from `main`/production.

This runbook covers one-time setup, day-to-day behavior, controlled
live validation, and recovery. All Neon/Vercel mutations are performed
by `.github/workflows/neon-preview.yml` + `scripts/neon-preview.ts`;
nothing here requires local credentials.

## Topology

| Neon branch      | Lifetime  | Parent    | Data            | Created/deleted by        |
| ---------------- | --------- | --------- | --------------- | ------------------------- |
| `main`           | permanent | —         | production      | never touched by the flow |
| `testing`        | permanent | `main`¹   | fictional seeds | created once by the owner |
| `preview/pr-<n>` | per PR    | `testing` | fictional       | the neon-preview workflow |

¹ `testing` may only be created from `main` while production holds no
real data. Once production is populated, `testing` is maintained by
migrations + `db:seed`, never refreshed from production.

## One-time setup (owner actions)

### 1. Neon

1. Create the permanent `testing` branch (Neon console or API) from
   `main` — do this **before** production holds real data, or create it
   empty and seed it.
2. Mark `testing` as protected in Neon so it cannot be deleted or reset
   accidentally. `main` is already primary/protected.
3. Create a Neon API key scoped to this project → GitHub secret
   `NEON_API_KEY`.
4. Initialize `testing` — run the **"Initialize Neon testing
   database"** workflow (Actions tab → Run workflow). It resolves the
   branch and both connection URIs through the Neon API, verifies the
   target is not production, then runs `migrate deploy` → `db:seed` →
   `db:verify`. See [Initializing the testing baseline](#initializing-the-testing-baseline).

   The manual equivalent (e.g. from a maintainer workstation) is:

   ```bash
   DATABASE_URL_UNPOOLED=<testing direct URL> \
   APP_PRODUCTION_DB_HOST=<prod host> APP_TESTING_DB_HOST=<testing host> \
   npm run db:migrate:deploy
   npm run db:seed -- --target testing --confirm
   npm run db:verify   # same env — must exit 0
   ```

### 2. Vercel

1. **Remove or disable the native Vercel–Neon integration** for this
   project if present — it creates branches off the project default
   branch (production) and injects project-wide `DATABASE_URL*`,
   bypassing the branch-scoped model.
2. Delete any project-level **Preview**-scoped `DATABASE_URL`,
   `DATABASE_URL_UNPOOLED`, or `APP_PREVIEW_DB_HOST` — previews get
   theirs git-branch-scoped from the workflow. A stale project-level
   value would serve as an implicit fallback for branches without a
   provisioned database.
3. Keep `DATABASE_URL` + `DATABASE_URL_UNPOOLED` on the **Production**
   environment only.
4. Set `APP_PRODUCTION_DB_HOST` (plain hostname, no scheme/credentials)
   on **Production and Preview** — it is the identity anchor for both.
5. Confirm the project **Build Command** is `npm run build:vercel` —
   see [Required Vercel build command](#required-vercel-build-command).
   This is what makes database identity checks and migrations run
   inside every deployment.
6. Decide preview external-service posture (default: all off):
   - `FIREBASE_ADMIN_*` — do not set on Preview unless preview sign-ins
     should work. Two supported postures, both requiring
     `ALLOW_FIREBASE_ADMIN_IN_PREVIEW=true`:
     a _dedicated_ preview Firebase project (set its
     `NEXT_PUBLIC_FIREBASE_*` + matching `FIREBASE_ADMIN_*`), or —
     the current small-team choice — the _shared_ production project
     (same `FIREBASE_ADMIN_*` values on Preview). Shared means the same
     user pool signs in on previews, but grants still come from the
     preview's own Neon branch; the one caveat is that preview
     sign-out revokes that user's production sessions too. One guard
     applies either way: when `NEXT_PUBLIC_FIREBASE_PROJECT_ID` is set,
     the Admin SDK refuses to initialize if it does not equal
     `FIREBASE_ADMIN_PROJECT_ID` — a service account for a different
     project than the app's client config is a credential leak, not
     configuration.
   - `RESEND_API_KEY`/`NOTIFICATION_PROVIDER` — leave unset on Preview
     (notifications use the in-process fake). For a real mail test use
     a preview Resend key + `NOTIFICATION_PROVIDER=resend` +
     `ALLOW_RESEND_IN_PREVIEW=true`.
   - `FILE_STORAGE_PROVIDER=s3` — leave unset on Preview (local
     fallback) or set a dedicated preview bucket plus
     `ALLOW_S3_IN_PREVIEW=true`.

### 3. GitHub repository

Secrets (repo → Settings → Secrets and variables → Actions):

| Name           | Kind   | Notes                              |
| -------------- | ------ | ---------------------------------- |
| `NEON_API_KEY` | secret | project-scoped Neon API key        |
| `VERCEL_TOKEN` | secret | Vercel token with env/deploy scope |

Variables:

| Name                  | Kind     | Notes                                   |
| --------------------- | -------- | --------------------------------------- |
| `NEON_PROJECT_ID`     | variable | the enable switch — unset = flow no-ops |
| `VERCEL_TEAM_ID`      | variable |                                         |
| `VERCEL_PROJECT_ID`   | variable |                                         |
| `VERCEL_PROJECT_NAME` | variable | used for the triggered redeployment     |
| `NEON_DATABASE`       | variable | optional, default `neondb`              |
| `NEON_ROLE`           | variable | optional, default `neondb_owner`        |

## Day-to-day behavior

- **Open/reopen a same-repo PR targeting the default branch** →
  workflow creates `preview/pr-<n>` from `testing`, writes
  `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, and `APP_PREVIEW_DB_HOST`
  as preview env vars scoped to the PR's git branch, and triggers a
  fresh deployment for the head SHA. PRs targeting a non-default base
  are never provisioned (a non-default base can be unmerged
  contributor code, so it is outside the trust boundary).
- **Retarget a PR** (`edited` event) → retargeting TO the default
  branch provisions; retargeting AWAY from it tears the preview down.
- **Push to the PR** → provisioning is idempotent (the branch is reused)
  and Vercel auto-deploys pick up the vars.
- **Close/merge the PR** → the Neon branch and its branch-scoped env
  vars are deleted unconditionally (cleanup is deliberately not gated
  on eligibility).
- **Dependabot and fork PRs** → never provisioned; denied in the
  workflow `if`, the `gate` step, and the script itself.
- **Weekly reconcile** (Mondays 04:17 UTC) → dry-run report of orphaned
  `preview/pr-*` branches: retained when the owning PR is open, the PR
  lookup fails, or the close happened within the last hour.
- **Manual reconcile** → Actions → "Neon preview databases" → Run
  workflow with `dry_run` unchecked to actually delete reported orphans.
  Deletion never happens on the schedule.

`vercel.json` disables Vercel preview builds for `dependabot/**`
branches on top of the database-side denial.

**Shared head branches:** Vercel scopes env vars per git branch, not
per PR. If two open PRs share one `head.ref` (e.g. a duplicate or
retargeted PR), the later PR's provisioning is refused — the earlier
PR's variables stay authoritative. When a PR on a shared ref closes,
its Neon branch is deleted but the branch-scoped env vars are kept for
the surviving open PR (its next provision rewrites them to its own
preview branch). Avoid opening two PRs from the same branch.

## Initializing the testing baseline

`.github/workflows/neon-testing-init.yml` applies committed migrations,
seeds the fictional baseline, and verifies the result on the permanent
`testing` branch. It is `workflow_dispatch`-only and deliberately
separate from the automatic PR lifecycle.

### Prerequisites

- The `testing` branch exists in the `SARBase-db` Neon project
  (`rough-thunder-07294432`) and is not the primary branch.
- GitHub secret `NEON_API_KEY` — a project-scoped Neon API key.
- Optional repo variables `NEON_DATABASE` (default `neondb`) and
  `NEON_ROLE` (default `neondb_owner`).
- **Not required:** `vars.NEON_PROJECT_ID` — the init workflow pins the
  project id as an internal identity constant, so it works before
  automatic preview provisioning is activated.

### Run it

Actions → **Initialize Neon testing database** → Run workflow. The job
checks out the default branch, runs `npm ci`, then
`scripts/neon-testing-init.ts`, which:

1. Verifies the Neon project (id + name) and resolves the `testing`
   and primary branches through the API.
2. Fetches pooled + unpooled connection URIs for `testing` and a URI
   for the primary branch; masks every credential before use.
3. Fails closed unless `testing` is non-primary, both URIs parse
   cleanly (no routing-override query parameters), resolve to the same
   non-loopback database, and differ from the primary branch's host.
4. Runs `prisma migrate deploy`, `db:seed -- --target testing
--confirm`, and `db:verify`, each receiving
   `APP_TESTING_DB_HOST`/`APP_PRODUCTION_DB_HOST` derived from the
   verified hosts — so the tooling re-checks the same identities.
5. Writes a sanitized job summary (host:port/database only — never a
   connection string).

A green run ends with `db:verify OK` in the verify step's output and a
summary table showing all three steps passed.

### Safe reruns and partial failure

The whole flow is idempotent: `migrate deploy` only applies pending
migrations, the seed uses fixed `seed-*` upserts, and `db:verify` is
read-only. If a step fails, the job stops — fix the cause and re-run
the workflow; earlier completed steps simply re-verify.

- **`migrate deploy` fails** → check the step log; the most common
  cause is a migration that fails on partially-applied state. Neon
  instant restore on the `testing` branch can roll back, then re-run.
- **`db:seed` fails** → usually identity misconfiguration; the log
  names which guard refused.
- **`db:verify` warns** → non-seed rows exist on `testing` (e.g. a
  preview accidentally pointed at it). Warnings do not fail the run;
  failures (non-fictional members/identities, production host) do.

### Activating preview provisioning afterward

Once `testing` is verified, set the GitHub repo **variable**
`NEON_PROJECT_ID` to `rough-thunder-07294432` — that is the enable
switch for `neon-preview.yml`. Confirm the Vercel prerequisites in
[One-time setup](#2-vercel) first (native integration posture,
`APP_PRODUCTION_DB_HOST` on Production and Preview, no project-level
Preview database URLs), then validate with a disposable PR per
[Controlled live validation](#controlled-live-validation-owner-disposable-pr).

## Required Vercel build command

Every SARbase Vercel deployment must build with
**`npm run build:vercel`**. That command runs
`scripts/vercel-build.ts`, which performs the database identity checks
and applies committed Prisma migrations before `next build`.

**Why `npm run build` is insufficient:** it is a bare `next build`. It
compiles and deploys successfully while silently skipping migrations
and every production/preview identity guard — the deployment reaches
READY against an unmigrated or even miswired database. This exact
failure was discovered during PR #49's lifecycle validation: the
project's Build Command had been left at `npm run build`, so the first
preview deployment never ran `vercel-build.ts` at all. The build
succeeded; only reading the build log revealed the gap.

### Where it is configured

Vercel resolves the build command in precedence order:

1. The **project-level Build Command setting** (Vercel dashboard →
   Settings → General → Build Command, or the `buildCommand` field via
   the API). When set, it overrides everything below.
2. **`buildCommand` in `vercel.json`** — declared in the repository
   (`"buildCommand": "npm run build:vercel"`), so the requirement is
   version-controlled and applies whenever the project setting is
   unset.
3. Framework auto-detection — for Next.js, `npm run build` (unsafe
   here; see above).

Both layers 1 and 2 are set to the same required value. Keeping the
dashboard override in place is deliberate defense in depth: an
accidental `vercel.json` regression then cannot change the effective
command, and the scheduled check verifies the dashboard layer that
repo review cannot see.

### How to verify the effective setting

- **Repository side** — on every PR, the unit tests in
  `scripts/vercel-build-check.test.ts` assert `vercel.json` declares
  the required command and that `build:vercel` invokes
  `scripts/vercel-build.ts`. No secrets needed; fork PRs included.
- **Project side** — the **Vercel build-command check** workflow
  (`.github/workflows/vercel-build-check.yml`) reads the project's
  `buildCommand` back through the Vercel API and compares it with
  `vercel.json`, resolving precedence exactly the way Vercel does. It
  runs daily, on pushes to the default branch, and manually via
  Actions → "Vercel build-command check" → Run workflow. It is
  read-only and prints no credentials.
- **Manually** — Vercel dashboard → project → Settings → General →
  Build Command should read `npm run build:vercel`.

The remote check reports three distinct outcomes: **OK**, **MISMATCH**
(the effective command verifiably bypasses `vercel-build.ts`), or
**UNVERIFIABLE** (missing config, API error, or insufficient
permissions). UNVERIFIABLE still fails the job — it is never reported
as a pass.

### What the logs look like

A healthy build log contains one of:

- `preview database verified against APP_PREVIEW_DB_HOST — applying
committed migrations (npm run db:migrate:deploy)` followed by Prisma
  `migrate deploy` output (previews with a provisioned database);
- `production deployment verified against APP_PRODUCTION_DB_HOST —
applying committed migrations` (production);
- `preview deployment without DATABASE_URL — no preview branch
provisioned; skipping migrations` (previews without a database);
- `migrations applied or already current — building` after the
  migration step.

A build log that goes straight from `npm run build:vercel` to Next.js
compilation with none of those lines — or that shows `npm run build`
at all — means the safeguard did not run.

### When migrations or identity checks fail

`vercel-build.ts` exits non-zero → the build fails → the deployment is
**never promoted**; the previous release keeps serving. A failed or
refused migration cannot deploy broken code. Recovery is fix-forward:
land a corrective migration in a new commit — never `migrate reset` a
hosted branch.

### Preventing future drift

- Do not change `buildCommand` in `vercel.json`, the `build:vercel`
  script in `package.json`, or the project Build Command setting —
  the unit test and the scheduled check will catch all three.
- If the project Build Command is intentionally cleared, `vercel.json`
  takes over — keep it correct.
- If the scheduled check reports MISMATCH, restore
  `npm run build:vercel` in the Vercel project settings, then treat
  the intervening deployments as unverified: confirm `migrate status`
  on the affected database before deploying again.

## Controlled live validation (owner, disposable PR)

After the one-time setup, validate end-to-end with a throwaway PR:

1. Open a trivial same-repo PR (e.g. a comment change).
2. Confirm the workflow runs: Neon branch `preview/pr-<n>` exists with
   parent `testing`; Vercel preview env shows the three branch-scoped
   vars; a fresh deployment was triggered.
3. Confirm the build log shows `preview database verified against
APP_PREVIEW_DB_HOST — applying committed migrations`.
4. Confirm preview behavior: app works against fictional seed data,
   sign-in is unavailable (no Admin creds), notifications use the fake
   provider, uploads use local storage.
5. Close the PR. Confirm the Neon branch and the three env vars are
   gone; rerun reconcile in dry-run to confirm nothing is stale.

## Failure handling and rollback

- **Provisioning fails** → the PR simply has no preview database; the
  Vercel preview build skips migrations and builds without one.
  Re-run the failed workflow job or push another commit.
- **Migration fails in a build** → the build aborts and the deployment
  is never promoted. Recovery is fix-forward: land a corrective
  migration in a new commit; never `migrate reset`/`migrate dev` a
  hosted branch and never assume automatic rollback.
- **Teardown misses** → the weekly reconcile reports the orphan; delete
  it via manual dispatch (dry_run unchecked) or the Neon console.
- **Rollback of this feature** → set the `NEON_PROJECT_ID` GitHub
  variable empty: the workflow no-ops everywhere while remaining
  installed. Deleting the workflow file is the fuller removal.

## Safety invariants (enforced in `scripts/neon-preview.ts`)

- Branch names must match `preview/pr-<digits>` exactly.
- A preview branch must be a verified child of `testing`; deletions
  verify the parent too.
- `main`, `testing`, primary, and protected branches can never be
  created-over or deleted by the script.
- Connection URLs are masked before use and never printed; env values
  are never read back from Vercel.
- Provider secrets are unreachable from PR code: `pull_request_target`
  jobs check out the repository's default branch — never
  `pull_request.base.sha` (which can be contributor-controlled on
  non-default bases) or PR head code — so `npm ci` and the lifecycle
  script always run trusted revisions. Provisioning additionally
  requires the PR to target the default branch, and fork/Dependabot
  PRs are denied in three places.
