# Authentication and authorization

SARbase authenticates with **Firebase Auth** and authorizes with its own
database rows. This document is the reference for the architecture,
deployment setup, bootstrap procedure, and the security model. It is
issue #6's replacement for the temporary issue #5 admin gate (now removed).

> Provider neutrality: v1 is Firebase-specific at the token-verification
> seam (`src/lib/firebase/`, `src/lib/auth/session.ts`). Everything above
> that seam — identities, organization access, roles, authorization
> helpers — is provider-agnostic and keyed on `(provider, providerUid)`,
> so a second provider can coexist without reshaping the model. A
> generalized pluggable-auth framework was deliberately not built.

## Architecture

```
browser                    server (Next.js)
-------                    -----------------
email+password  ──►  Firebase Auth (client SDK)
      │
      └── idToken ──► createSessionAction
                        1. verifyIdToken(token, checkRevoked)   (firebase-admin)
                        2. upsert AuthIdentity(provider=firebase, providerUid=sub)
                        3. createSessionCookie ──► Set-Cookie: sarbase_session
                           HttpOnly · SameSite=Lax · Secure on HTTPS · 5 days

every request  ──►  getAuthContext()
                        1. read sarbase_session cookie
                        2. verifySessionCookie(cookie, checkRevoked: true)
                        3. AuthIdentity lookup by (provider, providerUid)
                           — must exist and be ACTIVE
                        4. load members + OrganizationAccess rows
```

The ID token is verified **server-side** before anything is written, and
is never stored, logged, or placed in a URL. Roles are **not** embedded
in the token/cookie — every request evaluates the _current_ database
rows, so access changes take effect immediately.

Session cookie: `sarbase_session`, HttpOnly, `SameSite=Lax`, `Secure`
when `VERCEL_ENV` is production/preview or `APP_BASE_URL` is `https:`,
5-day max age. **CSRF:** server actions are protected by Next.js's
built-in Origin check; the cookie's `SameSite=Lax` additionally blocks
cross-site POSTs carrying it.

**Sign-out** clears the cookie and calls `revokeRefreshTokens(uid)`,
so the revoked user's session cookie stops verifying on the next
request (revocation is checked on every verify). Disabling an
`AuthIdentity` (status `DISABLED`) fails closed at step 3 above —
it cannot resolve a context even while a cookie remains valid.

## Models

- **`AuthIdentity`** — the login identity. `provider` + `providerUid`
  (unique pair), normalized `email` (display/lookup only, never an
  authorization input), `status` (`ACTIVE`/`DISABLED`). Auto-provisioned
  at first verified sign-in with **zero access**.
- **`Member.authIdentityId`** — optional, **not** unique. An identity may
  link to member records in several organizations (the same person
  volunteering across orgs); each member record links to at most one
  identity. `SetNull` on identity deletion — removing a login never
  destroys the domain person record.
- **`OrganizationAccess`** — the sole source of org-scoped access:
  `(authIdentityId, organizationId)` unique pair + `role`. One row per
  identity per org.

### Cardinality

- AuthIdentity → Member: **1 : 0..N** (via optional `Member.authIdentityId`)
- AuthIdentity ↔ Organization: **N : M** via `OrganizationAccess`, one
  role per (identity, org) pair
- Member → AuthIdentity: **0..1** — members don't need logins, and
  identities may exist with no member records

### Roles

`OrgRole = MEMBER | ADMIN`, evaluated per organization:

- `ADMIN` — application administration only: org/unit/member CRUD and
  identity linking for that organization. It implies **nothing** about
  SAR command authority, operational competence, launch authority, or
  readiness. SARbase does not practice search and rescue.
- `MEMBER` — authenticated ordinary member. Currently proves identity
  and linked member context (see `/account`); it grants no admin
  capabilities. Future self-service features build on it.

New roles are added by extending the enum — the `(identity, org, role)`
relation needs no schema change.

## Authorization rules

The critical rule: **an `organizationId`/`memberId`/`unitId` arriving
from a URL, form, server-action binding, hidden input, or query string
is an untrusted selector.** It selects _which record_ to act on; it can
never select _which grant_ to honor.

Centralized helpers in `src/lib/auth/`:

- `getAuthContext()` — resolve the request's identity + access rows, or
  `null` (no cookie, invalid/revoked session, unknown/disabled identity)
- `requireAuth()` — redirect unauthenticated to `/login`
- `getAuthContextOrThrow()` — `AuthenticationError` variant
- `isOrgAdmin` / `hasOrgAccess` / `adminOrganizationIds` — predicates
- `requireOrgAdmin(ctx, orgId)` / `requireOrgAccess(ctx, orgId)` —
  throw the opaque `AuthorizationError`
- `requireOrgAdminOrNotFound(orgId)` — page variant: `notFound()`
- `requireOrgAdminForMember(ctx, memberId)` /
  `requireOrgAdminForUnit(ctx, unitId)` — resolve the record, take its
  **real** `organizationId`, then check the caller's grants

Every `/admin` server action follows this shape. For example
`updateMemberAction(memberId, …)` resolves the member server-side and
checks ADMIN on _the member's_ organization — a substituted `orgId`
simply doesn't exist as a parameter anymore. Denials map to an opaque
`"Not found."` so probes cannot distinguish "doesn't exist" from
"exists outside your scope". Denials are logged via `authz.*` events
with internal ids only — never emails or tokens.

`MemberUnit` membership is **not** an authorization input: units are
internal groupings, not security boundaries.

## Initial administrator bootstrap

There is no in-app or self-registration path to ADMIN. Provisioning is
a CLI command (idempotent, no secrets in source):

```bash
# The person must exist in Firebase Authentication AND have signed in
# once (so their AuthIdentity row exists), or supply their Firebase UID:
npm run admin:provision -- --org "My SAR Organization" --create \
  --uid <firebase-uid>

# or, after they've signed in once:
npm run admin:provision -- --org "My SAR Organization" \
  --email admin@example.org
```

`--uid` upserts the `AuthIdentity` (use the UID from the Firebase
console user list); `--email` only ever matches an _existing_ identity —
SARbase does not guess a UID from an email or grant access by email
matching alone. Re-running reconciles to "has ADMIN" and reports what
changed. Refuses DISABLED identities; requires `--create` to create a
missing organization.

## Account ↔ member linking

On a member's admin page, an org ADMIN can link a sign-in identity to
that member record by the identity's **sign-in email** — which must
already exist (the person signed in once, or was provisioned by UID).
Linking writes `Member.authIdentityId` _and_ ensures a `MEMBER`-level
`OrganizationAccess` row for the member's organization, so the account
has a deterministic context. Unlinking clears the member link without
touching access grants. Both emit structured `auth.identity_linked` /
`auth.identity_unlinked` events.

## Deployment (Firebase setup)

Any organization can self-host this. You need a Firebase project with
**Email/Password** sign-in enabled (Spark/free tier suffices), plus a
service account:

1. Firebase console → Project settings → _Your apps_ → Web app → copy
   `apiKey`, `authDomain`, `projectId`, `appId` → set the four
   `NEXT_PUBLIC_FIREBASE_*` env vars (public by design).
2. Project settings → _Service accounts_ → _Generate new private key_ →
   set `FIREBASE_ADMIN_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`,
   `FIREBASE_ADMIN_PRIVATE_KEY` (paste with `\n` escapes). These are
   secret — deployment env only, never committed, never in CI.
3. Authentication → _Users_ → _Add user_ for each sign-in account.
   There is no public registration; SARbase provisions zero-access
   `AuthIdentity` rows at first sign-in.
4. `npm run admin:provision` (above) grants the first org ADMIN;
   that admin links member records in the UI.

All env vars are listed in `.env.example`. Missing config fails closed:
the sign-in UI reports "authentication is not configured", no session
can be minted, and every protected surface denies. Builds and CI need
none of these — `firebase-admin` initializes lazily at first use.

## Deferred

- Durable audit-history records for role/access changes (today:
  structured operational logs only — logs are not an audit trail).
- Member self-service beyond `/account` readout; invitation emails and
  link-confirm UX flows.
- Additional `OrgRole` values when their domains land; unit-level
  scoping; RLS.
- Provider-abstracted session layer if a second auth provider is added.
