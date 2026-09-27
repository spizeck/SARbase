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

- Vessels, engines, trailers, radios, safety equipment, and other assets
- Equipment locations
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

### Not yet implemented

Authentication, authorization, notifications, attachments, audit history, background jobs, and all SAR domain functionality (members, callouts, incidents, equipment, expenses, search) are **planned, not built**. The single `BootstrapItem` table exists only to prove the migration pipeline; the real schema will be designed in a dedicated issue.

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

The database environment/migration contract — pooled vs unpooled URLs, expand/contract discipline, preview isolation, backup posture — is documented in [`docs/database.md`](docs/database.md). Operator recovery procedures live in [`runbooks/database-backup-restore.md`](runbooks/database-backup-restore.md). Architectural principles are in [`docs/architecture.md`](docs/architecture.md).

## Security

Please do not publicly disclose vulnerabilities involving authentication, authorization, personal information, incident records, or other sensitive data.

See [`SECURITY.md`](SECURITY.md) for the reporting process.

## License

SARbase is free and open-source software licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

See `LICENSE` for the complete license terms.
