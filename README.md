# SARbase

**Open-source operations and records for volunteer search and rescue organizations.**

SARbase helps volunteer marine search and rescue organizations manage the information surrounding their operations: people, training, qualifications, equipment, maintenance, callouts, incident records, expenses, receipts, and organizational history.

The goal is simple: make it easier for volunteer SAR organizations to stay organized, notify their crews, maintain reliable records, and find important information when they need it.

## What SARbase is

SARbase is an administrative, notification, and recordkeeping system.

It is designed to help organizations answer questions such as:

- Who is currently available?
- Who responded to a callout?
- When was an incident opened, and what happened afterward?
- When does a crew member's certification expire?
- Who has been participating in training?
- When was a piece of equipment last inspected?
- When is its next inspection due?
- Where is a particular piece of equipment stored?
- What maintenance has been performed on a vessel?
- Where did we buy that replacement part?
- Is there a receipt for it?
- What records do we have from an incident several years ago?

SARbase is intended to become an organization's durable operational memory.

## What SARbase is not

**SARbase does not practice search and rescue.**

It does not provide search planning, navigation guidance, rescue tactics, operational recommendations, launch decisions, or command decisions.

SARbase records information and helps people communicate. Qualified SAR personnel remain responsible for all operational decisions.

The organization defines its procedures and requirements. SARbase helps remember, organize, communicate, and document them.

## Planned capabilities

### People

- Volunteer and staff records
- Contact information
- Roles
- Availability and on-island/off-island status
- Qualifications and certifications
- Certification expiry dates
- Training history

### Callouts

- Create an incident
- Notify crew
- Allow volunteers to respond as available or unavailable
- Track responses
- Automatically record important timestamps
- Preserve a callout history

### Incidents

- Incident details
- Participating personnel
- Vessels and equipment used
- Timeline
- Operational notes
- Attachments
- After-action notes
- Review and closure
- Audit history

### Training

- Training events
- Attendance
- Training topics
- Notes and supporting documents
- Participation history
- Visibility into inactive or infrequently participating members

### Vessels and equipment

- Vessels, engines, trailers, radios, safety equipment, and other assets _(basic records implemented)_
- Equipment locations _(hierarchical storage implemented)_
- Inspection history
- Next inspection dates
- Expiration dates
- Condition and status
- Defects
- Maintenance and repair history
- Manuals and supporting documents

### Maintenance

- Maintenance records
- Inspections
- Defects
- Repairs
- Parts and materials
- Related expenses and receipts
- Service dates and intervals

### Expenses

- Volunteer receipt submission
- Vendors
- Expense categories
- Reimbursement status
- Receipt and invoice attachments
- Relationships to incidents, training, assets, maintenance, and equipment
- Bookkeeping exports

SARbase is not intended to replace accounting software.

### Records and search

Search across the organization's history to find incidents, people, equipment, maintenance, purchases, vendors, notes, and other records.

A question such as "Where did we buy that 3/8 line for Gary?" should not require searching old messages or relying on somebody's memory.

### Reminders

SARbase can help surface factual administrative deadlines such as:

- Certification expiration
- Equipment inspection dates
- Flare expiration
- Scheduled maintenance
- Document renewal

These reminders do not constitute an assessment of operational readiness.

## Designed for organizations of different sizes

SARbase is being designed around organizations and units rather than a particular island or rescue service.

A small volunteer unit should be able to use it without unnecessary complexity, while the underlying model should allow multiple units or organizations to adopt it independently.

The first implementation is being developed with volunteer marine SAR operations in mind.

## Project principles

**Simple during an emergency.**  
Administrative software should not get in the crew's way.

**Humans make operational decisions.**  
SARbase organizes information. It does not determine how a rescue should be conducted.

**Keep the history.**  
Important records should have an auditable history so corrections do not silently rewrite the past.

**Make information easy to find.**  
Records have little value if nobody can retrieve them later.

**Own your data.**  
Organizations should be able to export their records and attachments.

**Avoid unnecessary lock-in.**  
External services should be replaceable where practical.

**Build from real needs.**  
Features should solve problems experienced by actual SAR organizations rather than speculative requirements.

**Keep it accessible to volunteers.**  
SARbase should not require an IT department to operate.

## Technology

SARbase is built as a modern web application using:

- Next.js
- TypeScript
- PostgreSQL
- Prisma
- React
- Tailwind CSS

The project is based on the [`app-foundations`](https://github.com/spizeck/app-foundations) `next-neon` baseline — production-tested open-source application foundations — and is designed to support self-hosted deployments. Foundation code is copied in at creation time; SARbase does not depend on `app-foundations` at runtime.

### Foundation capabilities already implemented

Inherited from the foundation baseline, working today:

- TypeScript strict mode, ESLint, Prettier, Node 24
- Structured JSON logging with field/pattern redaction (`src/lib/logging.ts`)
- Feature-gated security headers including CSP (`src/lib/security/headers.ts`)
- API route wrapper with request IDs and safe error envelopes (`src/lib/api.ts`)
- `/api/health` liveness endpoint with a real database check
- Lazy per-concern environment validation (`src/lib/env.ts`)
- Prisma + Postgres migration pipeline: guarded deploys inside the Vercel build, migration replay and schema-drift checks in CI, isolated `*.db.test.ts` database tests
- Guarded logical backups and a local restore drill (`scripts/`)
- Playwright smoke + axe accessibility suites
- Optional modules already copied in: Sentry observability (privacy-scrubbed, disabled without a DSN — `src/lib/observability/`) and a fixed-window rate limiter with a pluggable store (`src/lib/rate-limit/`)

### Domain functionality already implemented

- Core records: **Organization → Unit → Member**, with an internal admin UI (`/admin`) for editing organizations and managing units and member contact details; member activation/deactivation; unit assignment; and identity linking. Organization creation and first-admin grants are operator-provisioned via `npm run admin:provision` (see `docs/domain-model.md`)
- **Authentication and organization-scoped authorization**: Firebase Auth → server-verified HTTP-only session cookie; separate `AuthIdentity` login model linked to `Member` records; explicit `OrganizationAccess` grants with `MEMBER`/`ADMIN` roles; centralized server-side authorization helpers; admin bootstrap via `npm run admin:provision` (see `docs/authentication.md`)
- Sign-in/sign-out UI plus an `/account` page showing identity, linked member records, granted organization access, and the member's own qualification records
- **Qualifications and certifications**: organization-defined qualification definitions (active/inactive lifecycle), append-only member certificate records with issue/expiry dates, issuer and reference, deterministic expiry-state labels, and upcoming-expiry admin views — factual records only, with same-organization integrity enforced by composite foreign keys (see `docs/domain-model.md`)
- **Training events and attendance**: organization training events with date/duration/location/instructor/topics, member attendance history, factual "last attended" summaries, and a read-only personal training view on `/account` — administrative records only, never an operational-readiness conclusion
- **Assets, inventory, and storage locations**: durable assets (boats, engines, radios — serial/tag/manufacturer/model, purchase date, recorded condition and lifecycle status), quantity-tracked stock items (exact decimal quantity + unit of measure), and arbitrarily nested storage locations — including lockers inside a vessel asset — plus physical parent-child asset containment. Admin-managed, same-organization integrity enforced by composite foreign keys; the location container XOR is also a database CHECK constraint, and containment writes serialize per organization on a Postgres advisory lock so concurrent placements can't race a cycle into the graph (see `docs/domain-model.md`). Status and condition are recorded facts only — SARbase never infers readiness or safety from them
- **Inspections, maintenance, meters, and defects**: organization-defined inspection types with calendar recurrence, append-only inspection occurrences, per-asset maintenance plans (calendar or meter intervals), append-only service history, generic asset meters with append-only readings, and a defect report/resolve/reopen lifecycle with immutable `DefectChange` history. Due dates and meter thresholds are computed facts in the organization's own timezone ("due 2026-10-15", "overdue by 12 days", "due at 912.4 hours") — never readiness or safety conclusions; defects never silently change asset status (see `docs/domain-model.md`)
- **Member availability and contact preferences**: member-controlled availability statements (`AVAILABLE`, `UNAVAILABLE`, `OFF_ISLAND`, `UNKNOWN`) with an optional "until" date that expires at local midnight in the organization's timezone and falls back to `UNKNOWN` — never inferred back to `AVAILABLE`. Append-only `MemberAvailabilityUpdate` history preserves every statement with actor attribution and self-reported vs admin-entered provenance; per-member `MemberNotificationPreference` rows record email/SMS/WhatsApp/push willingness (destinations stay on the member record). Volunteers self-serve on `/account` only while a live `OrganizationAccess` row exists; admins view an org-wide current-status overview and record on members' behalf (see `docs/domain-model.md`)
- **Notification delivery records**: a provider-neutral notification seam with a real email provider (Resend) and a deterministic in-process fake for tests and credential-free development. Every request is a durable, org-scoped, idempotent `Notification` row — destination snapshot, intent hash, scalar actor attribution — and every provider invocation appends a `NotificationAttempt` row (provider message id, normalized status, safe error summary). Member email preferences are enforced before dispatch (`SUPPRESSED`, never disguised as failure), `ACCEPTED` honestly means provider-accepted rather than delivered, and retries append new attempts rather than overwriting history. Admin history + labeled test-send at `/admin/organizations/{orgId}/notifications` (see `docs/notifications.md`). Delivery state is a factual record — never an operational readiness or response conclusion.
- **Callouts and volunteer responses**: one-action callout activation that materializes the invited audience (organization, unit, or selected members) as durable `CalloutInvitation` rows — later roster changes never rewrite who was invited. Each invitee gets an email through the notification seam with a high-entropy hashed-at-rest response token linking to `/respond` (no sign-in needed, mobile-friendly `COMING`/`UNAVAILABLE` controls); authenticated members can also respond on `/account`, and admins can record responses on a member's behalf (e.g. a phone call) with honest `ADMIN` provenance. Responses serialize on the callout row lock into an append-only `CalloutResponseChange` history, invitation vs notification status stay separate facts, and an explicit admin close makes everything read-only. SARbase records who was invited and how they responded — it never concludes crew sufficiency, readiness, or dispatchability (see `docs/callouts.md`).
- **Incident records, timeline, notes, and audit history**: a durable, organization-scoped `Incident` (human-facing `INC-<n>` reference, `DRAFT`/`OPEN`/`CLOSED` lifecycle, factual `reported`/`departed`/`on-scene`/`returned` instants entered in the organization's timezone) optionally linked one-to-one to a callout or created manually. Participation in members and assets is an explicit recorded fact — never inferred from callout RSVP. System `IncidentTimelineEvent` rows capture lifecycle, linkage, and participant actions; human-authored notes (`GENERAL`/`AFTER_ACTION`/`CLOSING`) are attributed, timestamped, and corrected only through append-only `IncidentNoteCorrection` history; material field edits write typed before/after `IncidentChange` audits — on closed incidents a correction reason is required and the record stays closed unless a human explicitly reopens it. The whole surface is ADMIN-only (see `docs/incidents.md`).
- **Attachments and organizational documents**: provider-neutral file storage (local, S3, or in-memory) behind a single `Attachment` record with org-scoped link rows onto incidents, notes, qualifications, training events, assets, inspections, maintenance, defects, and expenses — plus versioned organizational documents. Files stay private behind authorized downloads; mutations on protected records (closed incidents, approved or reimbursed expenses) require a recorded reason, and deletes tombstone rather than erase (see `docs/attachments.md`).
- **Vendors, expenses, receipts, and reimbursements**: lightweight organization-scoped financial records answering where something was bought, what it cost, what it was for, whether a volunteer paid personally, and whether that reimbursement has been recorded. Vendors are simple contact/reference records (active/inactive, never deleted). Expenses store exact money — integer minor units plus an ISO 4217 currency, never floating point — on an org-local calendar date, move through a small `DRAFT`/`SUBMITTED`/`APPROVED`/`REJECTED` lifecycle, and track reimbursement on a separate `NOT_REQUIRED`/`PENDING`/`REIMBURSED` axis. Context links connect an expense to any combination of incidents, training events, assets, maintenance records, and inventory items with same-organization composite-FK integrity; receipts and invoices attach through the shared provider-neutral storage pipeline. Corrections on approved or reimbursed records require a reason and write typed before/after `ExpenseChange` audits alongside the append-only `ExpenseEvent` feed. **SARbase is recordkeeping software, not accounting software** — nothing here moves money, balances books, or processes payments (see `docs/expenses.md`).

### Not yet implemented

Background jobs (including automatic notification retries and provider delivery webhooks), additional notification channels (SMS/WhatsApp/push), and the remaining SAR domain functionality (search, reporting) are **planned, not built**. `/admin` requires an authenticated identity with an explicit `ADMIN` grant for the target organization. Qualification, equipment, and maintenance records state facts only — they never conclude SAR operational readiness.

## Status

SARbase is currently under initial development.

The data model and interfaces may change significantly before the first stable release. It should not yet be relied upon as the sole repository for operational records.

## Contributing

Contributions are welcome.

SARbase is intended to be shaped by the real needs of volunteer search and rescue organizations. Bug reports, feature requests, documentation improvements, translations, accessibility improvements, and code contributions are all valuable.

Operational SAR doctrine is outside the scope of the project. Proposed features that attempt to provide search planning, rescue tactics, navigation guidance, or operational decision-making may be declined even when technically feasible.

## Development

SARbase is a standard Next.js application. Requirements: Node 24 (see `.nvmrc`) and Docker (or any local Postgres) for the development database.

```bash
npm install
cp .env.example .env.local       # fill in the documented values
docker compose up -d             # local Postgres on :5433
npm run db:migrate:deploy        # apply migrations
npm run db:seed                  # synthetic seed rows
npm run db:restore-drill -- --target development --confirm
                                 # prove dump→restore works locally
npm run dev
```

Verification (the same gates CI enforces):

```bash
npm run check          # format, lint, typecheck, unit tests, production build — needs no env values
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/sarbase_test npm run test:db
npm run test:e2e       # Playwright smoke + accessibility suite
```

The database environment/migration contract — pooled vs unpooled URLs, expand/contract discipline, preview isolation, backup posture — is documented in [`docs/database.md`](docs/database.md). Operator recovery procedures live in [`runbooks/database-backup-restore.md`](runbooks/database-backup-restore.md). Architectural principles are in [`docs/architecture.md`](docs/architecture.md). File storage, attachments, and organizational documents are covered in [`docs/attachments.md`](docs/attachments.md).

## Security

Please do not publicly disclose vulnerabilities involving authentication, authorization, personal information, incident records, or other sensitive data.

See [`SECURITY.md`](SECURITY.md) for the reporting process.

## License

SARbase is free and open-source software licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

See `LICENSE` for the complete license terms.
