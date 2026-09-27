# Database architecture (Neon + Prisma)

This document is the canonical environment and migration contract for
SARbase. It encodes what the production applications this foundation was
extracted from learned the hard way — read it before changing migration,
seeding, or environment behavior.

## Environment topology

| Environment      | Database                                                        | Data            | Notes                        |
| ---------------- | --------------------------------------------------------------- | --------------- | ---------------------------- |
| local dev        | docker-compose postgres (`:5433`) or a personal Neon dev branch | synthetic seeds | disposable                   |
| CI               | postgres service container, empty at job start                  | none            | migration replay + db tests  |
| preview (per-PR) | ephemeral Neon branch via the Vercel–Neon integration           | synthetic seeds | deleted with the branch      |
| production       | the production Neon project branch                              | real            | never touched by CI/previews |

**Deliberately NOT "one Neon branch per git branch."** Branch-per-branch
migrates schema drift into dozens of half-stale copies, costs quota, and
produces confusing partial previews. The unit of isolation is the
_deployment environment_, not the git ref.

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
  through the pooler.
- `APP_PRODUCTION_DB_HOST` — non-secret production hostname, set **only
  on the Vercel Preview environment**. `scripts/vercel-build.ts` uses it
  as an exclusion check; a missing value skips preview migrations
  (fail-safe), a matching host fails the build.

## Migration posture

Production migrations run **inside the Vercel build**
(`build:vercel` → `scripts/vercel-build.ts`), before `next build`:

- `VERCEL_ENV=production` + `DATABASE_URL` → `prisma migrate deploy`,
  then build. No `DATABASE_URL` → **fail closed** (exit 1).
- `VERCEL_ENV=preview` + non-production-host `DATABASE_URL` → migrate,
  then build. Missing `APP_PRODUCTION_DB_HOST` → skip migrations.
- Production host detected in a preview → **fail the build**.
- A failed migration aborts the build → the deployment is never
  promoted and the previous release keeps serving.

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

`npm run db:seed` inserts synthetic placeholder rows only. It refuses
when `DATABASE_URL` resolves to `APP_PRODUCTION_DB_HOST`. Seed data is
generated here — never copied from production.

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
`parseAppEnvironment`). Nothing validates at import time — `next build`
with zero env vars must keep working. The admin schema proves
`DATABASE_URL` and `DATABASE_URL_UNPOOLED` resolve to the same database
(Neon `-pooler` suffix normalized) and rejects Vercel `[SENSITIVE]`
placeholder values — both real production misconfiguration classes.
