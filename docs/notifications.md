# Notifications (issue #13)

The notification foundation is communication infrastructure: a provider-neutral
abstraction, one real email provider (Resend), a deterministic test provider,
and durable records of every request and provider attempt.

> SARbase records and delivers communication requests. Delivery state is a
> factual record and is not an operational readiness or response conclusion.

Nothing in this layer decides who should respond, whether a crew is
sufficient, whether a vessel is ready, whether a launch should occur, or
whether a callout should escalate. It exists so future features (callouts,
reminders) can ask SARbase to send a message without knowing provider
details — and so the organization has an honest audit trail of what was
requested and what the provider reported.

## The five-layer separation

```
application intent → Notification request → provider dispatch →
provider result → persistent audit record
```

| Layer                | Code                                                                     |
| -------------------- | ------------------------------------------------------------------------ |
| Application intent   | Callers of `requestNotification` (admin test send today; callouts later) |
| Notification request | `Notification` row — idempotent, org-scoped, destination snapshot        |
| Provider dispatch    | `NotificationProvider.send` (`src/lib/notifications/provider.ts`)        |
| Provider result      | `ProviderSendResult` — normalized `accepted` / `failed` + code           |
| Audit record         | `Notification` + append-only `NotificationAttempt` rows                  |

Domain code (`src/lib/domain/notifications.ts`) never sees provider SDK
types; adapters (`src/lib/notifications/*.ts`) never see Prisma types.

## Data model

### `Notification` — the durable request

One row per logical send. `organizationId`, optional `memberId` (composite
same-org FK), `channel` (`EMAIL`), `template`, `subject`/`bodyText`
(stored so retries replay the _exact_ message — a request whose content
cannot be reproduced cannot be retried deterministically), `destination`
snapshot, `metadata` (small structured ids/codes only — never bodies or
PII by contract), `idempotencyKey`, `intentHash`, `status`,
`statusReason`, `requestedByAuthIdentityId`, timestamps.

`requestedByAuthIdentityId` is a deliberately plain scalar (the issue #12
actor-attribution policy): history outlives identity deletion; display
resolves best-effort with a raw-id fallback.

### `NotificationAttempt` — append-only provider invocations

One row per provider call: `attemptNumber` (unique per notification),
`provider` name string, `status`, `providerMessageId`, safe `errorCode` /
`errorSummary`, `retryable`, `attemptedAt`, `resolvedAt`. Attempts are
never updated to change history — only resolved after the provider call
returns — and never deleted (`Restrict` on both FKs).

### Statuses — facts, not conclusions

| `Notification.status` | Meaning                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `PENDING`             | Recorded; dispatch in flight or an attempt's outcome unknown.                                                             |
| `SUPPRESSED`          | Never dispatched; `statusReason` says why (`preference_disabled`, `destination_missing`). Not a failure.                  |
| `ACCEPTED`            | The provider accepted the message. **Not** proof of delivery — delivery confirmation needs a provider webhook (deferred). |
| `FAILED`              | Dispatched and not accepted; the last attempt carries the classification.                                                 |

Attempt statuses: `DISPATCHING` (written before the provider call;
permanently DISPATCHING honestly means "invoked, outcome never
recorded"), `ACCEPTED`, `FAILED`.

## Member preferences and destination snapshots

A member-targeted request checks `MemberNotificationPreference` at
request-creation time:

- `notifyEmail = true` + `Member.email` present → dispatched to a snapshot
  of that address.
- Preference off or absent → `SUPPRESSED` / `preference_disabled`, and the
  provider is never invoked.
- Preference on but `Member.email` missing → `SUPPRESSED` /
  `destination_missing`. (The write path normally prevents this
  combination; the check remains because rows can drift.)

The `destination` column is a **snapshot**: if the member changes their
email the next day, history still shows the address actually used. The
snapshot is a historical fact, never an authorization input. A request
with no `memberId` (direct administrative send) has no member preference
to check.

## Idempotency

- `(organizationId, idempotencyKey)` is a database unique constraint —
  durable, not in-memory, not provider-dependent.
- `intentHash` is a sha256 of the canonical intent (channel, member,
  destination, template, subject, body, metadata — order-insensitive).
- Same key + same intent → the existing row is returned
  (`deduplicated: true`), no second send.
- Same key + different intent → `NotificationIdempotencyConflictError`,
  loud and explicit — never a silent reuse of the wrong message.
- Ordering is contractual: the `(organizationId, idempotencyKey)` lookup
  and intent comparison run **before** provider resolution. A replay of
  an already-recorded request is answered from the durable record alone
  — it keeps succeeding even if provider configuration has since become
  invalid, and it never resolves a provider at all. Provider resolution
  happens only for a genuinely new, non-suppressed request, still before
  the row is created, so a configuration error can never leave an
  orphaned `PENDING` row. The unique index remains underneath as the
  concurrent-create race protection (`P2002` → the same
  replay/conflict settlement).
- Where the provider supports it, SARbase sends a per-attempt provider
  idempotency key (`{notificationId}/attempt-N`) as a second layer: a
  re-invoked same attempt can dedupe at the provider, while a deliberate
  retry is a new provider operation.

## Retry

There is intentionally **no** background job machinery. Retry is an
explicit act:

- `isRetryableNotification` exposes eligibility as a fact: the request is
  `FAILED` with a retryable last-attempt classification, `PENDING` with a
  `DISPATCHING` attempt older than `DISPATCHING_STALE_MS` (10 minutes —
  presumed orphaned by a crash; a _fresh_ DISPATCHING attempt is in
  flight and refused), or `PENDING` with no attempt at all.
- `retryNotification` appends a **new** attempt row via
  `dispatchAttempt`. Attempts are capped at `MAX_NOTIFICATION_ATTEMPTS`
  (5). `ACCEPTED`, `SUPPRESSED`, and non-retryable failures are never
  retried.
- Concurrency: the attempt-creation transaction takes `SELECT … FOR
UPDATE` on the notification row and re-checks eligibility under the
  lock, so two concurrent dispatches cannot both proceed. The
  `@@unique([notificationId, attemptNumber])` index is defense-in-depth.
- The provider call runs _after_ the transaction commits — no database
  lock is held across a network call.

Automatic background retry, exponential backoff, and a durable queue are
deferred; if needed later they build on these same records.

## Providers

### The seam

```ts
interface NotificationProvider {
  readonly providerName: string; // persisted on attempts
  readonly channel: NotificationChannelName;
  send(request: ProviderSendRequest): Promise<ProviderSendResult>;
}
```

`ProviderSendResult` is `accepted` (+ optional `providerMessageId`) or
`failed` (+ `errorCode`, `errorSummary`, `retryable`). The error
taxonomy: `config_missing`, `provider_auth`, `provider_rejected`
(non-retryable), `provider_unavailable`, `provider_error` (retryable).

### Resend (real provider)

Chosen by repository audit: neither SARbase nor app-foundations had any
email provider. `src/lib/notifications/resend.ts` wraps the official
`resend` SDK behind a structural `ResendClientLike` interface so tests
inject a fake client without mocking the package. The SDK is imported
only inside the adapter; `error.message` from Resend is never propagated
(it can echo recipient addresses or payloads) — `name`/`statusCode` map
to SARbase codes and fixed operator-facing summaries.

### Fake provider

`FakeNotificationProvider` never touches the network. It records every
call in `calls`, consumes a scripted `results` queue in order, then
applies `defaultResult` (default: accepted with a deterministic
`fake-msg-N` provider id). `fakeFailure.{rejected,unavailable,error}`
are canned outcomes for deterministic retry tests.

### Provider resolution — fail closed

`resolveNotificationProvider` (`src/lib/notifications/resolve.ts`):

| Condition                                                                                 | Result                                                                                           |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `NOTIFICATION_PROVIDER=resend`                                                            | Resend — requires `RESEND_API_KEY` and `NOTIFICATION_EMAIL_FROM`, else `NotificationConfigError` |
| Unset + `RESEND_API_KEY` present                                                          | Resend (same requirements)                                                                       |
| `NOTIFICATION_PROVIDER=fake`, or unset without the key — non-production                   | Deterministic fake                                                                               |
| Same — in a real production deployment (`VERCEL_ENV=production` or `NODE_ENV=production`) | `NotificationConfigError` — production can never silently fall back to the fake                  |

## Authorization and rate limiting

All notification records are organization-scoped. Admin surfaces require
an `ADMIN` `OrganizationAccess` grant for the record's own organization;
foreign ids and nonexistent ids are indistinguishable ("Not found." /
`NEXT_NOT_FOUND`). The actor is always `ctx.identity.id` from the verified
session — never a form field.

Admin sends and retries are rate-limited with the existing fixed-window
foundation (`src/lib/rate-limit/`): 10 per 60s per (org, actor), keyed by
`rateLimitKey(scope, organizationId, actorId)` — an opaque SHA-256 hash,
never a raw address, member id, or message content. The bundled
`InMemoryRateLimitStore` is a documented per-process best-effort
throttle; a distributed store can replace it later.

## Privacy and logging

- Never logged: message bodies, subjects, recipient addresses, provider
  API keys, raw provider payloads.
- Logged: notification/attempt ids, organization id, channel, provider
  name, attempt number, normalized status, error code, provider message
  id.
- Provider `error.message` is never propagated — adapters map error
  names/status codes to fixed SARbase summaries.
- Stored content (`subject`, `bodyText`, `destination`) is an org-scoped
  record governed by the same access rules as any other org data. It
  exists so retries replay the exact message and history is honest; it
  must stay out of logs, telemetry, and rate-limit keys.

## Environment variables

| Variable                  | Scope              | Purpose                                                            |
| ------------------------- | ------------------ | ------------------------------------------------------------------ |
| `NOTIFICATION_PROVIDER`   | server             | `resend` or `fake`; optional (see resolution rules)                |
| `RESEND_API_KEY`          | server, **secret** | Resend API credential                                              |
| `NOTIFICATION_EMAIL_FROM` | server             | Verified sender, e.g. `SARbase Notifications <notify@example.org>` |

CI runs with none of these set — the resolver returns the fake outside
production, so CI never sends real email and needs no credentials.

## Adding a provider or channel

1. Add the channel to the `NotificationChannel` enum + Prisma migration.
2. Implement `NotificationProvider` in `src/lib/notifications/<name>.ts`
   (map provider errors to SARbase codes; never propagate raw provider
   messages).
3. Register it in `resolveNotificationProvider` and extend the channel's
   preference/destination check in `resolveRecipient`.
4. `provider` is a plain string column — no migration needed for a second
   email provider.

## Deferred — deliberately not built

Responder-facing channels beyond email, SMS/WhatsApp/push providers,
multi-channel escalation, automatic/background retries, provider delivery
webhooks (real `DELIVERED` state), a generic workflow engine, incident
workflow (#15), and global search (#18). Callout orchestration (#14)
builds on this foundation — one `callout_invitation` request per
invitation with a deterministic idempotency key — see
[`docs/callouts.md`](callouts.md).
