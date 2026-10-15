# Hosted smoke testing

The Playwright suite (`smoke-tests/`) has two run modes:

- **Local** (`npm run test:e2e`, `playwright.config.ts`) — builds the app
  and runs every spec against `next start` in CI. Anonymous coverage
  only; no Firebase session exists in that environment.
- **Hosted** (`npm run test:e2e:hosted`, `playwright.hosted.config.ts`) —
  points the same specs at a deployed instance — a Vercel preview, a
  staging deployment, or a local `next start`. `SMOKE_BASE_URL` is
  required:

  ```sh
  SMOKE_BASE_URL=https://sar-base-git-feat-x.vercel.app npm run test:e2e:hosted
  ```

## What runs where

The hosted config splits the suite into two Playwright projects:

- `anonymous` — every existing spec. Asserts what must hold for a
  caller with no session: `/admin` redirects to `/login`, attachment
  downloads reject with opaque 401s, security headers, public pages,
  `/respond` invalid-token behavior. Runs anywhere with zero secrets.
- `authenticated` — `smoke-tests/authenticated.spec.ts` only. Drives a
  **real sign-in** (the login form → Firebase client → server session
  cookie) inside global setup, then asserts session-boundary behavior:
  `/admin` renders instead of redirecting, `/account` shows the
  identity, org pages resolve, foreign attachment ids stay opaque.
  Skips cleanly when no smoke credentials are configured.

## Deployment protection (Vercel)

Vercel Deployment Protection would otherwise 401 every request. Set the
project's _protection bypass for automation_ secret:

```sh
SMOKE_VERCEL_BYPASS=<bypass-secret> SMOKE_BASE_URL=... npm run test:e2e:hosted
```

Global setup sends the secret exactly once — a single request to the
deployment origin that asks Vercel to mint its domain-scoped bypass
cookie (`x-vercel-set-bypass-cookie`). Both projects then carry that
cookie via Playwright storage state, so browser pages and the `request`
fixture pass protection without the secret ever riding a context-wide
header (which third-party origins, e.g. the Firebase API, would also
receive). `SMOKE_BASE_URL` must be `https://` for non-loopback targets
so the secret never travels unencrypted; it is never printed to logs or
test output. Do **not** disable Deployment Protection to run smoke
tests; keep it on and use the bypass.

## Authenticated coverage — owner setup (one time per preview)

Automated authenticated specs need a disposable identity that exists in
BOTH places the app checks:

1. **A test user in the deployment's Firebase project.** Previews must
   use a dedicated preview Firebase project
   (`ALLOW_FIREBASE_ADMIN_IN_PREVIEW=true`); never mint smoke users in
   the production project.
2. **A matching authorization row in the preview database.** The
   identity's Firebase uid needs an `AuthIdentity` +
   `OrganizationAccess(role=ADMIN)` row against the seeded organization
   — the same bootstrap `admin:provision` performs:

   ```sh
   npm run admin:provision -- --uid <firebase-uid> --org <org-id>
   ```

   (Preview branches are provisioned from the `testing` baseline —
   grant the smoke identity there so every PR preview inherits it, or
   grant inside the specific preview database.)

Then run:

```sh
SMOKE_BASE_URL=... \
SMOKE_VERCEL_BYPASS=... \
SMOKE_TEST_EMAIL=smoke@example.test \
SMOKE_TEST_PASSWORD=<test-user-password> \
npm run test:e2e:hosted
```

The credentials only ever reach the target's own `/login` form — the
sign-in exercises the real Firebase client path and the app's session
minting. The captured session state lands in `.auth/` (gitignored).

## Coverage status

| Surface                             | Local CI | Hosted anonymous | Hosted authenticated             |
| ----------------------------------- | -------- | ---------------- | -------------------------------- |
| Public pages, headers, health       | yes      | yes              | not run                          |
| Anonymous auth rejections/redirects | yes      | yes              | not run                          |
| Real Firebase sign-in + session     | n/a      | n/a              | yes (needs creds)                |
| Admin navigation, org pages         | n/a      | n/a              | yes (needs creds)                |
| Attachment download authorization   | yes      | yes              | yes                              |
| Attachment upload (direct-to-store) | n/a      | n/a              | not yet — needs a preview bucket |

A mock or isolated-bucket upload journey is a follow-up: it requires an
S3 endpoint the preview can write (`ALLOW_S3_IN_PREVIEW` + a dedicated
preview bucket — never production storage).

## Data-coupled specs

The callout token-flow specs write fixture rows straight into the
target's database (Prisma) and so only activate when the suite can
reach it:

- `SMOKE_DATABASE_URL` — preferred for hosted runs; point it at the
  target deployment's database (e.g. a preview branch's URL).
- Ambient `DATABASE_URL` — used in local mode where the test process
  and `next start` share env. Careful against hosted targets: a stray
  local URL creates fixtures in the wrong database.

The deployment itself must also have `CALLOUT_RESPONSE_TOKEN_SECRET`
set — `/respond` 500s without it and the suite (which derives fixture
tokens with the same pepper from its own env) correctly reports that as
a misconfiguration failure, not a skip. For hosted runs, set the suite's
`CALLOUT_RESPONSE_TOKEN_SECRET` to the TARGET deployment's pepper — for
previews that is a preview value, never the production secret. The
dispatch workflow maps GitHub secret `SMOKE_CALLOUT_RESPONSE_TOKEN_SECRET`
into that variable.

## Manual verification

For provider-touching paths automation cannot see — real S3 buckets,
real Resend delivery, preview-environment flags — use the manual
checklist in `docs/production-smoke-checklist.md`.
