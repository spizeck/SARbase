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
3. Apply committed migrations to `testing` and seed it:

   ```bash
   DATABASE_URL_UNPOOLED=<testing direct URL> \
   APP_PRODUCTION_DB_HOST=<prod host> APP_TESTING_DB_HOST=<testing host> \
   npm run db:seed -- --target testing --confirm
   npm run db:verify   # same env — must exit 0
   ```

4. Create a Neon API key scoped to this project → GitHub secret
   `NEON_API_KEY`.

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
5. Decide preview external-service posture (default: all off):
   - `FIREBASE_ADMIN_*` — do not set on Preview. To exercise auth on
     previews, create a dedicated Firebase project, set its
     `NEXT_PUBLIC_FIREBASE_*` + matching `FIREBASE_ADMIN_*` on Preview,
     and set `ALLOW_FIREBASE_ADMIN_IN_PREVIEW=true`.
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

- **Open/reopen a same-repo PR** → workflow creates `preview/pr-<n>`
  from `testing`, writes `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, and
  `APP_PREVIEW_DB_HOST` as preview env vars scoped to the PR's git
  branch, and triggers a fresh deployment for the head SHA.
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
  runs the base branch's trusted revision (`pull_request.base.sha`
  checkout), and fork/Dependabot PRs are denied in three places.
