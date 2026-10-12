---
name: database-safety
description: Safety doctrine for schema migrations and data changes in managed SQL databases (Prisma + PostgreSQL/Neon) — expand/contract migrations, data preservation, transaction boundaries, index management, rollback strategy, and production migration review. Use when a task creates or modifies schema, migrations, indexes, constraints, or data migrations. Destructive production operations are prohibited without explicit approval.
---

# Database safety

Rules for changing the structure or content of production-bound data.
**The repository's own migration tooling, environment separation, and
backup/recovery docs are authoritative** — this skill is the review
standard applied to any database change.

## Before writing anything

- Read the actual schema, existing migrations, and the repo's
  database/environment docs. Do not implement from memory.
- Identify which environments the change must survive: local → CI →
  preview → production, and what data already exists in each.
- State the **invariant** the change must preserve (uniqueness,
  referential integrity, lifecycle constraints, "no double
  allocation", ledger balance). Prefer database enforcement for real
  invariants — they must survive application bugs, concurrent requests,
  and future code paths.

## Migration discipline (expand/contract)

- **Additive first.** Prefer migrations that only add — new tables,
  nullable columns, new indexes — over changes that rename, retype, or
  drop in one step.
- **Expand/contract for breaking shapes.** To replace a column or
  constraint: add the new shape, migrate/backfill, switch reads, then
  drop the old shape in a *later* change once nothing depends on it.
  One deploy must never require old and new code to agree on a shape
  that exists in only one of them.
- **Backward compatibility within a deploy.** A migration is deployed
  before, during, and after application code rolls out — every shape
  must be safe for both the old and new binary.
- Small, reviewable SQL. Read the generated migration before
  committing — ORM schema validity does not prove the SQL matches
  intent. One deliberate migration beats repeated generated churn.
- Never modify an already-applied migration file unless explicitly
  required and understood; never `db push` around the reviewed
  migration path.

## Data preservation

- **No destructive operations against production or preview data**
  without explicit approval — no `DROP`, `TRUNCATE`, mass `DELETE`,
  database resets, or restores that overwrite the only good copy.
- Test databases are disposable; development and shared databases are
  not. Verify which database a destructive test or reset targets
  *before* running it — a wrong `DATABASE_URL` destroys real work.
- Never copy production customer data into local/preview/test
  environments.
- For risky changes: identify the backup/snapshot and the rollback
  path before executing, and say what it is in the change report.

## Transactions and concurrency

- Writes that must succeed or fail together use **one transaction** —
  domain write + audit write + event disposition land atomically.
- External API/provider calls never run inside the transaction — lock,
  read, unlock, call, lock, apply.
- Read-then-write correctness under concurrency needs an explicit
  mechanism: transaction isolation, row locks, unique constraints, or
  atomic SQL — not "the code checks first".
- Long-running migrations on large tables need lock/timeout thinking:
  `CREATE INDEX CONCURRENTLY`-style strategies where the repo supports
  them; say so in the plan.

## Indexes and constraints

- Every new index carries a justification: the lookup it serves, why an
  existing index/constraint doesn't already cover it, and the
  write/storage cost. Indexes are not free; remove redundant ones.
- Unique constraints are business rules, not conveniences — encode
  only invariants that must hold, not fuzzy matching.

## Review checklist for a database change

- [ ] Invariant stated; enforcement chosen (constraint vs transaction vs both)
- [ ] Generated SQL reviewed and matches intent; no unintended drops/renames
- [ ] Expand/contract respected for any breaking shape
- [ ] Clean-database migrate AND already-migrated-database migrate verified
- [ ] ORM client regeneration + schema validation run
- [ ] Representative domain behavior tested post-migration
- [ ] Backup/rollback implications written down for risky operations
- [ ] Preview/staging implications identified
- [ ] No credentials, dumps, or production data anywhere in the diff
- [ ] Production-only actions explicitly deferred and called out in the report

## Hard boundary

Production migrations, resets, restores, and data rewrites run only
with explicit human authorization — never autonomously, even if a
production credential is reachable. Local disposable databases
(Docker Postgres, test schemas) are the experimentation surface.
