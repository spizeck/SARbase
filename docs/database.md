# Database architecture (Neon + Prisma)

This document is the canonical environment and migration contract for
SARbase. It encodes what the production applications this foundation was
extracted from learned the hard way — read it before changing migration,
seeding, or environment behavior.

## Environment topology

Model A of the app-foundations database-lifecycle standard (ADR-0001):
GitHub Actions-managed Neon preview branches over a permanent fictional
`testing` baseline.

| Environment      | Database                                                        | Data            | Notes                                                              |
| ---------------- | --------------------------------------------------------------- | --------------- | ------------------------------------------------------------------ |
| local dev        | docker-compose postgres (`:5433`) or a personal Neon dev branch | synthetic seeds | disposable                                                         |
| CI               | postgres service container, empty at job start                  | none            | migration replay + db tests                                        |
| testing          | permanent Neon branch `testing`                                 | fictional only  | baseline for all previews; maintained, never reset from production |
| preview (per-PR) | Neon branch `preview/pr-<n>`, child of `testing`                | fictional only  | created/torn down by `.github/workflows/neon-preview.yml`          |
| production       | Neon branch `main`                                              | real            | never touched by CI/previews                                       |

Preview branches are provisioned per _pull request_, not per git
branch: a PR gets exactly one `preview/pr-<n>` branch, reused on every
push. The unit of isolation is the PR's deployment — copy-on-write
branches keep that cheap.

`testing` must never be refreshed from `main` once production holds
real data: fictional data is rebuilt by replaying committed migrations
and running `npm run db:seed -- --target testing --confirm`. See
`docs/preview-databases.md` for the full lifecycle and setup runbook.

**Readiness gate:** after `docker compose up -d postgres`, run
`npm run db:wait` (`scripts/wait-for-postgres.ts`) before any `createdb`,
migration, or test step. The postgres image's entrypoint starts a
temporary initdb-time server that answers `pg_isready` on the unix
socket, then shuts it down — CI once raced `createdb` into that window.
`db:wait` instead requires consecutive successful `select 1` queries
over TCP (the initdb server never listens on TCP) and dumps the service
logs on timeout.

## Connection strings

- `DATABASE_URL` — pooled endpoint (`*-pooler*`), used by runtime queries.
- `DATABASE_URL_UNPOOLED` — direct endpoint, used by `prisma migrate
deploy`, introspection, and seed/backup scripts. PgBouncer-pooled
  connections break session-level migration locks; never run migrations
  through the pooler. Declared as `directUrl` in `prisma/schema.prisma`
  so `migrate deploy` always takes the direct endpoint.
- `APP_PRODUCTION_DB_HOST` — non-secret production hostname, set on
  **both the Vercel Preview and Production environments**. On production
  it is a positive-identity check: a production build whose
  `DATABASE_URL*` does not resolve to it refuses to build. On preview it
  is an exclusion check: a preview whose database URL resolves to it
  fails the build. A missing value fails closed in both cases.
- `APP_PREVIEW_DB_HOST` — non-secret hostname of this preview's Neon
  branch, written per git branch by the neon-preview workflow alongside
  the connection URLs. Positive preview identity: a preview build whose
  `DATABASE_URL`/`DATABASE_URL_UNPOOLED` do not both resolve to this
  exact host refuses to migrate.
- `APP_TESTING_DB_HOST` — non-secret hostname of the permanent `testing`
  branch, bound to `db:seed -- --target testing` so the target name
  proves endpoint identity.

## Migration posture

Production migrations run **inside the Vercel build**
(`build:vercel` → `scripts/vercel-build.ts`), before `next build`:

- `VERCEL_ENV=production` → requires `DATABASE_URL`,
  `DATABASE_URL_UNPOOLED`, and `APP_PRODUCTION_DB_HOST`; both URLs must
  resolve to the production host and to the same database →
  `prisma migrate deploy`, then build. Any gap → **fail closed** (exit 1).
- `VERCEL_ENV=preview` without `DATABASE_URL` → skip migrations and
  build (a branch without a PR simply has no preview database).
- `VERCEL_ENV=preview` with `DATABASE_URL` → requires
  `DATABASE_URL_UNPOOLED`, `APP_PRODUCTION_DB_HOST` (production
  exclusion), and `APP_PREVIEW_DB_HOST` (positive preview identity);
  both URLs must resolve to exactly that host and the same database →
  migrate, then build. Any gap or mismatch → **fail the build**.
- A failed migration aborts the build → the deployment is never
  promoted and the previous release keeps serving. Failed migrations
  are recovered by fix-forward (a new migration commit), never by
  automatic rollback.

Because migrations apply _before_ the new build exists, every migration
must be backward-compatible with the currently-serving release —
**expand/contract only**: add columns nullable or with defaults first,
backfill, then constrain/drop in a follow-up deploy.

> **Alternative (documented, not implemented here):** the Sea Saba
> posture runs production migrations as an operator-gated manual step
> instead of in-build. It trades the promote-safety guarantee for a
> human checkpoint. Pick ONE posture per application — SARbase
> implements the in-build posture because it has the stronger failure
> handling.

## Migration discipline

- Create migrations with `prisma migrate dev` against your LOCAL db.
- **Never edit, rename, or delete an applied migration.** Reconcile by
  appending a new migration to the tail.
- CI replays every migration onto an empty database (`migrate deploy`
  on a fresh postgres) — a migration that can't rebuild from scratch is
  a release-blocking defect.
- CI also diffs `prisma/migrations` against `schema.prisma` — schema
  drift (edited schema without a migration, or vice versa) fails the
  build.

## Seeding

`npm run db:seed` inserts synthetic placeholder rows only — fictional
organizations, units, members, qualifications, equipment, inspections,
maintenance, and availability, all with fixed `seed-*` ids and upserts
so reseeding is idempotent. Seed data is generated here — never copied
or derived from production.

Target safety (`prisma/seed.ts`):

- Loopback hosts (local dev, CI service containers) seed freely.
- Any remote host requires `--target <name> --confirm`.
- `--target testing` additionally requires the URL to resolve to
  `APP_TESTING_DB_HOST` — a positive identity binding, not just an
  asserted name.
- The `APP_PRODUCTION_DB_HOST` host is refused under every invocation.
- Connection strings with `host`/`port`/`database`/`service` query
  overrides are refused — a slipstreamed parameter could otherwise
  retarget the driver past the validated hostname.
- The client binds `DATABASE_URL_UNPOOLED ?? DATABASE_URL`, the same
  URL the guard inspects.

`npm run db:verify` (`scripts/verify-database.ts`) is the read-only
baseline check: prints the normalized target identity, fails on the
production host or an unverifiable remote target, reports
`prisma migrate status`, and asserts fictional-only invariants (seed-*
ids on every Member/AuthIdentity, RFC 2606 email domains, warnings for
non-seed operational rows).

## Database tests

`*.db.test.ts` files run via `npm run test:db` against
`TEST_DATABASE_URL` only — a dedicated disposable database. The vitest
config deliberately maps `TEST_DATABASE_URL` onto `DATABASE_URL` so a
missing test var can never hit a real database.

## Backup and recovery

Two layers, deliberately separate:

- **Provider layer:** Neon point-in-time restore and snapshots — know
  your plan's restore window and document the procedure before you need
  it.
- **Portable logical backups:** `npm run db:backup` runs a guarded
  `pg_dump` (`scripts/backup-database.ts`). It requires `--target` and
  `--confirm`, refuses `--target production` without
  `--force-production`, refuses entirely in a production-looking
  environment, prefers `DATABASE_URL_UNPOOLED`, and never puts
  credentials on argv. Use `--dry-run` to preview.

Restores go to a TEMPORARY database first, are verified, then promoted —
never `pg_restore` straight into production. The full operator procedure
lives in `runbooks/database-backup-restore.md`.

**Attachment bytes are not in the database.** Both backup layers cover
only attachment _metadata_ (rows, links, document versions, audit
events). File contents live in the configured object store —
`FILE_STORAGE_LOCAL_ROOT` for the `local` provider, the bucket for `s3`
— and must be backed up separately. See `docs/attachments.md`.

### Restore drill

`npm run db:restore-drill -- --target development --confirm`
(`scripts/restore-drill.ts`) proves the backup path end-to-end against a
LOCAL database only: create scratch DB → migrate → insert fixture →
`pg_dump` → delete fixture → `pg_restore` → verify recovered → drop
scratch DB. It refuses remote hosts and production-looking environments.
It uses the docker-compose `postgres` service when running (pg tools
inside the container always match the server version) and falls back to
host `psql`/`pg_dump`/`pg_restore`. CI runs it on every pull request —
a backup path that can't restore is a release-blocking defect.

## Environment validation

`src/lib/env.ts` provides lazy per-concern zod parsing
(`parseDatabaseEnvironment`, `parseDatabaseAdminEnvironment`,
`parseAppEnvironment`, `parseStorageEnvironment`). Nothing validates at
import time — `next build`
with zero env vars must keep working. The admin schema proves
`DATABASE_URL` and `DATABASE_URL_UNPOOLED` resolve to the same database
(Neon `-pooler` suffix normalized) and rejects Vercel `[SENSITIVE]`
placeholder values — both real production misconfiguration classes.
