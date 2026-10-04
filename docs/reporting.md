# Reporting, exports, and the annual activity summary (issue #19)

SARbase provides **descriptive** reporting and organization-owned data
portability. It answers factual questions — how many incidents, how much
training, what was spent in which currency — and lets an organization
take its structured records out in documented, re-joinable CSV files.

It is deliberately **not** a BI system and **not** accounting software.
Nothing in this feature ranks volunteers, scores readiness, grades
response performance, predicts trends, or produces financial
statements. Reports state what was recorded; they never conclude what
it means.

## Architecture

```
src/lib/exports/csv.ts        RFC 4180 writer — quoting, typed cells,
                              formula-injection mitigation, UTF-8 BOM
src/lib/exports/filters.ts    query-param → validated ExportFilters,
                              audit-safe filter metadata
src/lib/exports/datasets.ts   EXPORT_DATASETS registry — one def per
                              dataset: filters, columns, org-scoped query
src/lib/exports/service.ts    runCsvExport: authz → rate limit → one
                              Repeatable Read transaction (rows + audit
                              insert) → serialize → filename
src/lib/reporting/summary.ts  getAnnualSummary: org-local-year queries
                              + pure aggregation helpers
src/app/api/organizations/[orgId]/exports/[dataset]/route.ts
src/app/admin/organizations/[orgId]/reports/page.tsx
```

Adding a record type to exports is one `DatasetDef` entry — routing,
authorization, audit, and serialization need no change.

## Authorization

Every export and the reports page require **ADMIN** access to the
organization. The `orgId` in the URL is an untrusted selector resolved
against persisted `OrganizationAccess` rows; foreign org, non-admin
caller, fabricated org id, and unknown dataset key all collapse to the
same opaque 404. Unauthenticated requests get 401. There is no
member-role export surface: bulk portable copies are more sensitive
than on-screen views.

## Export pipeline

`GET /api/organizations/{orgId}/exports/{dataset}?{filters}`:

1. Authenticate (`getAuthContext`).
2. Authorize (`requireOrgAdmin` — org-scoped, opaque denial).
3. Resolve the dataset definition (unknown → same 404).
4. Validate filters (`parseExportFilters`).
5. Consume one unit of export rate budget.
6. In a single **Repeatable Read** transaction: run the org-scoped
   query, enforce the row cap, insert the `DataExportEvent` audit row.
7. Serialize with the CSV writer and respond:
   `text/csv; charset=utf-8`, `Content-Disposition: attachment`,
   `x-content-type-options: nosniff`, `cache-control: private, no-store`.

**Fail closed on audit.** The `DataExportEvent` insert commits in the
same transaction as the reads. If the audit write fails the export
fails — no partial CSV, no unaudited download (covered by test).

**Snapshot consistency.** Repeatable Read means all rows in one export
reflect a single point-in-time snapshot. Different datasets are separate
exports and are **not** mutually consistent — take them close together
if cross-file consistency matters.

**Row cap.** `MAX_EXPORT_ROWS = 50_000` bounds in-memory generation.
Expected SARbase datasets are hundreds-to-thousands of rows; the cap is
a safety rail, not a quota. If a dataset ever approaches it, the right
fix is a bounded/streaming export, not a bigger number.

**Rate limiting.** 60 export requests per minute per (organization,
actor) via the shared fixed-window limiter. The bundled store is
per-process memory — a best-effort throttle on serverless, documented
as such in `src/lib/rate-limit/rate-limit.ts`.

## CSV format

| Property     | Behavior                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| Encoding     | UTF-8 **with BOM** (deliberate — Excel/LibreOffice need it to detect UTF-8; SARbase values are routinely non-ASCII) |
| Line endings | CRLF                                                                                                                |
| Quoting      | RFC 4180: cells containing `"`, `,`, CR, LF are quoted; embedded quotes doubled                                     |
| Header       | One row; declared column order is stable and documented                                                             |
| NULL         | Empty cell — an empty field always means "no value recorded"                                                        |
| Instants     | ISO 8601 UTC, e.g. `2026-10-03T14:22:00.000Z`                                                                       |
| Date-only    | `YYYY-MM-DD` — `@db.Date` values are never shifted through a timezone                                               |
| Numbers      | Plain integers/decimal strings, `.` separator, no grouping                                                          |
| Booleans     | `true` / `false`                                                                                                    |
| JSON fields  | Serialized JSON text in one cell (e.g. timeline `metadata`)                                                         |

### Formula-injection mitigation

Cells in `text` columns (human-entered values) that begin — possibly
after leading whitespace — with `=`, `+`, `-`, or `@`, or that begin
with a tab/CR/LF, get a leading `'` so spreadsheet applications treat
them as literals. This mitigation applies **only** to text cells: ids,
enums, numbers, dates, and timestamps are machine-generated and are
emitted verbatim so join keys and arithmetic are never corrupted.
Covered by `csv.test.ts`.

## Filter semantics

Filters arrive as query parameters. **A dataset only accepts the
filters it declares** — any other parameter is a 400 (`INVALID_FILTERS`)
rather than silently widening the export.

| Parameter             | Semantics                                                                                                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `from`, `to`          | Organization-local calendar dates (`YYYY-MM-DD`), inclusive. On `@db.Date` columns they compare as dates; on timestamp columns they translate to `[local midnight of from, local midnight of to+1)` through the organization's timezone — never naive UTC midnights. |
| `unit`                | A unit id of this org, or `org` for rows with no unit. A foreign/fabricated id matches nothing (it cannot widen scope).                                                                                                                                              |
| `vendor`              | Vendor id (expenses only); unknown ids match nothing.                                                                                                                                                                                                                |
| `status`              | `DRAFT`/`SUBMITTED`/`APPROVED`/`REJECTED` (expenses).                                                                                                                                                                                                                |
| `reimbursementStatus` | `NOT_REQUIRED`/`PENDING`/`REIMBURSED` (expenses).                                                                                                                                                                                                                    |
| `currency`            | ISO 4217 code (expenses).                                                                                                                                                                                                                                            |
| `category`            | Exact match on the recorded category text (expenses).                                                                                                                                                                                                                |

Which datasets accept which filters is visible on the reports page and
declared per-dataset in `datasets.ts`. Date filtering exists where a
meaningful business date exists: training events (`date`), inspections
and maintenance (`performedOn`), defects (`reportedOn`), meter readings
(`recordedOn`), callouts (`activatedAt`), incidents (record `createdAt`),
incident participants/assets (`recordedAt`), timeline (`occurredAt`),
notes/corrections/changes (`createdAt`), availability (`createdAt`),
invitations (`invitedAt`), attachments (`createdAt`), expenses
(`expenseDate`), expense events (`occurredAt`), expense changes and
export events (`createdAt`). Unit filtering exists where the record
carries a direct `unitId` (training events, assets, inventory items,
callouts) or a clear membership interpretation (members via
`MemberUnit`). Nothing else is arbitrarily attributed to a unit.

## Datasets

Every dataset exports stable ids (`id`, `organizationId`, and the
relevant foreign keys) so files can be re-joined relationally.
Human-readable names are additional columns, never substitutes for ids.
Column order is the declared order in `datasets.ts`.

| Dataset                                                     | Rows                                        | Filters                                                                        |
| ----------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `organization`                                              | The org record (id, name, timezone)         | —                                                                              |
| `units`                                                     | Units                                       | —                                                                              |
| `members`                                                   | Members incl. contact details               | `unit`                                                                         |
| `member-units`                                              | Membership rows                             | —                                                                              |
| `member-availability`                                       | Append-only availability statements         | `from`/`to`                                                                    |
| `member-notification-preferences`                           | Channel opt-ins per member                  | —                                                                              |
| `qualification-definitions`                                 | Qualification types                         | —                                                                              |
| `member-qualifications`                                     | Certificate records                         | —                                                                              |
| `training-events`                                           | Events incl. status + duration              | `from`/`to`, `unit`                                                            |
| `training-topics`                                           | Topic labels                                | —                                                                              |
| `training-attendance`                                       | Attendance rows                             | —                                                                              |
| `storage-locations`                                         | Locations incl. parent links                | —                                                                              |
| `assets`                                                    | Asset records                               | `unit`                                                                         |
| `inventory-items`                                           | Stock records                               | `unit`                                                                         |
| `inspection-definitions` / `inspection-records`             | Inspection types / occurrences              | — / `from`/`to`                                                                |
| `maintenance-plans` / `maintenance-records`                 | Plans / service events                      | — / `from`/`to`                                                                |
| `asset-meters` / `asset-meter-readings`                     | Meters / readings                           | — / `from`/`to`                                                                |
| `defects`                                                   | Defect records                              | `from`/`to`                                                                    |
| `callouts`                                                  | Callout records                             | `from`/`to`, `unit`                                                            |
| `callout-invitations`                                       | Invitations incl. raw response + timestamps | `from`/`to`                                                                    |
| `incidents`                                                 | Incident records incl. factual instants     | `from`/`to`                                                                    |
| `incident-participants` / `incident-assets`                 | Recorded participants / used assets         | `from`/`to`                                                                    |
| `incident-timeline`                                         | System timeline events                      | `from`/`to`                                                                    |
| `incident-notes`                                            | Human notes                                 | `from`/`to`                                                                    |
| `incident-note-corrections` / `incident-changes`            | Correction history                          | `from`/`to`                                                                    |
| `organization-documents` / `organization-document-versions` | Documents / version→attachment links        | —                                                                              |
| `attachments`                                               | File metadata incl. tombstoned rows         | `from`/`to`                                                                    |
| `attachment-links`                                          | One row per attachment↔record link          | —                                                                              |
| `vendors`                                                   | Vendor records                              | —                                                                              |
| `expenses`                                                  | Bookkeeping-friendly expense rows           | `from`/`to`, `vendor`, `status`, `reimbursementStatus`, `currency`, `category` |
| `expense-links`                                             | One row per expense↔record link             | —                                                                              |
| `expense-events` / `expense-changes`                        | Expense audit/correction history            | `from`/`to`                                                                    |
| `data-export-events`                                        | The export audit trail itself               | `from`/`to`                                                                    |

### Relationship representation

One-to-many links export as **relationship tables**, not packed cells:
`attachment-links` carries `(linkId, linkType, attachmentId, targetId)`
across all ten link tables plus document versions, and `expense-links`
carries `(linkId, linkType, expenseId, targetId, note)` across the five
expense link tables. `linkType` names the target's dataset
(`INCIDENT`, `TRAINING_EVENT`, `ASSET`, `MAINTENANCE_RECORD`,
`INVENTORY_ITEM`, `MEMBER_QUALIFICATION`, `INSPECTION_RECORD`,
`DEFECT`, `EXPENSE`, `INCIDENT_NOTE`, `DOCUMENT_VERSION`); `targetId`
joins to that dataset's `id` (to `documentId` for `DOCUMENT_VERSION`).

### Money

Expense rows carry `amountMinor` (exact integer minor units),
`currency` (ISO 4217), and `amount` (the exponent-aware decimal string
produced by `src/lib/money.ts` — `4215.38`, never a float). No currency
conversion exists anywhere; mixed currencies stay separate.

### Sensitive-column posture

Never exported: attachment `storageKey`, provider internals, signed
URLs, storage credentials, and callout `responseTokenHash` (a bearer
secret). `attachments` exports include tombstoned (`DELETED`) rows —
metadata history is honest; deletion removes the object, not the
record of it.

## Retrieving the actual files

CSV carries metadata only — binary content is never inlined. To
retrieve an attachment's bytes:

- The admin UI download path on each record's page, or the authorized
  route `GET /api/attachments/{attachmentId}/download` (ADMIN-scoped
  per attachment's own organization; streams bytes, never a public URL).
- Correlate files to records via `attachmentId` in `attachments.csv`
  and `attachment-links.csv`. `checksumSha256` verifies integrity of a
  retrieved copy; `storageProvider` identifies which backend holds it.
- Self-hosters with storage access may bulk-copy objects by storage
  key from the provider backend directly — `storageKey` is deliberately
  not in the CSV (implementation detail, not a portability contract);
  retrieve it from the `Attachment` table when scripting a
  storage-level export.

## Annual activity summary

`/admin/organizations/{orgId}/reports` renders a factual summary for a
selected **organization-local calendar year** (the org's configured
timezone — "2026" means Jan 1–Dec 31 in that zone). An optional unit
filter scopes the training section only; every other section is
organization-wide because those records carry no single unit.

| Section     | Exactly what is counted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Training    | `COMPLETED` events in-year; `CANCELLED` listed separately and never counted as attended. Recorded attendances = attendance rows on completed events. Total event duration = Σ `durationMinutes` over completed events that recorded one. **Recorded training participant-hours** = Σ (`durationMinutes` × attendance count) over completed events with a duration, in exact integer minutes displayed as hours. Events without a duration are counted (`eventsWithoutDuration`) but contribute no hours — no duration is invented. |
| Incidents   | Records whose `createdAt` falls in the local year, grouped by administrative status; recorded participant entries and recorded asset entries on those incidents.                                                                                                                                                                                                                                                                                                                                                                   |
| Maintenance | Maintenance records and inspection records performed in-year; defects reported in-year and defects resolved in-year (two independent dates); maintenance-record count per asset. No health/readiness verdicts.                                                                                                                                                                                                                                                                                                                     |
| Expenses    | In-year (`expenseDate`) counts by status and by reimbursement status; approved-expense totals grouped by currency; recorded-expense totals grouped by category+currency and vendor+currency. Integer minor-unit sums — currencies are never combined and nothing is presented as an accounting statement.                                                                                                                                                                                                                          |

Volunteer activity is deliberately limited to **recorded training
participant-hours**: it is the only duration-backed participation the
data model captures. Incident participation has no recorded duration
and callout timestamps are invitation/response facts, not hours — the
summary does not fabricate hours from either.

## Export audit history

Every generated export writes one `DataExportEvent` row in the same
transaction:

| Column                | Content                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `organizationId`      | Exported org                                                                                             |
| `actorAuthIdentityId` | Scalar identity id (#38 policy — survives identity deletion)                                             |
| `exportType`          | Dataset key, e.g. `expenses`                                                                             |
| `format`              | `csv`                                                                                                    |
| `filters`             | Normalized structured filters only (dates, ids, enum values) — free-text filter input is never persisted |
| `recordCount`         | Rows written                                                                                             |
| `createdAt`           | Instant                                                                                                  |

The exported file is never stored. Denied, invalid, and rate-limited
requests write no event. The audit trail itself is exportable
(`data-export-events` dataset).

## Logging & privacy

The route logs through `withApiObservability` — pathname only, never
query strings, bodies, or export content. The only durable record of an
export is the `DataExportEvent`.

## Consistency contract

Reports and exports share date/status semantics: the summary's year is
the same org-local range an export's `from`/`to` produce; `CANCELLED`
training is excluded from participation math in both; money is integer
minor units everywhere. Rows within one export are a consistent
snapshot; separate exports are separate snapshots.

## Deliberately out of scope / deferred

- No ZIP/archive format — per-dataset CSVs + the documented
  per-attachment download path cover portability without a bespoke
  bundle format. A future bulk export can reuse `EXPORT_DATASETS`.
- No member-visible exports, no scheduled/background export jobs
  (the registry is the seam), no streaming format (row cap is honest
  about the in-memory bound).
- No charts, dashboards, rankings, or trend analysis.
- Issue #20 will verify end-to-end portability and release posture;
  nothing here preempts that audit.
