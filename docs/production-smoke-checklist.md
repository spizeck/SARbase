# Manual production smoke-test checklist

A short, human-run verification pass for a deployed environment. Most
steps are **safe against production** because they use real records in
the operator's own organization and touch no external provider; the few
steps that can send email or write to object storage are marked and
should run against a **preview deployment** (see
`hosted-smoke-testing.md` for preview-safe credentials and secrets).

Automated coverage already exists for the domain layer (attachment
auth/lifecycle, notification idempotency and replay) and the download
route's HTTP mapping (`route.test.ts`). This checklist is for what
automation cannot see: real provider configuration, real cookies, and
the first minutes of a new deployment.

## 1. Authentication and authorization

- [ ] Sign in at `/login` as an org admin; the session lands on the
      organization workspace (`/org` → the organization's dashboard).
- [ ] Open an incognito window → `/admin` redirects to `/login`;
      `GET /api/attachments/<any-id>/download` returns `401`.
- [ ] With an account that has access to a second organization (or a
      foreign attachment id fabricated), request the download URL for an
      attachment outside your scope → `404`, identical to a nonexistent
      id. No existence disclosure.

## 2. Documents and object storage

_Provider-touching — run against a preview deployment with a dedicated
preview bucket (`ALLOW_S3_IN_PREVIEW=true`). Never production storage._

- [ ] On an asset or incident, attach a small file via the direct-to-
      store upload flow; the record appears under the entity's files.
- [ ] Download it back — the file bytes match and the response is a
      forced download (`Content-Disposition: attachment`), never an
      inline render or a public/signed URL.
- [ ] Tombstone the file (delete action), then hit the same download
      URL → `404`.
- [ ] On a deployment intentionally lacking `S3_*` env (e.g. a preview
      without `ALLOW_S3_IN_PREVIEW`), attempt a download → `503` with
      the "storage not configured" message; the admin UI explains the
      gap rather than crashing.
- [ ] Confirm no attachment URL ever returns a public S3/presigned link
      — all bytes flow through `/api/attachments/.../download` after
      the authorization check.

## 3. Notifications (Resend)

_One controlled send is acceptable against production only if the
organization explicitly opts into a test notification to the operator's
own address; otherwise use preview + a preview Resend key._

- [ ] Notifications page → send a test notification to your own member
      record → delivered (check inbox + Resend dashboard) and the
      request/attempt rows show `DELIVERED`/`ACCEPTED`.
- [ ] Submit the same test twice quickly (double-click / retry) → one
      provider send; the idempotency key replays rather than
      duplicating (attempt count stays sane in the admin list).
- [ ] With Resend intentionally misconfigured in a preview (bad/absent
      key), request a notification → the request row records a `FAILED`
      attempt with a safe error, and the retry action is offered — no
      unhandled error, no half-written state.
- [ ] A member with email notifications disabled records the send as
      `SUPPRESSED` rather than attempting delivery.

## 4. Preview-environment safety

- [ ] Confirm the preview uses the preview Firebase project
      (`ALLOW_FIREBASE_ADMIN_IN_PREVIEW`), a preview database branch,
      and `ALLOW_S3_IN_PREVIEW` — never the production project, bucket,
      or Resend account.
- [ ] Preview sign-in works end-to-end; production credentials are
      absent from the preview's environment.
- [ ] `npm run test:e2e:hosted` against the preview passes (anonymous
      specs at minimum; authenticated specs when smoke creds exist).

## 5. New-organization setup (from PR: org setup checklist)

- [ ] Fresh organization → checklist shows on the admin page with
      settings/members/assets/locations plus optional units/vendors/
      qualifications; each item links to the right place.
- [ ] "Hide checklist" dismisses it; it reappears via "Show setup
      checklist"; it disappears entirely once every item is done.
- [ ] Asset form with zero locations/vendors explains and links to
      creation in a new tab; submitted a duplicate name/tag/serial
      shows the advisory warning and requires the confirmation
      checkbox; search and category filters find records.

## If something fails

- 4xx auth/not-found issues → check the grant rows
  (`OrganizationAccess`), the session cookie, and that the id really
  belongs to the caller's organization.
- 503 storage → the deployment's `S3_*` variables (or the preview's
  `ALLOW_S3_IN_PREVIEW` flag) are missing; check Vercel env per
  environment, not just Production.
- Notification failures → attempt rows carry the provider's safe
  error; check `RESEND_API_KEY` and the `notifications` runbook in
  `docs/notifications.md`.
- Correlate any API failure with `x-request-id` from the response
  headers/body in the deployment logs.
