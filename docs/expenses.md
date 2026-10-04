# Vendors, expenses, receipts, and reimbursements (issue #17)

A **vendor** is a simple record of where the organization buys things.
An **expense** is the durable record of a purchase: what it cost, when,
from whom, what it was for, whether a volunteer paid out of pocket, and
whether that reimbursement has been recorded — together with its
receipts and the audit history of every later change.

> SARbase is recordkeeping software, **not accounting software**. It
> does not implement a general ledger, chart of accounts, journal
> entries, bank reconciliation, tax handling, invoicing, payroll,
> double-entry bookkeeping, or financial statements. Nothing here moves
> money: there are no banking, payment-processing, or reimbursement
> integrations — and there never will be inside this feature. Approval
> records a human's review decision; "reimbursed" records a human's
> statement that repayment happened. Exports and reporting are a
> separate feature (issue #19).

## Money — exact, never floating point

`src/lib/money.ts` is the only way amounts enter or leave the record:

- `Expense.amountMinor` is an **integer count of minor units** — USD
  42.15 is stored as `4215`, JPY 1900 as `1900`, KWD 1.500 as `1500`.
- `Expense.currency` is an uppercase **ISO 4217** code validated
  against the full active-code table in `src/lib/money.ts`, grouped by
  each currency's real minor-unit exponent (JPY 0, most 2, KWD 3,
  CLF/UYW 4; codes with no minor unit such as XDR are not supported).
  Unknown codes are rejected, not guessed.
- Amounts are entered as display text (`"42.15"`) and parsed to minor
  units by `parseMoneyAmount`. Fractional digits beyond the currency's
  exponent (`"12.345"` USD), zero, and negative values are rejected —
  an expense of zero records nothing and negative "expenses" are not a
  concept here. (Credits are out of scope: see deferred work.)
- There is exactly one currency per expense and **no FX conversion,
  ever**. Listing and any future export keep amounts grouped by
  currency rather than fabricating a total.
- JavaScript `number` never holds a display amount — only the integer
  minor units, which are exactly representable.

## Dates

`expenseDate` is an **organization-local calendar date** (`@db.Date`),
not an instant — "the purchase happened on 15 March" in the
organization's own calendar, entered `YYYY-MM-DD` and pinned to UTC
midnight so the stored day can never shift across server timezones.
Submission, review, and reimbursement stamps (`submittedAt`,
`reviewedAt`, `reimbursedAt`, `recordedAt`) are true instants displayed
in `Organization.timezone`.

## `Vendor` — where the organization buys things

Organization-scoped; deliberately a contact reference, not a CRM and
not a purchasing workflow:

- `name` — not unique. Two branches of the same supplier may share a
  name legitimately; `accountReference` (the organization's
  customer/account number) is the disambiguator.
- `contactName`, `email`, `phone`, `website`, `accountReference`,
  `notes` — institutional memory for later search (issue #18).
- `status` — `ACTIVE` / `INACTIVE`. Vendors are **never deleted**:
  deactivating stops new spending from being recorded against them
  (the domain rejects inactive vendors on create, and rejects
  corrections that would _assign_ one — a correction that merely keeps
  the already-attached vendor stays legal, since that vendor was valid
  when the expense was recorded) while leaving their history on the
  expenses they already have.
- Do not store bank details or payment credentials in vendor fields —
  a vendor is a contact record, not an account.

## `Expense` — the record

Organization-scoped. Fields:

- `reference` — human-facing `"EXP-<n>"` allocated from the
  per-organization `ExpenseSequence` row inside the creation
  transaction (`@@unique([organizationId, reference])`). Concurrent
  creations can never mint the same reference.
- `expenseDate`, `amountMinor`, `currency` — as above.
- `vendorId` — optional, composite-FK to `Vendor` in the same
  organization; must be ACTIVE at write time.
- `category` — optional free text. SARbase imposes **no accounting
  taxonomy**; the admin UI offers the organization's previously used
  categories as hints (Fuel, Maintenance, Equipment…) via a datalist.
- `description` — what the purchase was for.
- `submittedByMemberId` — which member submitted the expense, if any.
- `paidByMemberId` — which member paid **personally** (out of pocket).
  Null means the organization paid directly.
- `status` — the record lifecycle (below).
- `reimbursementStatus` — the repayment axis (below), deliberately
  separate from review.
- `submittedAt`; `reviewedAt`, `reviewedByAuthIdentityId`, `reviewNote`;
  `reimbursedAt`, `reimbursedByAuthIdentityId`, `reimbursementNote` —
  stamped instants and scalar actor ids for each recorded fact.
- `createdByAuthIdentityId`, `createdAt`, `updatedAt`.

## Record lifecycle — `Expense.status`

Small and auditable; it describes the state of the _record_, not of
any payment:

- **DRAFT** — being assembled. Freely editable; submission is a choice.
- **SUBMITTED** — presented for review.
- **APPROVED** — a reviewer accepted the record. Terminal: corrections
  go through the audited correction path, never a reopen.
- **REJECTED** — a reviewer rejected it **with a required note** — the
  reason is the point of rejecting. Rejection keeps the record; it can
  return to DRAFT for rework.

Allowed edges (validated server-side on a row lock; each writes a
`STATUS_CHANGED` event): `DRAFT → SUBMITTED|APPROVED|REJECTED`,
`SUBMITTED → APPROVED|REJECTED|DRAFT`, `REJECTED → DRAFT`. Transitioning
to the current status is a quiet no-op, so double-submits and racing
decisions write no duplicate history. Review stamps are written on
APPROVED/REJECTED and cleared on return to DRAFT — the event feed keeps
the originals.

## Reimbursement — a separate factual axis

`reimbursementStatus` tracks whether a **personally paid** expense has
been repaid. It is deliberately not folded into `status`: approval and
repayment are different facts, and most expenses (organization-paid)
never enter the axis.

- `NOT_REQUIRED` — the organization paid; nothing is owed.
- `PENDING` — a member paid out of pocket and is owed the money.
- `REIMBURSED` — an admin recorded that repayment happened, with
  `reimbursedAt`/`reimbursedByAuthIdentityId`/optional note.

Rules:

- Setting `PENDING` or `REIMBURSED` requires `paidByMemberId` — a
  reimbursement needs the member who is owed. Corrections can't strip
  the payer off an expense that still shows a pending/reimbursed state.
- `REIMBURSED` is only reached through `setExpenseReimbursement` —
  never by inference from the payer field, and never at creation time
  beyond `PENDING`.
- Un-marking `REIMBURSED` requires a note — reversing a recorded fact
  says why. The stamp clears; the `REIMBURSEMENT_CHANGED` events keep
  who recorded it and when.
- Only full-expense reimbursement is modeled — the expense's own
  `amountMinor` is the amount owed. No partial-repayment splitting
  (deferred; see below).
- **This records a fact; it does not process a payment.**

## Context links — what the purchase was for

An expense may relate to several operational records at once — "engine
oil + filter" can point at the vessel _and_ its 100-hour service
record. Five typed link tables implement this with full database
integrity instead of a polymorphic `(type, id)` pair:

`ExpenseIncident`, `ExpenseTrainingEvent`, `ExpenseAsset`,
`ExpenseMaintenanceRecord`, `ExpenseInventoryItem`.

Each link row:

- carries denormalized `organizationId` and binds **both** ends through
  composite foreign keys (`expenseId + organizationId`,
  `targetId + organizationId`) — a cross-organization link is
  impossible at the database level, and the domain re-validates the
  target inside the transaction so a foreign or fabricated id fails
  opaquely before that;
- is unique per `(expenseId, targetId)` — a concurrent or repeated link
  is a loud `ExpenseDuplicateLinkError`, never a double row;
- records `recordedByAuthIdentityId`, `recordedAt`, and an optional
  factual `note` ("consumables for this service");
- writes `CONTEXT_LINKED` / `CONTEXT_UNLINKED` expense events whose
  metadata snapshots the target's label — the audit sentence stays
  accurate even if the record is renamed later.

## Receipts and files — shared attachment pipeline

Receipts, invoices, credit memos, and supporting photos are ordinary
`Attachment` rows (issue #16) linked through `ExpenseAttachment` — the
same provider-neutral storage (local / S3 / in-memory), the same
validation, private authorized downloads, tombstone deletes, and
append-only `AttachmentEvent` history. Nothing expense-specific was
duplicated.

- Multiple files per expense are supported; none is "the" receipt.
- `entityType: "EXPENSE"` resolves through the attachment domain's
  entity table — a foreign or fabricated expense id fails opaquely and
  the composite FK makes a cross-org link impossible.
- Every upload/unlink/delete mirrors an `ATTACHMENT_ADDED` /
  `ATTACHMENT_REMOVED` event onto the expense's own feed.
- **Protected records**: on an APPROVED expense or one already
  REIMBURSED, uploading, unlinking, or deleting a file requires a
  recorded `reason` — financial evidence never silently disappears.
  The rule is enforced in the domain (`requiresReason` on the resolved
  entity), not just the UI.

## Audit history — append-only, two records deep

Two tables, written in the same transaction as every change so a
mutation cannot commit without its history:

- `ExpenseEvent` — the system feed: `EXPENSE_CREATED`,
  `STATUS_CHANGED`, `REIMBURSEMENT_CHANGED`, `CONTEXT_LINKED`,
  `CONTEXT_UNLINKED`, `ATTACHMENT_ADDED`, `ATTACHMENT_REMOVED`,
  `CORRECTION_RECORDED`. Each row records `occurredAt` (when the thing
  happened), `createdAt` (when it was written), the scalar
  `actorAuthIdentityId`, and typed metadata.
- `ExpenseChange` — the material correction audit. One row per
  correction carrying **typed before/after columns** for every material
  field (date, amount, currency, vendor, category, description,
  submitter, payer) plus the optional `reason` and the actor. A
  submission that changes nothing writes no row and no event.

Correction rules:

- DRAFT / SUBMITTED / REJECTED — edits are free; a change is recorded
  whenever material fields actually move.
- APPROVED or REIMBURSED — the same edits additionally **require a
  reason** (`ExpenseCorrectionReasonError` otherwise). The status and
  reimbursement stamps are never silently reset by a correction — if
  the purchase needs re-review a human performs an explicit act, not an
  automatic side effect.

## Actor attribution — scalar ID policy

`actorAuthIdentityId` on events, changes, links, and review/
reimbursement stamps is a **scalar id without a foreign key** —
history must survive identity deletion. Display resolves best-effort
(member display name → identity email → raw id) at read time and never
rewrites the stored id. Actor values always come from the
server-verified session; client-supplied actor fields are ignored.

## Authorization — financial data is sensitive

Every vendor and expense surface — pages and server actions — is
**ADMIN-only**:

- Unauthenticated callers redirect to sign-in; members and
  no-access identities get an opaque "Not found".
- Record-scoped actions (`updateExpense`, `transitionExpense`,
  `setExpenseReimbursement`, link add/remove, vendor edits, attachment
  mutations) resolve the target's **own** `organizationId` from the
  database and verify the caller's `OrganizationAccess` grant against
  it — a URL, form, or hidden-field `organizationId` only selects which
  grant must exist.
- A foreign or guessed id is indistinguishable from a nonexistent one
  (same `AuthorizationError` → "Not found", verified by the IDOR
  tests).
- Receipt downloads inherit the expense's ADMIN-only grant through the
  attachment target resolution.
- MEMBER self-service (volunteers submitting their own receipts) and a
  dedicated finance role are deliberately deferred — the surface is
  already seam-clean for both.

## Concurrency

- `ExpenseSequence` is upserted inside the create transaction — atomic,
  per-organization, no sequence gaps worth protecting.
- Every mutation (`transition`, `reimbursement`, `updateExpense`,
  link add/remove) takes `SELECT … FOR UPDATE` on the expense row
  inside its transaction, so concurrent transitions serialize and
  before/after event metadata is truthful (double-approve → one
  transition + one quiet no-op).
- Link tables are `@@unique([expenseId, targetId])`;
  `ExpenseAttachment` is `@@unique([expenseId, attachmentId])`.

## Filtering — the admin index

`/admin/organizations/{orgId}/expenses` supports vendor, date from/to
(org-local calendar dates, inclusive), category (case-insensitive),
status, reimbursement status, asset, and incident — combinable, all
server-side, all preserved as query parameters. Asset/incident filters
match through the typed link tables.

## Export (issue #19)

The `expenses` CSV dataset exports one row per expense: `id`,
`organizationId`, `reference`, `expenseDate` (YYYY-MM-DD), `amountMinor`

- `currency` (the exact pair), `amount` (the exponent-aware decimal —
  `4215.38`), `vendorId` + `vendorName`, `category`, `description`,
  `status`, `reimbursementStatus`, `submittedByMemberId`/name,
  `paidByMemberId`/name, `submittedAt`, `reviewedAt` +
  `reviewedByAuthIdentityId` + `reviewNote`, `reimbursedAt` +
  `reimbursedByAuthIdentityId` + `reimbursementNote`, `attachmentCount`,
  `createdByAuthIdentityId`, `createdAt`, `updatedAt`. Context links
  export relationally via the `expense-links` dataset
  (`linkType`/`expenseId`/`targetId`); receipts join through
  `attachment-links` `linkType = EXPENSE`. Filters: org-local `from`/`to`
  on `expenseDate`, `vendor`, `status`, `reimbursementStatus`,
  `currency`, `category`. It remains recordkeeping, not accounting —
  there is no ledger semantics and no cross-currency total. See
  `docs/reporting.md`.

## Seams for later issues

- **#18 search** — vendor `name`/`contactName`/`accountReference`/
  `email`, expense `reference`/`category`/`description`, and the
  context links are structured, indexed fields ready to index.
- **#19 exports/reporting** — `amountMinor` + `currency` are exact,
  `expenseDate` is unambiguous, and every axis is a queryable column.
  Nothing in this design requires re-modeling for export.
- **#31 member self-service** — `submittedByMemberId` already records
  who submitted; a member-facing submission surface can sit on the same
  record.
- **Finance role** — a future `TREASURER`-style grant can reuse the
  `requireOrgAdminFor*` helpers as the resolution seam.

## Deferred work

Explicitly out of scope for this issue:

- Partial or split reimbursements (the expense's amount is the amount
  owed); a genuine need would add `reimbursedAmountMinor` with the same
  exact-money rules.
- Credit/refund records (negative expenses are rejected today).
- Vendor merge/deduplication tooling.
- Volunteer self-service receipt submission.
- Recurring expenses, budgets, or spend reporting beyond the list
  filters (that is issue #19's job).
- Anything resembling a ledger, payment rail, or accounting export —
  permanently out of scope by product boundary.
