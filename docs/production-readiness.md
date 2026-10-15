# Production readiness

The consolidated launch posture for SARbase on Vercel + Neon. This is
the operator's checklist: what is already verified, what must be
activated, and what is honestly still open. It complements — not
replaces — the per-subsystem docs (`docs/*.md`) and the recovery
runbook (`runbooks/database-backup-restore.md`).

Status legend: **verified** (exercised end-to-end), **implemented**
(code landed, not live-tested against the real service), **blocked**
(waiting on an owner action), **not implemented**.

## Readiness matrix

| Area                    | Status            | Notes                                                                                                                                                         |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database lifecycle      | verified          | Neon `testing` baseline + per-PR `preview/pr-N` branches, identity-checked migrations, teardown (PRs #46/#48/#49)                                             |
| Vercel build safeguards | verified          | `npm run build:vercel` identity-gates migrations; misconfigured envs fail the build closed (PR #50)                                                           |
| Firebase authentication | verified (design) | Session cookies verified with revocation; env vars configured prod + preview on shared project; preview sign-in still needs `ALLOW_FIREBASE_ADMIN_IN_PREVIEW` |
| Authorization           | verified          | Org-scoped `OrganizationAccess` checks, composite same-org FKs, opaque cross-org failures                                                                     |
| Application workflows   | implemented       | Incidents/callouts/expenses/assets/documents covered by db + unit + smoke tests; full hosted journeys need the authenticated smoke identity                   |
| Attachment uploads      | implemented       | Direct-to-store prepare → browser POST → verified finalize; proxied fallback for providers without presigned POST                                             |
| Attachment downloads    | verified          | Authorized streaming route, private objects, `attachment`+`nosniff`, honest 404/410                                                                           |
| Object storage          | implemented       | Code complete; bucket + IAM + Vercel vars configured by owner — pending redeploy and live smoke test (see below)                                              |
| Background processing   | not applicable    | No jobs/queues/schedulers exist; notification retries are operator-invoked actions                                                                            |
| External integrations   | implemented       | Resend notifications (fake provider otherwise); Sentry wired, credentials optional                                                                            |
| Monitoring              | partially         | Sentry SDK + structured request logs + `/api/health`; alert policy is an operator decision                                                                    |
| Backup & recovery       | verified (db)     | `runbooks/database-backup-restore.md` + automated restore drill in CI; object-store backup is operator scope                                                  |
| Deployment protection   | verified          | Vercel Deployment Protection stays on; automation uses the bypass header, never a public route                                                                |

## Environment matrix

Set each variable only in the environment named — previews must never
inherit writable production resources.

| Variable                                              | Production                | Preview                                                                                                           | Notes                            |
| ----------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `DATABASE_URL` / `DATABASE_URL_UNPOOLED`              | Neon `main` pooled/direct | `preview/pr-N` (workflow-set)                                                                                     |                                  |
| `APP_PRODUCTION_DB_HOST`                              | production host           | same value — identity check                                                                                       | non-secret hostname              |
| `APP_PREVIEW_DB_HOST`                                 | —                         | `preview/pr-N` host (workflow-set)                                                                                |                                  |
| `APP_TESTING_DB_HOST`                                 | —                         | CI only                                                                                                           |                                  |
| `FIREBASE_ADMIN_*`                                    | `saba-sarbase` (shared)   | shared project **or** dedicated preview project; requires `ALLOW_FIREBASE_ADMIN_IN_PREVIEW=true`                  | SECRET                           |
| `NEXT_PUBLIC_FIREBASE_*`                              | `saba-sarbase` (shared)   | shared or preview project                                                                                         | public by design                 |
| `FILE_STORAGE_PROVIDER`                               | `s3`                      | `s3` **only with** `ALLOW_S3_IN_PREVIEW=true` + preview bucket (otherwise fails closed); unset/`local` uses local | production fails closed if unset |
| `FILE_STORAGE_S3_*`                                   | production bucket/creds   | dedicated preview bucket, never production creds                                                                  | SECRET                           |
| `RESEND_API_KEY` + `NOTIFICATION_EMAIL_FROM`          | real sender               | **preview Resend key/domain only**, requires `ALLOW_RESEND_IN_PREVIEW=true`                                       | SECRET                           |
| `CALLOUT_RESPONSE_TOKEN_SECRET`                       | production pepper         | preview pepper (distinct value)                                                                                   | SECRET                           |
| `SENTRY_DSN` (+ `NEXT_PUBLIC_SENTRY_DSN`)             | real DSN                  | optional; same or preview project                                                                                 | ingest credential                |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | set                       | optional                                                                                                          | sourcemap upload                 |
| `APP_BASE_URL` / `NEXT_PUBLIC_SITE_URL`               | https origin              | https origin                                                                                                      | Secure-cookie gate               |

## Owner activation checklist

Ordered. Items marked _(secret)_ are created in the deployment env —
never committed, never in CI. **Vercel environment changes take effect
on the next deployment only** — a running deployment never sees a
variable added after it was built, so the checklist's final act is
always a redeploy.

1. **Production database** — already live (Neon `main`,
   `APP_PRODUCTION_DB_HOST` configured, build-time identity checks
   verified).
2. **Firebase** — the four `NEXT_PUBLIC_FIREBASE_*` values plus
   `FIREBASE_ADMIN_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`,
   `FIREBASE_ADMIN_PRIVATE_KEY` _(secret)_ are configured on Production
   and Preview against the shared `saba-sarbase` project. For preview
   sign-ins, also set `ALLOW_FIREBASE_ADMIN_IN_PREVIEW=true`
   preview-scoped — without it the Admin SDK refuses to initialize on
   previews and login fails closed (see `docs/authentication.md` for the
   shared-project caveats). Console side: **Email/Password** enabled,
   `sar-base.vercel.app` in _Authorized domains_, and at least one user
   created. After the redeploy, sign in once and run
   `npm run admin:provision` to grant the first org ADMIN.
3. **Notifications** — `RESEND_API_KEY` + `NOTIFICATION_EMAIL_FROM`
   _(secret)_; preview sends need `ALLOW_RESEND_IN_PREVIEW` +
   preview-domain key.
4. **Callout links** — `CALLOUT_RESPONSE_TOKEN_SECRET` _(secret)_.
   Required: `/respond` fails closed without it in production.
5. **Object storage (S3-compatible)** _(secret + infra)_ — the full
   operator runbook, including copy-ready IAM policy, CORS block, and
   lifecycle rule JSON, is the **"AWS S3 activation"** section of
   `docs/attachments.md`. In short: a private bucket, CORS POST from
   the app origin only, a 7-day `staging/` expiry, an IAM credential
   scoped to `staging/*` + `organizations/*` on the one bucket, and the
   five `FILE_STORAGE_S3_*` vars + `FILE_STORAGE_PROVIDER=s3`. With
   `FILE_STORAGE_PROVIDER=local` and an explicit
   `FILE_STORAGE_LOCAL_ROOT`, uploads proxy through the action body
   (Vercel ~4.5 MB cap); an unset provider in production fails closed
   and uploads error rather than falling back silently.
6. **Sentry** _(secret-adjacent)_ — `SENTRY_DSN`,
   `NEXT_PUBLIC_SENTRY_DSN`; `SENTRY_ORG`/`SENTRY_PROJECT`/
   `SENTRY_AUTH_TOKEN` for sourcemap upload.
7. **Hosted smoke tests** (optional) — GitHub secrets
   `VERCEL_AUTOMATION_BYPASS_SECRET`, `SMOKE_TEST_EMAIL`,
   `SMOKE_TEST_PASSWORD`; a test user in the _preview_ Firebase project
   - `admin:provision` grant on the seeded org
     (`docs/hosted-smoke-testing.md`).

## Deployment and rollback

- **Deploy:** merge to `main` → Vercel builds via
  `npm run build:vercel` → identity-checked `migrate deploy` → promote.
  A failed identity check or migration aborts the build; the previous
  deployment keeps serving.
- **Rollback:** Vercel instant-rollback to the prior deployment.
  Migrations are forward-only and additive by convention — roll the
  _application_ back first; a destructive migration would need its own
  reviewed compensating migration, never a `migrate reset` on
  production.
- **Preview teardown:** PR close/merge triggers the neon-preview
  workflow's `Delete preview database` job.

## Failure handling

| Dependency   | Failure behavior                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Postgres     | `/api/health` reports `degraded`/503; requests surface honest errors via `mapDomainError` (no details leaked)            |
| Object store | `StorageError` normalized — credentials/endpoints never cross into logs or responses; finalize cleans staged objects     |
| Firebase     | unconfigured → login shows "not configured", protected surfaces fail closed; revoked sessions invalidate on next request |
| Resend       | notifications record failure; retry is an explicit admin action                                                          |
| Sentry       | absent DSN → SDK inert; builds skip sourcemap upload                                                                     |

## Scheduled work

There are **no** cron jobs, queues, or background loops — nothing to
migrate onto a scheduler for Vercel. Notification retries and restore
drills are operator-invoked. If a scheduled need appears (e.g.
staging-prefix reconciliation beyond the bucket lifecycle rule), it
should arrive as a `workflow_dispatch`/cron workflow — decided then,
not speculated now.

## Known gaps (honest list)

- **Object storage verification** — code complete and the AWS bucket +
  Vercel variables are configured; the running deployment predates them
  (env vars bind at deploy time), so activation requires a redeploy
  followed by the controlled smoke test in `docs/attachments.md` §6.
  Until then the fail-closed resolver errors attachment uploads rather
  than writing to ephemeral local storage.
- **Malware scanning** — none exists anywhere in the pipeline. The
  allowlist + signature checks + `attachment`/`nosniff` are the
  mitigation today; a scanning step belongs at the object-store layer
  (e.g. bucket event → scanner → quarantine) and is a roadmap item,
  not a claim.
- **Authenticated hosted coverage** — infrastructure landed; needs the
  preview Firebase user + provisioned grant to go green.
- **`@grpc/grpc-js` advisory residual** — reachable only via
  `@firebase/firestore`, which SARbase never imports (auth only);
  documented rather than force-downgrading `firebase`.
- **`serverActions.bodySizeLimit: "32mb"`** — applies to the proxied
  Server Action upload path, which remains for local dev and providers
  without presign support. On Vercel that path is still subject to the
  platform's ~4.5 MB function payload limit; direct-to-store uploads
  (the S3 provider's default flow) bypass it entirely.
