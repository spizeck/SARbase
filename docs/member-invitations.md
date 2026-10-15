# Member invitations

Member invitations are the primary onboarding workflow: an administrator
invites an existing member record by email, the invitee authenticates
with Firebase, proves they own the invited address, and SARbase links
their identity and grants exactly the role the administrator selected.

> The flow replaces "ask them to sign in, then link by email" as the
> normal path. Manual identity linking remains available on the member
> page as an administrative fallback for out-of-band situations.

## Setup

| Variable                              | Scope                   | Purpose                                                  |
| ------------------------------------- | ----------------------- | -------------------------------------------------------- |
| `MEMBER_INVITATION_TOKEN_SECRET`      | Production **required** | HMAC secret that derives invitation tokens               |
| `RESEND_API_KEY`                      | Production              | Email delivery (without it sends are recorded as failed) |
| `NOTIFICATION_EMAIL_FROM`             | Production              | Sender address for the invitation email                  |
| `NEXT_PUBLIC_SITE_URL`/`APP_BASE_URL` | Production              | Absolute base for the `/invite?t=…` link                 |

`MEMBER_INVITATION_TOKEN_SECRET` must be a long random value (e.g.
`openssl rand -base64 48`). **Rotating it invalidates every outstanding
invitation link** — plan rotation accordingly. Production fails closed:
issuing an invitation without the secret configured throws
`InvitationConfigurationError` before a row is written. Outside
production, a deterministic development fallback
(`sarbase-dev-member-invitation-token-secret`) keeps local/test flows
working without a configured secret; it is never acceptable in
production.

## Lifecycle

One `MemberInvitation` row per member (`memberId` is unique):

```
            ┌───────────┐   resend (token rotation)   ┌───────────┐
invite ──►  │  PENDING  │ ─────────────────────────► │  PENDING  │ ──► accept ──► ACCEPTED
            └───────────┘                             └───────────┘
                  │                                        │
                  └── revoke ──► REVOKED                   └── expiresAt passes → displayed as EXPIRED

REVOKE/ACCEPTED are terminal. Re-inviting a revoked member reuses the
same row but writes a fresh CREATED event — one row, honest history.
```

- **Create** — admin picks destination email + `OrgRole` (default
  `MEMBER`). The destination is prefilled from the member's contact
  email but is editable. Issuing an `ADMIN` invitation requires an
  explicit confirmation checkbox.
- **Pending** — the email is sent through the notification seam
  (`member_invitation` template). The member page shows destination,
  creation date, expiry (7 days), and the notification's delivery
  status. Expiry is derived at read time — `PENDING` + past `expiresAt`
  displays as **Expired**; nothing is materialized lazily.
- **Resend** — increments `tokenVersion`, rotates the token hash,
  refreshes `expiresAt`, and records a `RESENT` event. Superseded links
  die immediately because the stored hash no longer matches their
  version.
- **Revoke** — marks the row `REVOKED` and records a `REVOKED` event;
  the link dies immediately even though its expiry has not passed.
- **Accept** — a signed-in invitee with a verified matching email links
  the member and grants the invited role. Single-use, atomic, and safe
  under concurrent requests (`SELECT … FOR UPDATE` on the invitation
  row).

`MemberInvitationEvent` is append-only lifecycle history with scalar
actor attribution (`createdByAuthIdentityId` / `acceptedByAuthIdentityId`
outlive identity deletion, matching the issue #12 actor policy).

## Token design

```
token   = base64url( HMAC-SHA256(secret, "member-invitation:<invitationId>:<tokenVersion>") )
lookup  = sha256(token)         — the only thing persisted
```

- Tokens are **derived, not generated**: deterministic per
  `(invitationId, tokenVersion)`, so a resend produces a new token
  without storing secrets, and replay of an old version fails the hash
  lookup.
- Only the SHA-256 hash is stored (`tokenHash`). Raw tokens exist only
  in the outbound email URL and in logs never — event details and log
  fields carry ids, roles, and statuses, never tokens or destinations.
- The `Notification` body stores `{member-invitation-url}`, not a live
  link. `resolveDispatchBodyText` recomputes the current URL at
  provider-dispatch time (and refreshes `tokenHash`), so retries replay
  the exact stored message while always carrying the current token —
  and a secret rotation does not strand a queued send holding a dead
  link.

## Acceptance requirements

`acceptMemberInvitation` (in `src/lib/domain/invitations.ts`) enforces:

1. Token resolves to a `PENDING`, unexpired invitation whose
   `tokenVersion` still matches — otherwise the same opaque
   `invalid`/`expired`/`revoked`/`accepted` reason; invitation
   existence is not enumerated.
2. The caller is a Firebase-authenticated identity
   (`email_verified: true`) whose **verified email equals the invited
   destination**. A forwarded link held by someone else proves nothing;
   a member's _contact_ email is never treated as proof of ownership.
3. The member is not already linked to a different identity, and the
   accepting identity is not already linked to a different member in
   that organization (`member_conflict`).
4. Atomically, under a row lock: upsert `AuthIdentity` (disabled
   accounts rejected), link `Member.authIdentityId`, upsert
   `OrganizationAccess` to **exactly the invited role** — a pre-existing
   grant is reconciled, never duplicated — mark the invitation
   `ACCEPTED`, and append the `ACCEPTED` event.

Admin actions (`create`/`resend`/`revoke`) go through
`requireOrgAdminForMember` / `requireOrgAdminForMemberInvitation`: the
organization is resolved from the member's real row, so URL tampering
cannot redirect an action into a foreign organization.

## Troubleshooting

| Symptom                                              | Likely cause / check                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Invite button fails with configuration error         | `MEMBER_INVITATION_TOKEN_SECRET` unset in production — set it and redeploy                |
| Invitation created but member page shows failed send | `RESEND_API_KEY`/`NOTIFICATION_EMAIL_FROM` missing or provider error — fix and **Resend** |
| Link opens to "invalid or expired"                   | Token rotated by a resend, revoked, past 7-day expiry, or secret rotated                  |
| "Sign in with the invited email"                     | Invitee signed in under a different (or unverified) address than the destination          |
| "This member is already linked"                      | The member record already has an identity — unlink first, or nothing to do                |
| All links dead after secret rotation                 | Expected — rotation invalidates every outstanding token; resend each invitation           |
| Preview invitation emails never arrive               | Resend is production-only config; preview sends record failures honestly                  |

## Related

- `docs/notifications.md` — the notification seam invitations send through
- `docs/authentication.md` — Firebase session/identity model
- `docs/domain-model.md` — `Member`/`OrganizationAccess` records being linked
