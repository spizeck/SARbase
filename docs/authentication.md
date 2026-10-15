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

- AuthIdentity → Member: **1 : 0..N** globally (via optional
  `Member.authIdentityId`), but **at most one linked Member per
  organization per identity** — enforced by
  `@@unique([organizationId, authIdentityId])` on `Member`. NULL
  `authIdentityId` values are distinct in Postgres, so any number of
  unlinked member records coexist.
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

### The Member link is not an access grant

`Member.authIdentityId` answers "which domain person is this login
linked to?" — `OrganizationAccess` alone answers "which organizations
may this login currently access?" Everything `/account` derives from a
linked member (the member record, its organization's name, its
qualification records, and any future self-service data) goes through
`linkedMembersWithAccess(ctx)`, which exposes a member only when the
context also holds an access row for that member's organization —
MEMBER or ADMIN. Revoking access hides the member data immediately;
the link row is left untouched (not deleted) so restoring access
restores visibility.

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
- `requireOrgAdminForDefinition(ctx, definitionId)` /
  `requireOrgAdminForQualification(ctx, qualificationId)` — same
  pattern for the qualification domain (issue #8)
- `requireOrgAdminForTrainingEvent(ctx, eventId)` — same pattern for
  training events and their attendance (issue #9)
- `linkedMembersWithAccess(ctx)` — the member records visible to this
  identity (access boundary; see below)

Every `/admin` server action follows this shape. For example
`updateMemberAction(memberId, …)` resolves the member server-side and
checks ADMIN on _the member's_ organization — a substituted `orgId`
simply doesn't exist as a parameter anymore. Denials map to an opaque
`"Not found."` so probes cannot distinguish "doesn't exist" from
"exists outside your scope". Denials are logged via `authz.*` events
with internal ids only — never emails or tokens.

`MemberUnit` membership is **not** an authorization input: units are
internal groupings, not security boundaries.

## In-app role management (issue #74)

Once an organization has its first ADMIN, further role changes happen
in the app — no scripts or database edits. The **Access & roles**
screen (`/admin/organizations/[orgId]/access`, ADMIN-only) lists every
`OrganizationAccess` grant with the linked member record and account
status, pending invitations, and the audited change history.

- Changing MEMBER ↔ ADMIN requires an explicit confirmation that
  summarizes the access being granted or removed, and is refused when
  it would leave the organization without an ACTIVE administrator.
  The guard is enforced under a per-organization
  `pg_advisory_xact_lock`, so two concurrent demotions cannot both
  slip past the check. A grant on a DISABLED identity is not an
  active administrator.
- Every applied change writes an `OrganizationAccessEvent` row in the
  same transaction — organization, target identity, previous/new role,
  actor, timestamp — so the history cannot exist without the change it
  describes. Because authorization re-reads `OrganizationAccess` on
  every request, a changed role takes effect immediately.
- A pending invitation's role is never edited in place: revoke it and
  re-invite with the intended role (both steps are already audited by
  `MemberInvitationEvent`).

## Initial administrator bootstrap

The FIRST ADMIN of an organization still comes from the CLI — there is
no self-registration path to ADMIN and no in-app path to organization
creation. Creating an organization and granting its first ADMIN is a
single explicit operator act via the CLI command (idempotent, no
secrets in source):

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
that member record by the identity's **sign-in email**. Because
`AuthIdentity.email` is deliberately non-unique, the link resolves only
when the email matches **exactly one** ACTIVE identity — zero matches
gives an account-not-ready error, multiple matches refuse with an
ambiguity error (mirroring `admin:provision`'s `--email` behavior).
Email is a lookup convenience, never an authoritative identity key.

Linking writes `Member.authIdentityId` _and_ ensures a `MEMBER`-level
`OrganizationAccess` row for the member's organization, so the account
has a deterministic context — it never creates `ADMIN` grants. An
identity already linked to a member in that organization fails with a
clear "already linked" error (the per-org uniqueness constraint).
Unlinking clears the member link without touching access grants. All
of these emit structured `auth.identity_linked` /
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
3. Authentication → _Settings_ → _Authorized domains_ — add every
   deployment origin, e.g. `sar-base.vercel.app`. `vercel.app` wildcard
   entries are not supported: each `sar-base-git-<branch>-*.vercel.app`
   preview alias is a distinct domain. Email/password sign-in works
   without an entry (it calls `identitytoolkit.googleapis.com`
   directly), but popup/redirect providers and email-link flows need
   the exact domain authorized — add domains before enabling those.
4. Authentication → _Users_ → _Add user_ for each sign-in account.
   There is no public registration; SARbase provisions zero-access
   `AuthIdentity` rows at first sign-in.
5. `npm run admin:provision` (above) grants the first org ADMIN;
   that admin links member records in the UI.

**Sign-in providers:** only Email/Password is implemented
(`signInWithEmailAndPassword` in `src/app/login/login-form.tsx`).
Enabling another provider in the console (e.g. Google) changes nothing
in the app — there is no popup/redirect UI. Adding one is a small
deliberate feature: `signInWithPopup` + a button, with the CSP/COOP
groundwork already in place (`apis.google.com` in `script-src`,
`same-origin-allow-popups` in `src/lib/security/headers.ts`).

**Preview sign-ins** need two things on top of the client config: the
three `FIREBASE_ADMIN_*` variables scoped to Preview, and
`ALLOW_FIREBASE_ADMIN_IN_PREVIEW=true` — without the flag the Admin
SDK refuses to initialize on previews and sign-in fails closed
(`docs/preview-databases.md`). When the preview environment shares the
production Firebase project (small-team setup), sign-in works against
the same user pool but authorization still comes from the preview's own
Neon branch — a production ADMIN's grants do not carry over. One
consequence to know: signing out on a preview calls
`revokeRefreshTokens` on the shared project, which ends that user's
production sessions too.

All env vars are listed in `.env.example`. Missing config fails closed:
the sign-in UI reports "authentication is not configured", no session
can be minted, and every protected surface denies. Builds and CI need
none of these — `firebase-admin` initializes lazily at first use.

## Deferred

- Member self-service beyond `/account` readout; invitation emails and
  link-confirm UX flows.
- Additional `OrgRole` values when their domains land; unit-level
  scoping; RLS.
- Provider-abstracted session layer if a second auth provider is added.
