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

| Area                    | Status            | Notes                                                                                                                                       |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Database lifecycle      | verified          | Neon `testing` baseline + per-PR `preview/pr-N` branches, identity-checked migrations, teardown (PRs #46/#48/#49)                           |
| Vercel build safeguards | verified          | `npm run build:vercel` identity-gates migrations; misconfigured envs fail the build closed (PR #50)                                         |
| Firebase authentication | verified (design) | Session cookies verified with revocation; preview Admin SDK gated behind `ALLOW_FIREBASE_ADMIN_IN_PREVIEW`                                  |
| Authorization           | verified          | Org-scoped `OrganizationAccess` checks, composite same-org FKs, opaque cross-org failures                                                   |
| Application workflows   | implemented       | Incidents/callouts/expenses/assets/documents covered by db + unit + smoke tests; full hosted journeys need the authenticated smoke identity |
| Attachment uploads      | implemented       | Direct-to-store prepare → browser POST → verified finalize; proxied fallback for providers without presigned POST                           |
| Attachment downloads    | verified          | Authorized streaming route, private objects, `attachment`+`nosniff`, honest 404/410                                                         |
| Object storage          | blocked           | Code complete; requires owner bucket + credentials + CORS + lifecycle rule (see below)                                                      |
| Background processing   | not applicable    | No jobs/queues/schedulers exist; notification retries are operator-invoked actions                                                          |
| External integrations   | implemented       | Resend notifications (fake provider otherwise); Sentry wired, credentials optional                                                          |
| Monitoring              | partially         | Sentry SDK + structured request logs + `/api/health`; alert policy is an operator decision                                                  |
| Backup & recovery       | verified (db)     | `runbooks/database-backup-restore.md` + automated restore drill in CI; object-store backup is operator scope                                |
| Deployment protection   | verified          | Vercel Deployment Protection stays on; automation uses the bypass header, never a public route                                              |

## Environment matrix

Set each variable only in the environment named — previews must never
inherit writable production resources.

| Variable                                              | Production                | Preview                                                                      | Notes                            |
| ----------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------- | -------------------------------- |
| `DATABASE_URL` / `DATABASE_URL_UNPOOLED`              | Neon `main` pooled/direct | `preview/pr-N` (workflow-set)                                                |                                  |
| `APP_PRODUCTION_DB_HOST`                              | production host           | same value — identity check                                                  | non-secret hostname              |
| `APP_PREVIEW_DB_HOST`                                 | —                         | `preview/pr-N` host (workflow-set)                                           |                                  |
| `APP_TESTING_DB_HOST`                                 | —                         | CI only                                                                      |                                  |
| `FIREBASE_ADMIN_*`                                    | production project        | **preview project only**, requires `ALLOW_FIREBASE_ADMIN_IN_PREVIEW=true`    | SECRET                           |
| `NEXT_PUBLIC_FIREBASE_*`                              | production project        | preview project                                                              | public by design                 |
| `FILE_STORAGE_PROVIDER`                               | `s3`                      | `s3` **only with** `ALLOW_S3_IN_PREVIEW=true` + preview bucket, else `local` | production fails closed if unset |
| `FILE_STORAGE_S3_*`                                   | production bucket/creds   | dedicated preview bucket, never production creds                             | SECRET                           |
| `RESEND_API_KEY` + `NOTIFICATION_EMAIL_FROM`          | real sender               | **preview Resend key/domain only**, requires `ALLOW_RESEND_IN_PREVIEW=true`  | SECRET                           |
| `CALLOUT_RESPONSE_TOKEN_SECRET`                       | production pepper         | preview pepper (distinct value)                                              | SECRET                           |
| `SENTRY_DSN` (+ `NEXT_PUBLIC_SENTRY_DSN`)             | real DSN                  | optional; same or preview project                                            | ingest credential                |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | set                       | optional                                                                     | sourcemap upload                 |
| `APP_BASE_URL` / `NEXT_PUBLIC_SITE_URL`               | https origin              | https origin                                                                 | Secure-cookie gate               |

## Owner activation checklist

Ordered. Items marked _(secret)_ are created in the deployment env —
never committed, never in CI.

1. **Production database** — already live (Neon `main`,
   `APP_PRODUCTION_DB_HOST` configured, build-time identity checks
   verified).
2. **Firebase** — production project env vars set; a _separate_ preview
   project for previews if preview sign-ins matter.
3. **Notifications** — `RESEND_API_KEY` + `NOTIFICATION_EMAIL_FROM`
   _(secret)_; preview sends need `ALLOW_RESEND_IN_PREVIEW` +
   preview-domain key.
4. **Callout links** — `CALLOUT_RESPONSE_TOKEN_SECRET` _(secret)_.
   Required: `/respond` fails closed without it in production.
5. **Object storage (S3-compatible)** _(secret + infra)_:
   - Create a **private** bucket (AWS S3, Cloudflare R2, or MinIO).
   - CORS: allow `POST` from the app origin only (`docs/attachments.md`
     has the exact block).
   - Lifecycle rule: expire the `staging/` prefix (suggested 7 days) —
     abandoned direct uploads self-clean.
   - IAM credential scoped to the one bucket: `s3:GetObject`,
     `s3:PutObject`, `s3:DeleteObject` on `staging/*` and
     `organizations/*` (see the minimal-IAM section of
     `docs/attachments.md`).
   - Set `FILE_STORAGE_PROVIDER=s3` + the five `FILE_STORAGE_S3_*`
     vars. Uploads then flow direct-to-store; without this the deploy
     keeps working but large uploads proxy through the action body.
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

- **Object storage credentials** — code complete; the app still uses
  the proxied upload path until the owner activates a bucket.
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
