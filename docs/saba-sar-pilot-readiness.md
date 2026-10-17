# Saba SAR pilot readiness

One document for everything between "code merged" and "Saba SAR uses
SARbase for real". Written for the owner — every step says what to do,
what proves it worked, and what to do if it doesn't. No coding required.

Companion docs: [production-readiness.md](production-readiness.md)
(system-level posture), [whatsapp-production-activation.md](whatsapp-production-activation.md)
(detailed Meta procedure), [whatsapp-templates.md](whatsapp-templates.md),
[../runbooks/guardduty-scan-activation.md](../runbooks/guardduty-scan-activation.md),
[hosted-smoke-testing.md](hosted-smoke-testing.md).

## Current deployment state (verified 2026-10-17)

| Fact                     | State                                                                 |
| ------------------------ | --------------------------------------------------------------------- |
| Production deployment    | `sar-base` on Vercel — READY, running main `fe2f61a`                  |
| Database                 | Neon `main` — all 36 committed migrations applied by the build        |
| Rollback                 | Vercel instant-rollback to prior deployment (migrations are additive) |
| Email notifications      | Implemented; real sending needs Resend env vars                       |
| WhatsApp notifications   | Implemented, **inactive** until Meta activation                       |
| File attachments         | Implemented, **fail-closed** until S3 env vars activate               |
| Malware scanning         | Implemented, **unverified live** until GuardDuty activation           |

## Required environment variables — names only

Set in Vercel → Project Settings → Environment Variables. **Values are
never committed to git and never pasted into tickets or chat.**

Already required for the app to serve at all:

- `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `APP_PRODUCTION_DB_HOST`
- `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`,
  `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`
- `FIREBASE_ADMIN_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`,
  `FIREBASE_ADMIN_PRIVATE_KEY`
- `APP_BASE_URL` / `NEXT_PUBLIC_SITE_URL`

Needed for pilot features:

- `RESEND_API_KEY`, `NOTIFICATION_EMAIL_FROM` — email notifications
- `CALLOUT_RESPONSE_TOKEN_SECRET` — response links **fail closed
  without this**
- `FILE_STORAGE_PROVIDER=s3` + `FILE_STORAGE_S3_*` (five vars) —
  attachments
- `MALWARE_SCAN_WEBHOOK_TOKEN`, `MALWARE_SCAN_AWS_ACCOUNT_ID` —
  scan-result webhook
- `WHATSAPP_PROVIDER`, `WHATSAPP_ACCESS_TOKEN`,
  `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION`,
  `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` — WhatsApp
  (six vars; leave unset = channel stays off, which is safe)
- `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` (optional; plus
  `SENTRY_ORG`/`SENTRY_PROJECT`/`SENTRY_AUTH_TOKEN` for sourcemaps)

**Vercel rule:** env changes apply only to deployments built _after_
the change. Setting a variable never updates a running deployment —
the last step of every env change is a redeploy.

## GuardDuty activation checklist (owner + AWS console)

Separates what is verified automatically from what needs live testing.

**Automated (read-only, run locally with your AWS credentials):**

```sh
npx tsx scripts/guardduty-verify.ts \
  --region <bucket region> \
  --bucket <production bucket name> \
  --env prod \
  --endpoint https://<production domain>/api/internal/guardduty-scan-result
```

This checks — without changing anything: bucket versioning, the
GuardDuty protection plan, the EventBridge rule + pattern, rule
targets/invoke role/DLQ/retry policy, the API destination, the webhook
connection, an empty DLQ, and the CloudWatch alarm. Every check reports
PASS / FAIL / MANUAL / cannot-verify. Exit code 0 = fully wired.

**Live verification (after the script passes):**

1. Clean-file test — upload a small ordinary file through SARbase. The
   attachment should become downloadable once the scan event arrives
   (usually under a few minutes). If it stays blocked, check the DLQ
   and the webhook delivery in AWS console.
2. Controlled threat test — upload the EICAR test string as a file.
   GuardDuty must mark it malicious; the attachment must stay blocked
   permanently. **Do this once, with a throwaway attachment record, and
   tell no members it is real.**
3. Confirm zero messages in the DLQ after both tests, and that the
   CloudWatch alarm did not fire.

Exact procedure:
`runbooks/guardduty-scan-activation.md` (Phases 0–5).

## WhatsApp activation checklist (owner + Meta console)

Full procedure: `docs/whatsapp-production-activation.md`. Summary:

1. Meta Business Portfolio for Saba SAR → create WABA → record WABA ID.
2. Add a **dedicated** sender number (do not reuse an existing
   community WhatsApp number) → record **phone number ID** (numeric).
3. System user + access token scoped to the WABA.
4. Register the proposed templates (`docs/whatsapp-templates.md`) —
   **unapproved until Meta accepts them.** The pilot needs at minimum
   `sarbase_callout_alert` and `sarbase_callout_cancellation`
   (UTILITY category). Sends against unapproved templates fail safely.
5. Set the six `WHATSAPP_*` env vars in Vercel, redeploy.
6. Configure the webhook: callback URL
   `https://<domain>/api/webhooks/whatsapp`, verify token =
   `WHATSAPP_WEBHOOK_VERIFY_TOKEN` value, subscribe to `messages`.
7. Controlled smoke test: one test member → callout in a test
   organization → confirm send, `NotificationDeliveryEvent` rows, and a
   real reply recording a response.
8. Members opt in individually — a member who has not granted WhatsApp
   consent simply doesn't get WhatsApp sends (recorded as
   `consent_missing`, never an error).

To switch WhatsApp off at any time: unset `WHATSAPP_PROVIDER` (or set
it to `fake`) and redeploy. The channel disables cleanly; nothing else
is affected.

## Administrator acceptance checklist

Verify on the production site after activation:

- [ ] Sign in; land on the organization dashboard — attention sections
      show open callouts, defects, expiring qualifications.
- [ ] Invite a member; they receive the invitation email (or check the
      admin notifications page for delivery status).
- [ ] Assign a MANAGER role with one capability; confirm that account
      can do that one thing and nothing else.
- [ ] Availability board shows every member's stated status; UNKNOWN
      shows as "no current statement", not "unavailable".
- [ ] Create a callout, invite members, watch notification status —
      ACCEPTED/DELIVERED are provider facts; responses are separate.
- [ ] Create an incident from the callout; add personnel, an asset, a
      note; review the timeline.
- [ ] Upload an attachment; confirm it downloads only after a clean
      scan (attachments stay blocked while scan is pending — correct,
      not broken).
- [ ] Close the callout, then edit its title; the change history shows
      before/after with your name and timestamp.
- [ ] Export a report; confirm it contains only this organization's
      data.

## Manager acceptance checklist

- [ ] Sign in; you see only the workspaces your capabilities allow.
- [ ] Perform your granted operation (e.g. record training attendance).
- [ ] Attempt something you were not granted (e.g. member
      administration) — you get a not-found page, not a hint the page
      exists.
- [ ] Ask an admin to revoke your capability; your next attempt at the
      operation is denied immediately — no sign-out needed.

## Member acceptance checklist (phone recommended)

- [ ] Sign in on your phone; your dashboard shows your own availability
      and any stale-statement prompt.
- [ ] Update availability; your statement appears with the time.
- [ ] Open a callout response link from a test notification on your
      phone; two large buttons; your response saves and you can change
      it while the callout is open.
- [ ] View your training attendance and qualifications; submit a
      qualification correction.
- [ ] You cannot reach any admin page — an admin URL shows not-found.

## Simulated callout drill

Run before going live, using a **test organization and test member
records only**. The automated version of this drill runs in CI
(`src/lib/domain/operational-drill.db.test.ts`) — what follows is the
human version in the app:

1. Create three test members with different availability statements
   (one available, one unavailable, one silent).
2. Create a callout inviting all three. Verify notification status per
   invitee.
3. Have two test members respond (one COMING, one UNAVAILABLE).
4. Confirm the coordinator view shows one outstanding invitation —
   "delivered" never counts as a response.
5. Create the incident from the callout; add a member, an asset, and a
   note.
6. Close the callout. Edit the callout title; confirm the change
   history preserves the original.
7. Delete nothing — test records stay out of reporting only if the
   org/members were clearly test-named; clean up via a fresh test org
   next time.

## Known limitations

- No offline mode — a dropped connection during response shows the
  browser's error; reopen the link and respond again (responses are
  idempotent; double-tapping is safe).
- Availability expires into UNKNOWN — the system never infers someone
  is available from an old statement.
- Qualification and maintenance records are facts, not judgements —
  SARbase never says a person or asset is "ready" or "safe".
- Attachments stay blocked until a clean scan; a scanner outage means
  attachments pause, not open.
- Notification delivery shows what Meta/Resend reported — it cannot
  prove a human read or acknowledged anything.

## Incident response and troubleshooting

| Symptom                          | Check first                                                        |
| -------------------------------- | ------------------------------------------------------------------ |
| Callout notifications not sent   | Admin notifications page → delivery status → `statusReason`        |
| WhatsApp sends `consent_missing` | Member must opt in themselves — admins cannot grant consent        |
| Attachment won't download        | Scan pending/quarantined — expected until a CLEAN verdict          |
| Login loops / kicked out         | Firebase session revoked or expired — sign in again                |
| 503 on a page                    | `/api/health` → database degraded; check Neon status               |
| Webhook delivery failures        | GuardDuty DLQ + alarm — replay from SQS after fixing the cause     |
| Response link "isn't valid"      | Token rotated (`CALLOUT_RESPONSE_TOKEN_SECRET` changed) or expired |

## Rollback / disable procedures

- **App rollback:** Vercel → Deployments → instant-rollback. Database
  migrations are additive — the old release keeps working.
- **Disable WhatsApp:** unset `WHATSAPP_PROVIDER`, redeploy.
- **Disable attachments:** unset `FILE_STORAGE_PROVIDER` — uploads fail
  closed rather than writing somewhere unsafe.
- **Disable callout links:** rotate `CALLOUT_RESPONSE_TOKEN_SECRET` —
  all outstanding links invalidate at once.
- **Disable a member:** revoke org access — the next request is denied;
  their records and audit history are preserved.

## Go / no-go criteria

**GO** when all are true:

1. Production deploy READY on the intended commit; migrations applied.
2. Admin/manager/member acceptance checklists pass on the live site.
3. Email notifications verified end-to-end (invite or test send).
4. GuardDuty verify script all-PASS **plus** clean-file and EICAR
   tests observed (if attachments are in pilot scope).
5. WhatsApp smoke test observed (if WhatsApp is in pilot scope) — or
   the channel stays off and callouts go by email.
6. At least two people besides the owner can sign in with working
   roles.
7. The incident-response table above is understood by the duty
   coordinator.

**NO-GO** if any of: env validation errors at boot, database
unreachable, members cannot respond to a test callout, or attachments
download without a clean scan.
