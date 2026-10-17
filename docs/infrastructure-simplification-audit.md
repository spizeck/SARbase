# Deployment & database infrastructure simplification audit

**Status:** read-only audit, 2026-10-17. No cloud configuration,
secrets, workflows, or code were modified. Recommendation only —
implementation waits for owner review.

**Context:** SARbase was scaffolded from the `app-foundations`
next-neon template (issue #1). The deployment infrastructure encodes a
portfolio-wide database-lifecycle standard (ADR-0001, "Model A")
inherited from larger multi-developer projects — not designed for a
single-developer, pre-launch application. That framing drives most of
this audit's findings.

---

## 1. Current architecture

```
Open PR (same-repo, non-dependabot, base=main)
  │
  ├─ neon-preview.yml :: provision  [pull_request_target]
  │    ├─ gate: policy re-check (fork/dependabot/non-default base denied)
  │    ├─ neondatabase/create-branch-action → Neon branch preview/pr-<n> ← parent `testing`
  │    └─ scripts/neon-preview.ts provision:
  │         verify branch identity → write 3 Vercel env vars scoped to git branch
  │         (DATABASE_URL, DATABASE_URL_UNPOOLED, APP_PREVIEW_DB_HOST)
  │         → warn if FIREBASE_ADMIN_* present → trigger fresh Vercel deploy
  │
  ├─ Vercel builds preview → npm run build:vercel → scripts/vercel-build.ts
  │    verifies preview DB host == APP_PREVIEW_DB_HOST ≠ prod → prisma migrate deploy → next build
  │
  ├─ ci.yml :: Detect changes → App (check gate + Playwright) / Database (docker pg:
  │    migration replay + drift + db tests + restore drill) / Infra (cfn-lint)
  │
  ├─ PR close/merge → neon-preview.yml :: teardown (delete Neon branch + env vars)
  │    + shared-head-ref collision handling
  │
  └─ Weekly cron → neon-preview.yml :: reconcile (dry-run orphan report;
         deletion only via manual workflow_dispatch)

Merge to main → Vercel production deploy → build:vercel → production
identity check (APP_PRODUCTION_DB_HOST) → migrate deploy → next build → promote

Supporting machinery:
  vercel-build-check.yml  daily + per-push remote check that the effective
                          Vercel build command still is build:vercel
  neon-testing-init.yml   manual workflow: migrate + seed + verify `testing`
  hosted-smoke.yml        manual Playwright against a given URL
  scripts/destructive-db-guard + db-target + migrate.ts
                          local/CI destructive-command safety
```

## 2. Custom script inventory (deployment-relevant)

| Script                                                                                     | Lines (impl+test) | Role                                                            |
| ------------------------------------------------------------------------------------------ | ----------------- | --------------------------------------------------------------- |
| `scripts/neon-preview.ts`                                                                  | 916 + 725         | gate/provision/teardown/reconcile — Neon + Vercel + GH APIs     |
| `scripts/neon-testing-init.ts`                                                             | 355 + 365         | one-time `testing` baseline init with identity verification     |
| `scripts/vercel-build.ts`                                                                  | 290 + 237         | build wrapper: DB identity checks + migrate deploy + build      |
| `scripts/vercel-build-check.ts`                                                            | 207 + 275         | remote check the Vercel project build command is `build:vercel` |
| `scripts/lib/{db-target,destructive-db-guard,postgres-credentials,vercel-build-config}.ts` | ~600 combined     | shared safety/config helpers                                    |
| `scripts/migrate.ts`                                                                       | 170               | local migrate dev/reset/push wrapper with guards                |
| `scripts/wait-for-postgres.ts`                                                             | 158               | TCP-readiness probe for docker Postgres (initdb race fix)       |
| `scripts/verify-database.ts`                                                               | 360               | fictional-data/environment sanity verifier                      |
| `scripts/{backup-database,restore-drill}.ts`                                               | 796+              | backup + restore drill (local/CI)                               |
| `scripts/provision-admin.ts`                                                               | 168               | bootstrap first admin identity                                  |

Deployment-infra total: ~2,400 lines of implementation + ~1,800 lines
of tests + 698 lines of workflows + ~800 lines of docs for the preview
lifecycle alone.

## 3. GitHub Actions inventory

| Workflow                 | Trigger                                    | Lines | Purpose                               |
| ------------------------ | ------------------------------------------ | ----- | ------------------------------------- |
| `ci.yml`                 | pull_request, push→main                    | 268   | change-aware gates (app/db/infra/e2e) |
| `neon-preview.yml`       | pull_request_target + weekly cron + manual | 245   | per-PR Neon preview DB lifecycle      |
| `neon-testing-init.yml`  | manual only                                | 68    | initialize `testing` baseline         |
| `vercel-build-check.yml` | daily cron + push→main + manual            | 63    | remote build-command drift detection  |
| `hosted-smoke.yml`       | manual only                                | 54    | smoke a deployed URL                  |

## 4. Credentials & config inventory

**GitHub secrets:** `NEON_API_KEY`, `VERCEL_TOKEN` (preview workflow),
`VERCEL_AUTOMATION_BYPASS_SECRET`, `SMOKE_TEST_EMAIL/PASSWORD`,
`SMOKE_DATABASE_URL`, `SMOKE_CALLOUT_RESPONSE_TOKEN_SECRET`
(all optional — hosted smoke skips without them).

**GitHub variables:** `NEON_PROJECT_ID` (enable switch),
`VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `VERCEL_PROJECT_NAME`,
`NEON_DATABASE`, `NEON_ROLE`.

**Vercel env:** Production — `DATABASE_URL`, `DATABASE_URL_UNPOOLED`,
`APP_PRODUCTION_DB_HOST` (+feature flags). Preview — `APP_PRODUCTION_DB_HOST`,
per-git-branch `DATABASE_URL`, `DATABASE_URL_UNPOOLED`,
`APP_PREVIEW_DB_HOST` written by the workflow; feature flags default
off (`ALLOW_*_IN_PREVIEW` gates).

## 5. Native capability check (verified 2026-10-17)

| Capability                                                                                                       | Verdict for SARbase                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Neon ↔ Vercel managed integration** — auto-creates a DB branch per preview, injects `DATABASE_URL*`, cleans up | **Not a fit.** Preview branches clone the _project default branch_ — our production database. Model A exists precisely because previews must start from fictional `testing` data, and production will hold real volunteer PII. The integration offers no parent-branch selection or schema-only/anonymized branching for previews. (This is also what `docs/preview-databases.md` setup step 2.1 warns about.) |
| **Neon branch expiration (`expires_at` TTL)** — auto-deletes a branch at a set time                              | **Usable.** Could replace the orphan-cleanup _safety net_: set e.g. 14-day TTL at creation; teardown still deletes promptly on PR close. TTL is a single API field vs. a scheduled reconcile job. Caveat: TTL applies to API-created branches; verify `create-branch-action` exposes it (else one API call in `provision`).                                                                                    |
| `neondatabase/create-branch-action`                                                                              | Already used for creation.                                                                                                                                                                                                                                                                                                                                                                                     |
| `neondatabase/delete-branch-action`                                                                              | Could replace the Neon-half of `teardown` — but teardown also deletes Vercel env vars, so a script step remains regardless. Marginal gain.                                                                                                                                                                                                                                                                     |
| **Vercel native preview deploys**                                                                                | Already used (git push → preview). No custom work needed.                                                                                                                                                                                                                                                                                                                                                      |
| **Vercel deployment checks / pre-deploy hooks**                                                                  | No native "run migrations before promote" hook — `vercel-build.ts` is the only place that guarantee can live.                                                                                                                                                                                                                                                                                                  |
| **GitHub Environments**                                                                                          | Not used today (repo-level secrets only). Would add a second secret store to sync — more parts, not fewer, at this scale.                                                                                                                                                                                                                                                                                      |
| **Prisma `migrate deploy`**                                                                                      | Already the mechanism everywhere — no simplification possible or needed.                                                                                                                                                                                                                                                                                                                                       |

## 6. Component-by-component verdict

### KEEP (core safety, already minimal)

- **`scripts/vercel-build.ts` + `build:vercel` + `vercel.json` buildCommand.** The production ordering guarantee (migrate → build → promote; failure = never promoted) has no native equivalent. The identity checks are ~100 lines of pure function, fully unit-tested, and caught a real incident (PR #49 shipped `npm run build` and silently skipped migrations). Cost of keeping: near zero.
- **`ci.yml` App + Database gates.** Format/lint/typecheck/tests/build + migration replay + drift check are the release gate.
- **docker Postgres CI + `wait-for-postgres` + `destructive-db-guard` + `migrate.ts`/`verify-database.ts`/`db:seed`/`db:verify`/`backup`/`restore-drill`.** Local/dev safety tooling — this is "meaningful database safety" the mission asks to preserve.
- **`hosted-smoke.yml`.** 54 lines, manual-only, genuinely useful pre-launch.

### SIMPLIFY (right idea, too much machinery)

- **`neon-preview.yml` + `scripts/neon-preview.ts`** — the heart of the audit. Per-PR preview databases are legitimately valuable for DB-touching PRs, and no native path reproduces "branch from fictional `testing`". But 916+725 lines carry single-dev edge cases that have never fired:
  - **Orphan reconcile (weekly cron + manual-dispatch gate + classification logic)** → replace with **Neon branch TTL** (`expires_at` ≈ creation + 14 days, refreshed on each `synchronize` provision). Deletion then happens even if teardown misfires — no scheduler, no manual-approval dance, ~120 lines of `reconcile` + the whole cron/inputs block gone. Keep teardown for prompt cleanup.
  - **Shared-head-ref collision handling** (`openPrsWithRef`, survive-PR var retention) → drop the GitHub-API lookup; refuse/overwrite with a documented caveat ("one PR per branch"), or keep a minimal name-collision check. Single developer; this has never occurred.
  - **`warnOnPreviewAdminCredentials`** — reads Vercel env var list to warn about preview admin creds. Nice-to-have; fold into docs or keep (it's small).
  - **Triple-layer eligibility (workflow `if` + `gate` step + script `provisioningDecision`)** → keep two: the `if` (cheap, no checkout) and the script check (trusted-code enforcement). The `gate` step is redundant — `provision` re-verifies anyway.
  - Net: `neon-preview.ts` ~916 → ~450 lines; workflow ~245 → ~150 lines.

- **`neon-testing-init.yml` + script** — already run once; `testing` exists. The workflow is still the right rerun path (idempotent), but if simplifying further: document the 3-command manual equivalent (already in `preview-databases.md` §1.4) and delete the workflow+script (~780 lines). Verdict: **SIMPLIFY → REMOVE acceptable**; the manual commands are documented and rarely needed. Recommendation: keep the script, delete nothing this round — revisit after launch.

- **`ci.yml` change-classifier** (~80 lines bash) — saves CI minutes by skipping irrelevant jobs. For a solo repo, App+DB jobs take ~3 min; the classifier's value is modest and it's the most fiddly part of ci.yml (domain regexes, fail-safe paths). Options: (a) keep — it works and is tested by use; (b) simplify to always-run on PRs. Recommendation: **SIMPLIFY optional** — not urgent; the win is deleting maintenance surface, not speed. Defer to whenever it next breaks.

### REMOVE / DEFER candidates

- **`vercel-build-check.yml` + script (~480 lines)** — exists because the Vercel _dashboard_ Build Command can override `vercel.json` silently, and did once (PR #49). Two options:
  - (a) Clear the dashboard override so `vercel.json` is sole authority; then the only remaining risk is someone editing the dashboard — the remote check's reason to exist. Keep the **unit test** that pins `vercel.json` + `package.json` (no secrets).
  - (b) Keep the daily remote check — it's read-only and cheap.
    Verdict: **DEFER/REMOVE-able.** Recommendation: clear the dashboard override, keep the repo-side test, remove the workflow+script — one fewer secret (`VERCEL_TOKEN` consumer) and scheduled job. If uneasy, keep it — cost is low either way. Honest position: it catches exactly one failure mode that a policy decision ("vercel.json is authoritative") eliminates.

### REPLACE — none

No component has a native 1:1 replacement that preserves the fictional-data boundary. The tempting one (managed integration) fails the requirement.

### Deferred judgement

- **Per-PR preview DBs vs one shared `preview` branch.** For a solo dev, a single shared preview DB (project-scoped env vars, zero workflow) would work for most PRs — but competing migration sequences would corrupt it precisely on the DB-heavy PRs where previews matter most. Keep Model A, simplified. Re-evaluate if Neon previews prove flaky.

## 7. Recommended target architecture

```
Open PR → [if: same-repo, non-dependabot, base=main]
  neon-preview.yml :: provision
    ├─ create-branch-action → preview/pr-<n> (parent: testing, expires_at: now+14d)
    └─ slim provision script → write 3 branch-scoped env vars → trigger deploy
  Vercel preview → build:vercel (identity checks) → migrate → build
  ci.yml → App/DB/Infra gates
PR close → teardown (delete branch + env vars)   [TTL covers misses]
Merge → Vercel prod → build:vercel → prod-identity check → migrate → promote
```

Same guarantees, ~40% less infra code, one fewer cron + fewer secrets
touched. The fictional-data model and migrate-before-promote ordering
are untouched.

## 8. Files removable (staged)

**Stage 1 (low risk, do first):**

- `vercel-build-check.yml`, `scripts/vercel-build-check.ts` + test — after clearing the dashboard Build-Command override (owner action).
- `neon-preview.yml` `reconcile` job + cron + `workflow_dispatch` + `reconcile()`/`classifyPreviewBranch` in the script + its tests — after TTL lands in `provision`.

**Stage 2 (medium):**

- Gate step + `provisioningDecision` dedup; `openPrsWithRef` shared-ref logic; shrink `neon-preview.ts` accordingly (~450 lines target).

**Stage 3 (optional, post-launch):**

- `neon-testing-init.yml` + script if the documented manual path proves sufficient.
- `ci.yml` classifier if it becomes a maintenance burden.

## 9. Migration plan (small PRs)

1. **PR-S1:** add `expires_at` (14d) to branch creation + refresh on sync; unit-test the payload. _Owner action:_ none.
2. **PR-S2:** remove reconcile job/cron/dispatch + `reconcile`/`classifyPreviewBranch` + tests; update `preview-databases.md` (TTL is now the safety net).
3. **PR-S3:** clear Vercel dashboard Build Command (owner) → remove `vercel-build-check` workflow/script; keep repo-side pin test.
4. **PR-S4:** collapse gate→provision, drop shared-ref handling, trim script; update docs.
5. **PR-S5 (optional):** remove `neon-testing-init` if manual path acceptable.

Each PR is independently revertible; none touches production data,
secrets, or Neon branch contents.

## 10. Expected maintenance reduction

- Workflow lines: 698 → ~480 (−30%).
- Deploy-infra script lines: ~1,880 → ~1,150 (−40%).
- Scheduled jobs: 2 (reconcile, build-check) → 0.
- Secrets the preview flow needs: unchanged (`NEON_API_KEY`, `VERCEL_TOKEN`); `VERCEL_TOKEN` consumers drop from 2→1 workflows if S3 done.
- Failure surface: no more "reconcile silently fails for weeks", no more dashboard-config drift class (eliminated by policy, not monitoring).

## 11. Risks & testing requirements

- **TTL deletion of an in-use branch** — 14d expiry must be _refreshed_ on every provision call (synchronize), else a long-lived PR loses its DB mid-work. Test: unit-test the expires_at computation; live-verify on one disposable PR.
- **`create-branch-action` may not support expires_at** — verify the action's inputs; if absent, set TTL via one Neon API call inside `provision` (script already talks to the API).
- **Removing build-check** — the protection becomes policy-only. Acceptable iff the dashboard override is cleared AND the repo-side unit test pinning `vercel.json`/`build:vercel` stays.
- **Dropping shared-ref handling** — documented "one PR per git branch" caveat; acceptable solo.
- **Every stage** needs: `npm run check` + `test:db` green; S1–S2 get a disposable-PR live validation (provision, TTL visible in Neon console, teardown on close).

## 12. Bottom line

The infrastructure is well-built but sized for a team and a portfolio
standard. For a solo pre-launch app, the irreducible core is small:

- **Vercel auto-deploys** (native) + **`build:vercel`** (the only
  place migrate-before-promote can live, and the identity checks that
  keep preview/prod databases straight).
- **Neon per-PR branches from `testing`** — the one thing no native
  integration reproduces — trimmed to provision+teardown with TTL as
  the orphan safety net.
- **CI gates** unchanged.

Everything else — scheduled reconciliation, remote build-command
audits, multi-layer gates, shared-ref handling, manual-approval
deletion gates — is defense-in-depth machinery for threats that have
never materialized, maintained at real cost. The staged plan removes
~40% of deploy-infra code and all scheduled jobs while keeping every
guarantee the mission requires.
