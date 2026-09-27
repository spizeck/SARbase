# Architecture principles

These principles guide SARbase's design. They are commitments, not yet
complete implementations — each describes a direction the codebase will
grow toward as features land.

## The operational boundary

**SARbase records facts; humans make SAR decisions.**

SARbase is an administrative, notification, and recordkeeping system. It
must never provide search planning, search patterns, drift calculations,
navigation guidance, rescue tactics, operational recommendations, risk
scoring, launch/go/no-go recommendations, minimum-crew conclusions,
command decisions, or automated assessments of operational readiness.

The application may record and display factual information. Qualified SAR
personnel remain responsible for all operational decisions. Proposed
features that cross this boundary are declined even when technically
feasible.

## Principles

1. **Facts, not decisions.** The system records what happened, who was
   notified, what was said, and when. It does not conclude what anyone
   should do.

2. **Auditable records.** Important records keep material history.
   Authorized corrections are allowed, but corrections must not silently
   rewrite the past — durable history belongs in database-backed audit
   records, not log streams. (Audit-history infrastructure is not built
   yet; it is a prerequisite for the record types that need it.)

3. **Organizations and units, not islands.** The data model should
   eventually support multiple organizations/units adopting SARbase
   independently, without hardcoding Saba or any single rescue service.
   This is a modeling constraint, not a promise of federation or
   multi-tenant hosting.

4. **Attachments are first-class records.** Files (receipts, certificates,
   incident documents, manuals) will have metadata and relationships to
   the records they belong to — not opaque blob fields bolted on later.
   Attachment infrastructure is not built yet.

5. **Search is a core capability.** Records have little value if nobody
   can retrieve them. "Where did we buy that 3/8 line?" should be a query,
   not a memory test. Search design follows the domain schema.

6. **Replaceable providers.** External services sit behind reasonably
   clean boundaries where practical, so an organization can swap a
   database host, notification provider, or file store without rewriting
   the application.

7. **Data portability.** Organizations must be able to export their
   records and attachments in usable form. Owning your data includes
   being able to leave.

8. **Build from demonstrated needs.** Features are justified by problems
   real SAR organizations experience — not by speculative complexity.
   The schema and modules land when the need lands.

## Foundation

The technical baseline comes from
[app-foundations](https://github.com/spizeck/app-foundations)
(`templates/next-neon`, copied — not linked). See the README's
"Foundation capabilities already implemented" list for what exists
today, and `docs/database.md` for the database/migration contract.
