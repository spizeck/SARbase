# Callouts and volunteer responses (issue #14)

A **callout** is a durable record that an organization invited a
materialized set of members to respond to a request for help, plus each
invitee's factual response. This document covers the data model,
activation and notification dispatch, the token-gated response flow,
and the deliberate boundaries.

> SARbase records who was invited and how they responded. It does not
> determine whether the resulting crew is sufficient, qualified, ready,
> or appropriate for an operation.

A callout is **not** an incident record and **not** a dispatch decision.
There is no minimum-crew logic, no qualification inference, no
availability-based invitee filtering, no readiness indicator, and no
launch/go-no-go state anywhere in this feature.

## Data model

### `Callout` — the activation record

One row per activation: `organizationId`, `createdByAuthIdentityId`
(plain scalar — audit attribution survives identity deletion),
`audience` (`ORGANIZATION` / `UNIT` / `MEMBERS`), `unitId` (snapshot for
`UNIT` audiences), `title`, bounded `message` (the initial information
emailed to invitees), `activationKey`, `intentHash`, `status`
(`ACTIVE` / `CLOSED`), `activatedAt`, `closedAt`,
`closedByAuthIdentityId`.

`@@unique([organizationId, activationKey])` provides durable
application-level idempotency, same contract as `Notification`: a key
replayed with the same `intentHash` returns the existing callout and
resumes any undispatched invitations; the same key with different intent
throws `CalloutIdempotencyConflictError`. The admin form generates a
fresh UUID per render, so a double-click or browser resubmit replays
instead of duplicating. Concurrent duplicate activations race the unique
index — the loser re-reads and applies the same replay/conflict
semantics.

### `CalloutInvitation` — the materialized audience

One row per invited member, created in the same transaction as the
callout: `memberId`, `notificationId` (nullable — see dispatch below),
`responseTokenHash`, `invitedAt`, current `response` +
`respondedAt`.

The invited set is **snapshotted at activation**. Unit membership or
member roster changes after activation never rewrite who was invited —
the rows are the history. `@@unique([calloutId, memberId])` dedupes
overlapping inputs.

Two facts are deliberately separate on this row:

- **Invitation** — this member was invited (always true once the row
  exists).
- **Notification** — `notificationId` links the notification request
  SARbase sent about it, whose `status` is the provider-facing fact
  (`ACCEPTED`, `SUPPRESSED`, `FAILED`, …). An invitation with no
  notification row means dispatch never completed — visible as "No
  notification recorded" on the admin surface, and resumable by
  replaying the activation.

### `CalloutResponseChange` — append-only response history

Every meaningful response change appends a row: `previousResponse`
(null for the first), `response`, `source` (`TOKEN_LINK` / `ACCOUNT` /
`ADMIN`), `actorAuthIdentityId` (scalar; null for token responses — the
invitation token itself establishes who responded), optional admin
`note`, `createdAt`. The invitation's `response`/`respondedAt` is the
current-state projection for fast reads; the change rows preserve the
full timeline. Both are written in one transaction so they can never
diverge.

## Activation flow

1. The admin selects an audience and submits once.
2. `activateCallout` resolves the audience to ACTIVE members of the
   callout's organization — org-wide, one unit's members, or explicit
   member ids. Every selector id is validated against the record's own
   organization; foreign ids fail opaquely. INACTIVE member records are
   never invited. **Availability and qualifications are never
   consulted** — they are context, not a filter.
3. Callout + invitation rows commit in one transaction (with one
   minted token _hash_ per invitee).
4. After commit — never inside the transaction — one notification per
   invitation is requested through `requestNotification` (issue #13)
   with the deterministic key
   `callout:{calloutId}:invitation:{invitationId}:email` and template
   `callout_invitation`. Member email preferences apply unchanged:
   preference off or no email → the notification is `SUPPRESSED`, the
   invitation stands, and the coordinator sees both facts.
5. Per-invitation dispatch failures are caught and logged — a callout
   never disappears because one send failed. Replaying the activation
   (same key) resumes invitations that have no notification row.

A resumed or concurrent dispatch claims the invitation's send by
rotating `responseTokenHash` and stamping `dispatchClaimedAt` in one
compare-and-swap (guarded on the previously-read hash,
`notificationId IS NULL`, and no live claim). A second dispatcher sees
the fresh claim and stops — it cannot rotate an in-flight token; a
claim stale beyond `DISPATCH_CLAIM_STALE_MS` (10 minutes) is
reclaimable so a crashed dispatcher stays resumable. Whenever a
Notification row already exists under the deterministic key, the
invitation is linked AND its hash repaired to match the token carried
by that row's stored email — so the stored hash always equals the
emailed credential, under every crash/reclaim ordering. On dispatch
failure the claim is released so a replay can retry immediately.

## The response token

- `mintInvitationToken()` draws 32 bytes from `crypto.randomBytes`
  (256-bit, base64url — 43 characters).
- The raw token appears in the emailed link `GET /respond?t=<token>`.
  The invitation row stores `responseTokenHash = SHA-256(token)` with a
  unique index; `GET /respond` resolves the hash. The value is invalid
  for any other invitation, contains no member or organization data,
  and is never logged.
- The delivered email body — including the link — is also persisted on
  the `Notification` row (`bodyText`), per the notification
  foundation's honest send-record design: retries replay the exact
  stored body. The token therefore also lives inside that org-scoped
  record, the member's mailbox, and the provider copy — the same
  exposure any emailed credential carries. Closing the callout revokes
  every link, bounding that exposure to the callout's active window.
- The page is `noindex`, and Sentry/privacy scrubbing drops query
  strings — the token never reaches telemetry.
- Lifetime is tied to the callout: a token responds while the callout is
  `ACTIVE`; once closed, the link still renders the member's own record
  but refuses new responses. There is no invented operational deadline.

## Responses

Two factual states: `COMING`, `UNAVAILABLE`. Absence of a response is a
NULL `response` — "no response" is derived for display, never stored.

Three sources record through the same write path,
`recordInvitationResponse`:

- `TOKEN_LINK` — the emailed link (`/respond`), no sign-in required.
- `ACCOUNT` — the member's own authenticated `/account` surface, only
  for invitations whose memberId is one of their linked member records
  in an organization where they hold `OrganizationAccess`.
- `ADMIN` — recorded by an organization administrator (e.g. the member
  phoned the duty officer). `actorAuthIdentityId` is the acting admin's
  server-derived identity, so an admin entry never masquerades as a
  member's own response.

Concurrency: the write transaction takes `SELECT … FOR UPDATE` on the
callout row, serializing all responses — and the close transition — for
that callout. Under the lock: a closed callout refuses
(`CalloutClosedError`), an identical response returns idempotently (no
history noise on double-clicks), and a changed response updates current
state + appends history atomically. Conflicting concurrent responses
serialize into a consistent chain: each change's `previousResponse`
equals the prior row's `response`, and the last recorded change always
equals the stored current state.

## Close

`closeCallout` is an explicit admin act — never inferred from counts or
time. It holds the same callout row lock, sets `status = CLOSED` with
`closedAt`/`closedByAuthIdentityId`, and is idempotent (closing a closed
callout is a no-op). History remains fully readable; tokens stop
accepting responses; no notifications are sent on close.

## Authorization and rate limiting

- Admin callout management requires an `ADMIN` grant for the callout's
  **record-derived** organization — `requireOrgAdminForCallout` /
  `requireOrgAdminForCalloutInvitation` treat the supplied id as an
  untrusted selector and deny opaquely.
- The token route's only credential is the token itself; it exposes
  exactly one invitation — the member's name, the callout's
  title/message, and their own response. No other invitees, no counts,
  no organization internals.
- Token submissions are rate-limited (30/min fixed window) on a hashed
  key of `token hash + client IP` — the raw token never enters the
  limiter or logs. Admin activation is rate-limited per org + actor. The
  bundled in-memory store is per-process best-effort; a shared
  Redis/Upstash store would be needed for authoritative multi-instance
  enforcement (see `src/lib/rate-limit/rate-limit.ts`).

## What a callout is not

- Not linked to incidents — a callout may later reference an incident
  record, but callouts are invitations, not the incident workflow
  (#15).
- Not a staffing computation — invitation lists and response counts are
  displayed facts; "enough crew", "ready", and "dispatch" are human
  decisions the software stays out of.
- No reminders, escalation, timers, or operational follow-ups (all
  deferred).
