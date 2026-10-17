# Production incident response

Who responds to what, and where to look first. For a controlled pilot
there is one responder: the **operator** (the person with Vercel, Neon,
and AWS console access). SARbase itself is fail-closed — most failures
degrade a feature rather than corrupt data.

All diagnostics start from structured logs: Vercel → the deployment →
Logs. Every line is one JSON object; filter on `event`, `outcome`
(`unexpected_failure` is the alert-worthy value), `subsystem`, and
`requestId`. Error messages, stacks, PII, and secrets are never logged
by design — `errorName`/`errorCode`/`errorDigest` plus Sentry carry the
debugging detail.

## Failure matrix

| Failure                                   | User-visible symptom                                               | First place to look                                                                                                                  | Usual cause / fix                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deployment fails**                      | Previous deployment keeps serving; no user impact                  | Vercel build log — `build:vercel` aborts on failed DB identity check or failed `migrate deploy`                                      | Wrong `APP_PRODUCTION_DB_HOST`, or a migration that can't apply. Fix env or the migration; never force a deploy over a failed migration                                                                                                                                                       |
| **Database connectivity**                 | `/api/health` returns `degraded`/503; users see honest error pages | Vercel function logs (`subsystem: db`), Neon console → branch status                                                                 | Neon outage or exhausted pool. Check Neon status page; pooled vs direct URL mismatch                                                                                                                                                                                                          |
| **Attachment scan stuck PENDING**         | Download blocked with "Scanning for malware"                       | `npm run attachments:guardduty-verify` — checks rule, destination, DLQ, alarm end-to-end                                             | EventBridge delivery broken or DLQ accumulating. See `runbooks/guardduty-scan-activation.md` Phase 5                                                                                                                                                                                          |
| **GuardDuty delivery fails**              | Scan events never reach the app                                    | SQS DLQ (`sarbase-prod-guardduty-scan-dlq`) message count + CloudWatch alarm `sarbase-prod-guardduty-scan-dlq`                       | Webhook token mismatch (`MALWARE_SCAN_WEBHOOK_TOKEN` vs connection secret) or endpoint 404 after a deploy. **Fix the delivery fault first** — replayed events land back in the DLQ while the fault persists — then re-send the parked events. Downloads stay blocked either way (fail-closed) |
| **Email delivery fails**                  | Invitation/notification marked failed in admin history             | `/admin/organizations/{orgId}/notifications` attempt history — `NotificationAttempt` rows carry provider status + safe error summary | Resend key/domain issue. Retry is an explicit admin action — nothing auto-retries                                                                                                                                                                                                             |
| **Sign-in fails for everyone**            | Login page error or immediate sign-out                             | Vercel logs `subsystem: auth`; Firebase console → project status                                                                     | `FIREBASE_ADMIN_*` misconfigured (fails closed) or Firebase outage. Revoked sessions invalidate on next request — that's expected behavior, not a bug                                                                                                                                         |
| **Invitation link fails**                 | Invitee sees invalid/expired link                                  | Member detail → invitation history (`MemberInvitationEvent`)                                                                         | Expired, revoked, or superseded by a resend — all honest states; send a fresh invitation                                                                                                                                                                                                      |
| **Sentry silent**                         | No error events arriving                                           | Build log — sourcemap upload warnings; `SENTRY_DSN` set in Vercel env                                                                | DSN unset (SDK is inert by design) or the project is throttled. Sentry is optional — logging still works                                                                                                                                                                                      |
| **Rate limiting blocks a real user**      | "Too many …" error on a legitimate action                          | `RateLimitWindow` table row for the opaque key; logs `*.rate_limited` events                                                         | Real burst (wait for window) or shared-IP collision. Keys are hashed — correlate via the `rate_limited` log event's scope                                                                                                                                                                     |
| **User sees 404 on a record they expect** | "Not found"                                                        | Confirm the user's `OrganizationAccess` role + capability set on the Access page                                                     | Almost always correct authorization — cross-org and missing-capability lookups are deliberately indistinguishable from nonexistent                                                                                                                                                            |

## Escalation and rollback

- **Application regression:** Vercel instant-rollback to the previous
  deployment. Migrations are forward-only — roll the app back first;
  only a destructive migration needs a reviewed compensating migration
  (see `runbooks/database-backup-restore.md` § rollback).
- **Data loss or corruption:** stop, snapshot the Neon branch, follow
  `runbooks/database-backup-restore.md`. Do not improvise a restore.
- **Suspected security issue** (credential leak, unexpected access):
  revoke the affected credential first, then investigate with the audit
  tables (`MemberInvitationEvent`, `DataExportEvent`,
  `AttachmentScanEvent`, domain `*Change` histories) before touching
  code.

## What NOT to do

- Never disable the malware-scan gate, authorization checks, or the
  destructive-database guard to "get a user unblocked" — each failure
  has an honest cause; unblocking means fixing the cause.
- Never paste tokens, session cookies, member PII, or raw provider
  payloads into logs, tickets, or chat — and treat log lines and
  Sentry events themselves as sensitive: they can carry record ids,
  actor ids, and error context that an outsider should not see. Logs
  are already scrubbed at write time; keep it that way when copying
  output around.
