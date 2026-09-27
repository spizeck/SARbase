# Database backup, restore, and recovery

Canonical recovery posture for applications on Neon/Postgres (the
`next-neon` template's operating model). Written for operators and
agents: concrete steps, explicit never-do rules, verification after
every action.

Provenance: generalized from Sea Saba Platform's
`docs/BACKUP_AND_RECOVERY.md` — the most mature recovery document in the
portfolio — with domain specifics removed.

## Recovery architecture

Neon provides the recovery primitives; the application controls how and
when they are invoked.

| Capability                                | What it does                                                                                                                        | Operator notes                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Point-in-time restore ("Instant restore") | Reverts a **root branch** to an earlier state within the history window; Neon keeps the pre-restore state as `main_old_<timestamp>` | Only root branches support PITR — verify production is a root branch before you need it                |
| Manual/scheduled snapshots                | Point-in-time copies restorable to a **new branch** (non-destructive)                                                               | Snapshot before risky migrations; availability and count depend on plan                                |
| Branches                                  | Copy-on-write clones, creatable from a historical point within the window                                                           | Recovery drills and preview databases                                                                  |
| History window / Time Travel              | Read-only historical queries within the window                                                                                      | Inspect before restoring — window length is plan-dependent (hours on free tier, up to 30 days on paid) |
| `pg_dump` / `pg_restore`                  | Logical export/import you control                                                                                                   | Vendor-independent, longer retention, restore drills                                                   |

Verify the actual plan's history window, snapshot limits, and scheduled
snapshot availability in the Neon console — do not rely on any document
as a guarantee.

## Decision table

| Scenario                                          | Recommended approach                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| Accidental row/table damage within history window | Instant restore, or a Time Travel query to confirm the pre-incident state first |
| Schema damage within history window               | Restore to a **new branch**, validate, then switch traffic                      |
| Recovery point beyond the history window          | Snapshot or `pg_dump` backup                                                    |
| Vendor/account-level risk                         | `pg_dump` in operator-controlled encrypted storage                              |
| Pre-migration safety net                          | Manual snapshot + `pg_dump`                                                     |
| Recovery drill                                    | `pg_dump`/`pg_restore` into an isolated database or a new branch                |

RPO/RTO targets are operational targets, not vendor SLAs. Choose a Neon
plan whose history window and snapshot capability actually meet your
targets, and never promise narrower than what the current plan plus this
runbook can deliver.

## Production recovery runbook

Every step is mandatory unless the incident commander explicitly waives
it.

1. **Freeze application writes.** Enable maintenance mode or take the
   deployment read-only to stop further corruption.
2. **Identify scope and last known-good point.** Schema, table, rows, or
   whole branch; approximate timestamp/LSN before the incident. Inspect
   with a Time Travel query or a historical branch before restoring.
3. **Preserve the damaged state.** Do not destroy the production
   branch — Instant restore auto-creates `main_old_<timestamp>`;
   otherwise snapshot/branch the damaged state first.
4. **Recover into a separate target first.** Restore to a new branch or
   recovery database; validate there before anything touches
   production traffic.
5. **Validate schema and data.** `prisma migrate status` consistent,
   expected tables/indexes present, representative records spot-checked.
6. **Reconcile critical records.** Compare payment/ledger totals against
   providers, verify document/signature integrity, check audit-log
   continuity, and decide how to re-enter records created between the
   last known-good point and the restore point.
7. **Switch traffic only after validation passes** and the incident
   commander approves; update `DATABASE_URL`/related env vars if the
   target is a new branch.
8. **Rotate credentials if compromise is suspected** — Neon password,
   Vercel env vars; review Neon and deployment audit logs.
9. **Verify application health.** Smoke tests against the recovered
   database; watch error rates, auth, and critical flows.
10. **Record the incident.** Root cause, recovery point, validation
    results, reconciliation gaps, lessons; update this runbook if a step
    was unclear.

### Never do

- Do not reset production unless there is no other path and the decision
  is documented.
- Do not run `prisma migrate dev`, `migrate reset`, or `db push` against
  production during an incident.
- Do not restore directly over the only copy of production without
  preserving the damaged state.
- Do not copy production customer data into preview/dev environments.
- Do not run a destructive migration during recovery without a snapshot
  and a rollback plan.

## Independent logical backups

Neon's PITR is convenient but does not cover vendor independence,
long-term retention beyond the history window, or account-level risk.
Any backup tooling must:

- require an explicit `--target` and `--confirm`;
- refuse production targets/environment signals unless a deliberate
  `--force-production` flag is passed;
- prefer the direct (`DATABASE_URL_UNPOOLED`) connection;
- validate the connection string and reject placeholder values;
- never print credentials (redact passwords in logged commands);
- write timestamped artifacts to encrypted, operator-controlled storage
  with a documented retention policy.

## Restore drills

A backup is unproven until a restore drill passes. A drill must:

1. Target a disposable database only (local Docker, a dedicated drill
   database, or a clearly-labeled Neon branch) — never production, and
   refuse production-like environment signals.
2. Apply migrations, insert identifiable synthetic records.
3. Back up, delete the synthetic records, restore.
4. Verify the records are recovered and `prisma migrate status` is
   consistent.
5. Clean up the drill database and artifacts.

A restore is not successful because PostgreSQL accepted the file — it is
successful when migrations are consistent, expected records exist, and
an application can connect (in a non-production environment).

## Go-live gate

Before real customer data is stored:

- [ ] Neon plan's history window and snapshot capability verified
      against the RPO/RTO targets.
- [ ] Production branch confirmed as a root branch (PITR-eligible).
- [ ] Scheduled snapshots or a `pg_dump` workflow to durable encrypted
      storage configured, with a documented retention policy.
- [ ] At least one local and one branch-level restore drill passed and
      documented.
- [ ] On-call staff trained on this runbook.
