# Domain model

The first SARbase domain schema: **Organization → Unit → Member**.
This document records the semantics, the cardinality decisions, and
what is deliberately deferred.

## Organization

The independent SAR organization that owns its records — conceptually a
volunteer rescue organization, association, or service. It is the
ownership boundary every other record scopes to.

Fields are deliberately minimal: `id`, `name`, `createdAt`, `updatedAt`.
No billing, subscription, slug, parent, or regional hierarchy — none of
those needs exist yet (see `docs/architecture.md`, "build from
demonstrated needs").

An organization cannot be deleted while it owns units or members
(`onDelete: Restrict`). Organizations hold records that will later be
referenced by incident, training, and expense history; destructive
deletion of an owner would destroy that context.

## Unit

An internal organizational grouping — a station, base, detachment, or
team, depending on how the organization is structured. Terminology is
deliberately organization-neutral; nothing in the model assumes an
island or any particular geography.

- A Unit belongs to exactly one Organization (`organizationId` FK,
  `onDelete: Restrict`).
- An Organization may have **zero or more** Units. Unit use is optional —
  nothing forces an organization to create one, and creation ordering
  never requires it.
- Unit names are unique **within** an organization
  (`@@unique([organizationId, name])`) but may repeat across
  organizations.

## Member

A Member is a **domain person record** — a volunteer or staff person the
organization administers. It belongs to exactly one Organization.

- `displayName` — a single free-text name. Names are not split into
  first/middle/last parts; the domain needs a human-readable name, and
  splitting invents structure no requirement asks for.
- `email` — optional, trimmed and lowercased, indexed, **not unique**.
  The same address may legitimately appear on multiple member records
  (shared family contact, separate organizations). Sign-in identity
  uniqueness is the auth layer's concern, not this record's.
- `phone` — optional, permissive international-format characters only.
  No country-aware validation is invented.
- `status` — `ACTIVE` or `INACTIVE` (default `ACTIVE`).

### Member ≠ authentication account

A Member is not a login. A volunteer exists in SARbase before — and
independently of — ever signing in. The authentication/authorization
a separate `AuthIdentity` _links to_ a Member
(see docs/authentication.md)
without defining it. Member records must survive deactivation and be
referenceable by future historical records regardless of sign-in state.

## Member ↔ Unit: `MemberUnit`

Membership is a many-to-many join table rather than a nullable
`Member.unitId`.

- Nothing in the domain requires a member to belong to at most one
  unit — a volunteer may participate in several internal groupings, or
  none. A single-unit column would assert a rule the domain does not
  state and would need a migration to undo.
- `MemberUnit` is still a narrow, concrete relationship — not a
  generalized "membership framework" with roles/periods. `createdAt`
  exists for ordering only; richer assignment semantics land only if a
  requirement does.
- `@@unique([memberId, unitId])` prevents duplicate assignments.

### Cross-organization integrity

`MemberUnit` carries a denormalized `organizationId` plus composite
foreign keys:

- `(memberId, organizationId)` → `Member(id, organizationId)`
- `(unitId, organizationId)` → `Unit(id, organizationId)`

Because `MemberUnit.organizationId` must satisfy _both_ parents at once,
PostgreSQL rejects any row pairing a member and a unit from different
organizations. Invalid cross-organization links are impossible at the
database level, not merely filtered at the application level. The
application additionally pre-validates so users get a clear error rather
than a constraint violation.

Join rows cascade (`onDelete: Cascade`) when a member or unit row is
removed at the database level, keeping referential integrity. The
application surface itself never deletes members — see lifecycle below.

## Member availability and contact preferences

Issue #12 adds two member-centered record families. Both record
**facts and stated preferences only** — SARbase is an administrative
records system, not an operational decision-support system, so nothing
here infers crew sufficiency, readiness, or whom to call.

### `MemberAvailabilityUpdate` — append-only availability statements

Each row is one **immutable availability statement**: a member (or an
admin acting on their behalf) declaring their status at a point in
time. Current availability is always _derived_ from the latest row —
there is no mutable "current status" column to drift out of sync.

- `status` — `AVAILABLE`, `UNAVAILABLE`, `OFF_ISLAND`, `UNKNOWN`.
  Deliberately small and purely descriptive. `LIMITED` was considered
  and rejected for v1: "limited" invites operational interpretation
  (limited _how_? _enough_ for what?) that SARbase must not encode.
- `until` — optional calendar **date** (`@db.Date`) that limits how long
  the statement remains current. The domain applies it uniformly to any
  status — `AVAILABLE until Dec 1` ("I'm on island until then") is as
  meaningful as `OFF_ISLAND until Oct 12` — while the account form only
  offers the date input when a real (non-`UNKNOWN`) status is selected.
  A date — not a timestamp — matches how volunteers think; no
  hour-of-day precision is invented.
- `note` — optional free-text context ≤200 chars.
- `actorAuthIdentityId` + `selfReported` — provenance: who recorded the
  statement and whether the member said it themselves or an admin
  entered it (e.g. phoned in).

#### Expiry semantics

`until` is evaluated against the **organization's local calendar date**
(`Organization.timezone`, never server-local time): the statement
remains the member's current status for the whole local day named by
`until`, then expires at local midnight.

After expiry the computed status falls back to **`UNKNOWN`** — never
`AVAILABLE`. An elapsed date is a fact about the past, not evidence
the member returned or became available; inferring `AVAILABLE` from a
lapsed date would silently fabricate operational information. The
expired row remains visible as history ("was off island until Oct 12,
lapsed"), and any later statement supersedes it normally.

Expiry is **read-time calculation**, not a background job: each read
compares the latest row's `until` to the org's local "today", so there
is no scheduler to fail, no stale flipped state, and the historical
row is never rewritten.

#### Authorization

- **Self-service**: a signed-in volunteer may update availability only
  for their own linked member record **and only while an
  `OrganizationAccess` row exists** — member linkage alone grants
  nothing. The target member is resolved server-side from the session
  (`linkedMembersWithAccess`), so a submitted `memberId` for anyone
  else is an opaque "Not found."
- **Admins** may record availability on behalf of members in their
  organization (marked `selfReported: false`, attributed to the admin's
  identity) and view the org-wide current-status list and per-member
  history. Unit membership is not an authorization boundary.
- Rows carry a denormalized `organizationId` with a composite
  `(memberId, organizationId)` foreign key — a statement cannot point
  across organizations even at the SQL level — and `@@index`es on
  `(organizationId, memberId)` / `(memberId)` serve both access paths.
- History is never deleted by the application; `Member`/`Organization`
  relations are `Restrict`, so statements cannot be orphaned or
  silently erased. `actorAuthIdentityId` is a plain scalar (same policy
  as `TrainingAttendanceChange`): an identity that authored history can
  still be deleted, the stored id remains a stable forensic reference,
  and display resolution falls back to the raw id after removal.

### `MemberNotificationPreference` — per-member channel preferences

One row per member recording which channels they are **willing** to
receive notifications on — the configuration later notification work
(issue #13) reads. This is preference/consent data only: **nothing is
sent**, and a checked channel is not proof of deliverability.

- `notifyEmail` / `notifySms` / `notifyWhatsapp` / `notifyPush` —
  four booleans covering the channels callout notifications will use.
- **Destinations stay on `Member`** (`email`, `phone`) rather than
  duplicating addresses into the preference row — one canonical
  destination per channel family. Email notifications require a member
  `email`; SMS and WhatsApp require a `phone` (both are validated at
  write time, since willingness without a destination is meaningless
  configuration). Push has no address yet — willingness is recorded so
  a later device-registration flow can honor it.
- `Member.phone` is now normalized at write time to digits plus an
  optional leading `+` — usable by notification providers without
  inventing country codes or assuming any locale.
- Same authorization shape as availability: members manage their own
  record (with live `OrganizationAccess`); admins manage it
  organization-wide. One row per member via
  `@@unique([memberId, organizationId])`; `Cascade` delete since a
  preference has no standalone value, unlike availability history.

### What availability does **not** mean

The organization defines its requirements. SARbase records availability
facts and communication preferences; it does not determine whether a
crew is sufficient or ready to respond. Specifically, nothing here
drives launch readiness, minimum-crew checks, member ranking,
qualification inference, or callout dispatch — those are operational
decisions for the organization, and later issues (notifications,
callouts) build on these records without changing their factual nature.

## Notification requests and delivery records

Issue #13 adds the notification foundation: the durable records behind
every message SARbase is asked to send. Two entities — the request and
its append-only attempts — keep application intent, provider dispatch,
and audit history cleanly separated. Full architecture, provider
resolution, idempotency, and retry semantics live in
[`docs/notifications.md`](notifications.md).

> SARbase records and delivers communication requests. Delivery state is
> a factual record and is not an operational readiness or response
> conclusion.

### `Notification` — the durable request

One row per logical send: `organizationId`, optional `memberId`
(composite same-org FK), `channel` (`EMAIL` — SMS/WhatsApp/push are
deferred), `template`, stored `subject`/`bodyText` (retries replay the
exact message), `destination` **snapshot** (the address used at request
time — history stays accurate when `Member.email` changes; never an
authorization input), `metadata` (structured ids/codes only),
`idempotencyKey`, `intentHash`, `status`, `statusReason`, and
`requestedByAuthIdentityId` — a deliberately plain scalar per the actor
policy: history outlives identity deletion, display resolves
best-effort.

`@@unique([organizationId, idempotencyKey])` makes requests idempotent:
same key + same intent returns the existing row; same key + different
intent fails loudly. Statuses are facts: `PENDING`, `SUPPRESSED` (with a
factual `statusReason` such as `preference_disabled` or
`destination_missing` — not a failure), `ACCEPTED` (provider took the
message — **not** proof of delivery), `FAILED`.

Member-targeted requests enforce `MemberNotificationPreference` at
creation time: `notifyEmail` off or absent suppresses without ever
invoking the provider; preference on with no `Member.email` records a
`destination_missing` suppression. Requests without a member (direct
administrative sends) have no member preference to check.

### `NotificationAttempt` — append-only provider invocations

One row per provider call: `attemptNumber` (unique per notification),
`provider` name, `DISPATCHING`/`ACCEPTED`/`FAILED` status,
`providerMessageId`, safe `errorCode`/`errorSummary` (provider error
messages are never copied — they can echo recipient data), `retryable`,
`attemptedAt`/`resolvedAt`. Attempts are never overwritten — a retry
appends a new row — and `Restrict` deletes preserve the audit trail.
A permanently `DISPATCHING` attempt honestly means "invoked the
provider; outcome never recorded".

Admin visibility is a compact org-scoped history page
(`/admin/organizations/{orgId}/notifications`) with a labeled
administrative test-send — explicitly not a callout interface.

## Callouts and volunteer responses

Issue #14 adds the callout record: who was invited, through which
notification, and how each member factually responded. Full architecture
— token security, dispatch ordering, concurrency semantics — lives in
[`docs/callouts.md`](callouts.md).

> SARbase records who was invited and how they responded. It does not
> determine whether the resulting crew is sufficient, qualified, ready,
> or appropriate for an operation.

### `Callout` — the activation

One row per activation: `audience` (`ORGANIZATION`/`UNIT`/`MEMBERS`),
`unitId` snapshot for unit audiences, `title`, bounded `message`,
`status` (`ACTIVE`/`CLOSED`), `activatedAt`, `closedAt`,
`closedByAuthIdentityId`, and scalar `createdByAuthIdentityId`.
`@@unique([organizationId, activationKey])` + `intentHash` give durable
idempotent activation — same contract as `Notification`.

### `CalloutInvitation` — materialized audience

The invited set is resolved and written as rows at activation; later
roster changes never rewrite it. `@@unique([calloutId, memberId])`
dedupes. Each row carries `responseTokenHash` (SHA-256 of the emailed
link's bearer token — the hash, not the raw token, authenticates
responses; the token is derived per send under a server-held secret and
the stored notification body carries only a placeholder, so no database
row ever holds a usable credential), `invitedAt`,
current `response` (`COMING`/`UNAVAILABLE`/NULL — "no response" is
derived, not stored) and `respondedAt`, plus a nullable `notificationId`
link to the notification request — invitation and notification status
are deliberately separate facts.

### `CalloutResponseChange` — append-only response history

Every first response and every later change appends a row with
`previousResponse`, `response`, `source` (`TOKEN_LINK`/`ACCOUNT`/
`ADMIN`), scalar `actorAuthIdentityId` (null for token responses), and
optional admin `note`. Writes serialize on the callout row lock; an
identical response is an idempotent no-op, and a closed callout refuses
new responses while remaining fully readable.

Admin surface: `/admin/organizations/{orgId}/callouts` (list + one-action
activate) and `…/callouts/{id}` (per-invitee response, notification
outcome, response history, admin-recorded response, close). Members
respond via the emailed token link or `/account`. There is no readiness
or sufficiency display — response counts are descriptive facts only.

## Incident records

Issue #15 adds the durable incident record — the administrative history
of what an organization recorded about an event. Full architecture —
correction semantics, timeline model, sensitive-data authorization —
lives in [`docs/incidents.md`](incidents.md).

> SARbase records incident facts and human-authored notes. It does not
> provide search planning, navigation, tactics, readiness judgments, or
> operational recommendations.

An **Incident** is the record; a **Callout** is the notification event.
`Incident.calloutId` is a unique optional link (at most one incident per
callout, set once, never moved); incidents also create manually with no
callout, and callouts never require one.

### `Incident` — the record

`reference` ("INC-<n>" from a per-organization `IncidentSequence`
counter, unique per org), `title`, `summary` (the initial report),
`status` (`DRAFT`/`OPEN`/`CLOSED`), manual factual instants
(`reportedAt`, `departedAt`, `onSceneAt`, `returnedAt` — entered as org
wall time, stored as instants, never fabricated), lifecycle instants
(`openedAt`, `closedAt`, `closedByAuthIdentityId`), and scalar
`createdByAuthIdentityId`. Transitions are validated and row-locked;
same-status is a no-op; `CLOSED → OPEN` is an explicit human reopen.

### `IncidentMember` / `IncidentAsset` — explicit participation

Participation is a recorded fact, never inferred from callout RSVP.
Each row carries `organizationId` (composite same-org FK), a free-text
`roleNote`/`note`, `recordedAt`, and `recordedByAuthIdentityId`;
`@@unique([incidentId, memberId])`/`[incidentId, assetId]` prevents
duplicates. Removal deletes the row and appends a `*_REMOVED` timeline
event so the history survives.

### `IncidentTimelineEvent` — system facts

Typed system events (`INCIDENT_CREATED`, `STATUS_CHANGED`,
`CALLOUT_LINKED`, `MEMBER_/ASSET_ ADDED/REMOVED`,
`CORRECTION_RECORDED`) with `occurredAt` (when it happened) distinct
from `createdAt` (when recorded), scalar actor, and a narrow JSON
metadata payload. Deterministic ordering.

### `IncidentNote` + `IncidentNoteCorrection` — human-authored text

Notes (`GENERAL`/`AFTER_ACTION`/`CLOSING`) carry scalar
`authorAuthIdentityId`, `body`, and an optional manual `occurredAt`
observation time. Corrections update `body` and append a correction row
(before/after/reason/actor) — the original wording is always
recoverable.

### `IncidentChange` — material audit

Editing material fields writes a typed before/after change row plus the
update in one transaction — an auditable correction can never commit
without its snapshot. `reason` is required once the incident is CLOSED;
a correction never reopens it. All history rows use the scalar
actor-ID policy — no `AuthIdentity` FK, best-effort display, raw-id
fallback (issue #32 tracks the older FK-pinned tables).

The entire incident surface is ADMIN-only — incident data may be
sensitive, member roles get no incident access, and the public
`/respond` route never touches these tables. Attachments (#16), search
(#18), and reporting (#19) have documented relationship seams but are
not implemented here.

## Qualifications and certifications

Issue #8 adds the first member-record domain: administrative
qualification records. Two distinct concepts — organizational policy
vs. member evidence — are deliberately separate.

### `QualificationDefinition`

An organization's own definition of a qualification it tracks ("we
record first-aid certificates"). Fields: `organizationId`, `name`
(unique per organization), optional `description`, `status`
(`ACTIVE`/`INACTIVE`), timestamps.

- No operational fields exist — no rank, score, minimum crew, mission
  eligibility, or readiness rule. The organization defines what it
  tracks; SARbase does not interpret it.
- **Lifecycle:** `INACTIVE` means the org no longer assigns new records
  under this definition. It does not invalidate, hide, or delete
  existing member records. There is no delete workflow — the `Restrict`
  FKs refuse to destroy history.
- No definitions are seeded or hardcoded; each organization names its
  own.

### `MemberQualification`

One factual evidence row linking a `Member` to a
`QualificationDefinition` — "this member received this certificate,
issued by X on date D, expiring E". Fields: `issuedOn` and `expiresOn`
(optional date-only `@db.Date`), `issuer`, `reference` (certificate
number), `notes`, timestamps.

- **History is append-only.** A renewal is a NEW record; the prior
  certificate row is preserved. `(memberId, definitionId)` may repeat
  with no uniqueness constraint. Admins may correct clerical details in
  place — durable who/what/when correction history is deferred to the
  audit-history work.
- **"Latest" is deterministic, not a flag:** records sort by
  `issuedOn` descending (undated last), then `createdAt` descending.
  History is always listed; nothing supersedes or hides older rows.
- **Dates are calendar dates.** `@db.Date` stores date-only values —
  an expiry date is the last day the certificate covers; it is
  `expired` the following day. Current-date comparisons use the owning
  organization's IANA `Organization.timezone` ("America/Puerto_Rico",
  "Pacific/Auckland", …), computed via `calendarDateInZone` in
  `src/lib/dates.ts` — never UTC and never the server's zone.
- **Expiry state is derived**, never stored: `no_expiry` / `expired` /
  `expiring_soon` / `current` from `expiresOn` vs. a supplied date.
  "Expiring soon" windows (30/60/90 days in the UI) are a presentation
  filter, not an organizational renewal policy.
- **Same-organization integrity** uses the issue #5 mechanism:
  denormalized `organizationId` plus composite FKs to
  `Member(id, organizationId)` and
  `QualificationDefinition(id, organizationId)` — PostgreSQL rejects a
  row pairing parents from different organizations.
- **Deletion is conservative:** `Restrict` on member, definition, and
  organization. Member deactivation preserves all records.
- **Attachments deferred:** issue #16 will hang certificate files off
  this record's id; no URL/blob column stands in for that.
- **Reminders deferred:** `listExpiringQualifications` is the
  deterministic org-scoped query the reminder work (issues #11/#13)
  will consume; nothing sends notifications.

**Product boundary:** these are administrative records only. Nothing in
this model or UI concludes operational readiness, competence, mission
eligibility, or crew sufficiency — labels state date facts ("Expired
2027-11-01", "Expires in 28 days"), never "qualified".

## Training events and attendance

Issue #9 adds durable records of training activity and participation.

### `TrainingEvent`

One factual training activity: `organizationId`, optional `unitId`,
`title`, `date` (the organization's local calendar date, `@db.Date` —
same org-timezone semantics as qualification dates), optional
`durationMinutes`, `location`, `instructorName` (free text — external
instructors need no entity), optional `leadMemberId` (internal lead,
same-org enforced, `Restrict` like every other member reference —
recorded history always keeps its lead pointer), `notes`, `followUp`
(free text — deliberately not
a task-management system), `status`, timestamps.

- **Lifecycle:** `COMPLETED` (the training happened) or `CANCELLED`
  (it was recorded/planned but did not occur). No DRAFT — SARbase does
  historical recordkeeping, not scheduling. A cancelled event keeps its
  rows for history but is excluded from participation counts and
  "last attended"; its attendees are never presented as having
  attended something that did not happen. Attendance cannot be edited
  while an event is cancelled.
- **No operational fields** — no scores, pass/fail, rank, eligibility,
  attendance targets, or qualification outcomes. Attendance never
  creates a `MemberQualification`; training ≠ certification.
- **Edits preserve identity.** Corrections update the row in place;
  durable who/what/when change history for event-detail edits remains
  deferred to the generic audit work (attendance edits are already
  audited — see `TrainingAttendanceChange`).
- **Unit association is optional.** Org-wide training (`unitId` null),
  one unit's training, and mixed attendance are all expressible;
  `MemberUnit` is never an authorization input.
- **Duration** is the whole event length; every attendee's hours derive
  from it. Per-attendee duration is deferred until a real need exists —
  future reporting (#19) can sum `durationMinutes` over attendances.

### `TrainingTopic`

One row per practiced topic (`label`), `@@unique([trainingEventId,
label])`, case-insensitive dedupe preserving the organization's own
vocabulary — no fixed taxonomy, no comma-separated blobs, so future
search (#18) and reporting (#19) stay relational.

### `TrainingAttendance`

"This member attended this event" — row existence is the fact; there is
deliberately no excused/unavailable taxonomy in v1 (a cancelled event
already covers "it did not happen"). `@@unique([trainingEventId,
memberId])` prevents duplicates; optional per-attendee `notes`.
Participation views filter `event.status = COMPLETED`.

### `TrainingAttendanceChange`

The durable audit record behind issue #9's "attendance edits are
auditable". Every member added to or removed from an event's
attendance appends one immutable row — `organizationId`,
`trainingEventId`, `memberId`, `actorAuthIdentityId`, `action`
(`ADDED`/`REMOVED`), `createdAt` — written inside the same transaction
as the attendance mutation itself, so attendance can never change
without history. There is no update or delete path for these rows.

- **Scope is deliberately narrow.** This is a domain-specific change
  log for one fact (attendance add/remove), NOT the deferred generic
  audit/change-history framework. Structured runtime logs remain an
  observability aid only — they are not the durable audit record.
- **Actor is server-derived.** `actorAuthIdentityId` comes from the
  authenticated request's `AuthIdentity` (`ctx.identity.id`), never
  from client input.
- **Actor history is preserved, not pinned.** `actorAuthIdentityId` is
  deliberately a plain column, not a foreign key: a hard FK would
  either block AuthIdentity deletion forever (`Restrict`) or erase the
  actor when the identity is removed (`SetNull`). The stored id remains
  a stable forensic reference; while the identity row exists the UI
  resolves it to the linked member's display name or sign-in email,
  and afterwards renders a safe fallback identifier.
- **This is the uniform policy for every audit/history actor column**
  (`TrainingAttendanceChange`, `MemberAvailabilityUpdate`,
  `InspectionRecordChange`, `MaintenanceRecordChange`, `DefectChange`,
  callout/incident history, notification requests, attachment audit):
  actor IDs are retained as scalar identifiers rather than foreign
  keys so historical records survive deletion of the authentication
  identity. Display attribution resolves current identity/member
  information best-effort (`resolveActorLabels` in
  `src/lib/domain/actors.ts` — linked member name in the record's
  organization, then sign-in email) and falls back to the stored
  actor ID. No history table may `JOIN` an actor through an
  `AuthIdentity` relation — there is deliberately no such relation.
- **Same-organization integrity is DB-enforced** via the issue #5
  mechanism — denormalized `organizationId` plus composite FKs to
  `TrainingEvent(id, organizationId)` and `Member(id, organizationId)`,
  both `Restrict`. A cross-organization audit row is physically
  impossible, and an event or member row that has history cannot be
  hard-deleted underneath it.
- **Re-adding is a new row.** Removing then re-adding a member produces
  a second `ADDED` entry; deleting the current `TrainingAttendance`
  row never touches the change history.

### Same-organization integrity

`TrainingAttendance`, `TrainingAttendanceChange`, and `TrainingTopic`
carry denormalized `organizationId` plus composite FKs to
`TrainingEvent(id, organizationId)` and (attendance rows)
`Member(id, organizationId)` — PostgreSQL rejects cross-org pairings.
`TrainingEvent.unitId`/`leadMemberId` use nullable composite FKs the
same way. All deletes are `Restrict` (topics cascade — they are part of
the event record, not independent history).

**Deferred:** reminders/notifications (#11/#13), the generic
audit/change-history framework for event-detail and other record edits,
reporting (#19), global search (#18). Training documents and attendance
sheets attach via `TrainingEventAttachment` (issue #16, below).

## Assets, inventory, and storage locations

Issue #10 adds lightweight operational inventory and asset
recordkeeping — institutional memory about **what the organization
owns and where it physically is**. It is deliberately not an ERP, a
warehouse-management system, an accounting ledger, or a readiness
system: SARbase stores facts a human recorded ("radio serial 1234",
"3 lifejackets in the forward locker", "condition: damaged") and never
infers that a boat is safe, a unit is ready, stock is sufficient, or a
launch should happen. Humans decide operational meaning.

### Two record families, deliberately not unified

- **`Asset`** — a durable, individually identifiable thing (rescue
  boat, engine, VHF radio, AED, toolbox). Optional identity fields:
  `category` (free text — the organization's own vocabulary, no enum
  churn), `manufacturer`, `model`, `serialNumber`, `assetTag`,
  `purchaseDate` (date-only), `vendor` (free-text purchase memory —
  expenses link to real `Vendor` records, #17), `notes`.
- **`InventoryItem`** — a quantity-tracked stock item (rope, flares,
  gloves, batteries, consumables). `quantity` is an exact
  `DECIMAL(14,3)` — "25 m of line" and "1.5 gallons cleaner" are
  legitimate facts that floats would corrupt — plus a free-text
  `unitOfMeasure` ("rolls", "each", "m"). No lot tracking, reorder
  points, FIFO, or stock transactions; quantity is "how many we have
  now", not a judgement of sufficiency.

Forcing both into one table would make serial/tag/parent null-noise on
stock and quantity meaningless on unique assets; separate subtype
tables per equipment kind would be premature schema. Two flat tables
is the smallest coherent split.

### `StorageLocation`

A place things physically live, arbitrarily nested —
`SAR Building > Workshop > Shelf A > Cabinet 2`. A location sits inside
**at most one** container: a parent location (`parentLocationId`)
**or** an asset it is physically part of (`containingAssetId` —
"Forward locker" inside "Rescue Boat 1"); a top-level location has
neither. The XOR is enforced at both layers — the domain rejects a
dual container for a friendly error, and the
`StorageLocation_single_container` CHECK constraint rejects the row at
the database level, so direct writes, import scripts, and future code
paths cannot persist it either (Prisma cannot express CHECK, so the
constraint lives in its own migration). A single container select in
the UI makes it unrepresentable in the form. Letting an asset contain
locations is what makes vessel lockers hang off the boat's single
identity rather than a shadow location named after the boat.

Because assets can also be _stored in_ locations, the "is inside / is
part of" edges form one union graph (location → parentLocation |
containingAsset; asset → storageLocation | parentAsset). Cycles cannot
be expressed as foreign keys; the domain walks that union graph and
rejects any placement that would contain a record inside itself —
which also prevents the subtler "boat stored in its own locker" loop.
The same walk renders `locationPath` deterministically and is
cycle-safe even against bad data.

The union-graph check is read-then-write, so without serialization two
concurrent admins could each validate against the same stale graph and
commit a cycle (A inside B while B inside A). Every mutation that
writes a containment edge — create/update of `StorageLocation` and
`Asset` — therefore runs inside a transaction holding a
**per-organization** PostgreSQL advisory lock (`pg_advisory_xact_lock`
keyed by `hashtextextended` of the organization id). Contenders
serialize: the loser re-reads the graph after the winner commits and
its cycle check fails cleanly with a hierarchy error, never an opaque 500. The lock is transaction-scoped (released automatically on commit
or rollback), holds across server instances — unlike an in-process
mutex — and never blocks other organizations or ordinary reads.
`InventoryItem` writes stay unlocked; items are graph leaves, never
containers.

### Asset parent-child

`Asset.parentAssetId` is optional physical/administrative containment —
"port engine is part of Rescue Boat 1", "radio is in the kit bag".
Children keep independent identities and their own optional storage
locations (an engine can be part of a boat and temporarily sit in the
workshop). It is not an operational dependency graph and asserts
nothing about fitness. Same-organization and acyclic; without it,
engines would be orphaned records whose boat relationship could only
live in free text.

### Status, condition, lifecycle

- `AssetStatus`: `ACTIVE` (in use), `INACTIVE` (stored/spare/seasonal —
  not currently in use), `OUT_OF_SERVICE` (a person explicitly marked
  it so — **not** an inspection result), `RETIRED` (permanently
  withdrawn). Every transition is an explicit human choice; nothing is
  derived from dates, quantities, or defects.
- `ConditionStatus` (`UNKNOWN`/`GOOD`/`FAIR`/`DAMAGED`): a clerk's
  note about what someone observed — never inspection-derived, never a
  safety grade. `UNKNOWN` is the default so no record pretends to a
  condition nobody stated. Inspections (#11) may record an observed
  condition per occurrence without touching the asset's own field.
- `StorageLocationStatus` / `InventoryItemStatus`: `ACTIVE` |
  `ARCHIVED`. Archival preserves the row and every reference to it;
  the application exposes no delete path for any of these records —
  future maintenance, inspection, incident, expense, and attachment
  records will point at them (`Restrict` FKs are the backstop).

**Location history is deferred.** Current `storageLocationId` is a
mutable fact; `updatedAt` plus structured logs capture that a change
happened but not where-from/where-to. A narrow `AssetLocationChange`
ledger was considered and deliberately not built — durable move history
fits the generic audit-history work rather than a per-entity
one-off.

### Same-organization integrity

Same mechanism as elsewhere: denormalized `organizationId` +
composite FKs. A location's parent location or containing asset, an
asset's unit/location/parent, and an item's unit/location are all
enforced same-organization **at the database level** —
`StorageLocation(id, organizationId)` and `Asset(id, organizationId)`
are composite-FK targets, so a cross-org pairing is a P2003 rejection,
not just an app check. `assetTag` is `@@unique([organizationId,
assetTag])` — org-scoped when present; NULLs are distinct so untagged
assets never collide. `serialNumber` is indexed but deliberately not
unique (manufacturers can reuse them).

**Deferred to later issues:** global search (#18 — the
identifier/category indexes are the preparation), reporting (#19),
durable location/movement history (generic audit work). (Attachments
#16 and vendors/expenses #17 are implemented — `vendor` free text may
migrate onto `Vendor` records in a later cleanup.)

## Inspections, maintenance, defects, and due tracking

Issue #11 adds four related but distinct record families — durable
facts, never a mutable "maintenance status" blob. **Product boundary:**
these records state facts only — "inspection performed 2026-09-15",
"service at 812.4 hours", "defect reported", "due 2026-10-15",
"overdue by 12 days". Nothing here concludes that an asset is safe,
unsafe, ready, deployable, or a mission blocker; humans decide
operational meaning.

**Target decision:** every record attaches to `Asset` only.
`InventoryItem` consumable/expiry tracking is deferred — a polymorphic
asset-or-item target would weaken composite-FK integrity, and items
that genuinely need per-unit inspection (a specific flare kit, an
oxygen kit) can be modeled as Assets, which is what they are.

### `InspectionDefinition`

What the organization tracks ("monthly vessel visual inspection",
"annual extinguisher check"). Org-scoped `name` (unique per org),
optional `description`, calendar recurrence (`NONE` |
`CALENDAR_DAYS` | `CALENDAR_MONTHS` + positive `intervalValue`), and
`ACTIVE`/`INACTIVE` lifecycle. Deactivation preserves history but
blocks new records. Definitions are never hardcoded. Meter-based
recurring requirements live on `MaintenancePlan`, not here.

### `InspectionRecord`

A factual occurrence: asset + definition + `performedOn` calendar
date, optional inspector (same-org `inspectorMemberId` and/or
free-text `inspectorName` for external surveyors), optional
`conditionObserved` (a clerk's observation reusing `ConditionStatus` —
it does NOT update `Asset.condition`), optional explicit `nextDueOn`,
optional meter reading, `notes`. There is deliberately no result
verdict — the record's existence states the inspection happened;
findings live in notes and in defects a human chooses to report.
When no explicit `nextDueOn` is supplied and the definition carries
calendar recurrence, the due date is derived at record time and stored
as a fact (`performedOn + interval`, month-end clamped).

**Corrections preserve material history.** `updateInspectionRecord`
edits material fields in place but appends an immutable
`InspectionRecordChange` row in the same transaction: a complete
before/after snapshot of the material fields (`performedOn`,
`inspectorMemberId`, `inspectorName`, `conditionObserved`, `nextDueOn`,
`notes`), the optional human `note`, the acting identity as a scalar
`actorAuthIdentityId` (server-side, never client-supplied — no FK, so
history survives identity deletion), and `createdAt`. The record row
locks `FOR UPDATE` inside the transaction so concurrent corrections
chain correctly — each change's `before` equals the previously
committed state. A submission that changes no material field writes no
history. Asset, definition, and the captured meter reading are
immutable provenance and are not in the snapshot.

### `MaintenancePlan`

A per-asset recurring requirement ("engine oil every 100 hours",
"annual haul-out"). `intervalType` is `NONE` | `CALENDAR_DAYS` |
`CALENDAR_MONTHS` | `METER_INTERVAL`; meter plans require an
`AssetMeter` on the same asset plus a positive `meterInterval`
(exact `DECIMAL(14,3)`). Plans are per-asset only — no category rules
or policy engine. `INACTIVE` preserves history and blocks new records.

### `MaintenanceRecord`

A factual service/repair event: `performedOn`, `title`, optional
`workPerformed`, free-text `providerName` (expenses record real
vendor/cost linkage via `ExpenseMaintenanceRecord`, #17), optional
`performedByMemberId`, optional meter reading, optional
explicit `nextDueOn` (for ad-hoc work), `notes`. `planId` is optional —
ad-hoc work needs no plan. History appends; a new service is a new
row, never an overwrite. Plan-linked records get their due follow-up
from the plan's recurrence at read time, so corrections to the latest
record automatically recompute the derived due fact.

Material corrections get the same treatment as inspections:
`updateMaintenanceRecord` writes a `MaintenanceRecordChange`
before/after snapshot (`performedOn`, `title`, `workPerformed`,
`providerName`, `performedByMemberId`, `nextDueOn`, `notes`) + scalar
actor id + timestamp atomically with the update. `planId`, asset, and
the captured meter reading are immutable provenance.

SARbase interprets the foundation's immutable-records rule
(`amendsRecordId` append-only amendment) as stable-record-identity +
immutable correction history: corrections fix clerical mistakes in
place while `*RecordChange` rows preserve every prior material state.
The historical-integrity property — the past cannot be silently
rewritten — is the same, and record ids stay stable for future
attachment linkage.

### `Defect` + `DefectChange`

A human-reported factual issue: `reportedOn`, optional reporter
(member and/or free text), `title`, `description`, `OPEN`/`RESOLVED`
status, `resolvedOn`, `resolutionNotes`. Every lifecycle event —
REPORTED, RESOLVED, REOPENED — appends a `DefectChange` row recording
the acting admin's scalar `actorAuthIdentityId` (same narrow-history
pattern and actor policy as `TrainingAttendanceChange`; no generic
audit framework). Reopening
keeps `resolvedOn`/`resolutionNotes` as the record of the most recent
resolution while status returns to OPEN.

**Defects never mutate `AssetStatus`.** Reporting a defect leaves the
asset `ACTIVE` unless the human explicitly checks "also mark out of
service" (or edits the asset); resolving a defect never restores
`ACTIVE`. `OUT_OF_SERVICE` remains an explicit human lifecycle choice.

### `AssetMeter` + `AssetMeterReading`

A generic, manually-recorded counter on one asset — `name` + free-text
`unit` ("hours", "km", "cycles") so no meter kind is hardcoded. No
telemetry or sensor ingestion. Readings are append-only facts
(`DECIMAL(14,3)`, non-negative); "current reading" is the latest by
`(recordedOn, createdAt)`.

**Meters are monotonic within a meter's lifetime** — aligned with
`maintenance-core` (`readings.ts`): a physical meter does not run
backward, so a reading that would break non-decreasing observation
order is rejected as a data-entry error
(`MeterReadingDecreaseError`). The check compares against the
chronological neighbors (`recordedOn`, then `createdAt`), so a
backdated-but-honest observation ("forgot to log Tuesday") is legal
when it fits — the runbook's "reading dates are honest" principle.
Writers hold the meter row lock inside the transaction so concurrent
readings can't interleave a decrease past the check. Meter
reset/replacement is a real, explicit event: archive the old meter and
create a new one — each meter's sequence stays monotonic and due math
(`meterReading + meterInterval` vs current) stays unambiguous. A
reading may carry at most one provenance source (a maintenance or
inspection record it was captured on) — enforced by the
`AssetMeterReading_single_source` CHECK constraint as well as domain
validation.

### Due-date and meter-due semantics

"Today" is always the owning organization's IANA-local calendar date
(`calendarDateInZone` on `Organization.timezone`) — never server or
UTC time. A due date is valid **through** that day: "due today" all
day, overdue starting the next local day. `listDueInspections` reports
the latest record per (asset, definition) that carries a `nextDueOn`.
`listDueMaintenance` derives plan dues from the latest linked record
(`performedOn + interval`, or `meterReading + meterInterval` vs the
current meter reading) plus the most recent ad-hoc record carrying an
explicit `nextDueOn` per asset. A plan with no records reports
"never performed" — no baseline date is invented. All due data is
query-derived and deterministic; **notification delivery is deferred
to #13** — there are no reminder jobs or reminder rows.

### Same-organization integrity

Denormalized `organizationId` + composite FKs throughout: every record
proves its org at the database level, and references to definitions,
plans, meters, assets, members, and provenance records are all
composite `(id, organizationId)` targets — a cross-org write is a
P2003 rejection, not just an app check. Meters additionally must
belong to the same asset as the record referencing them.

**Deferred to later issues:** global search (#18), reporting (#19),
InventoryItem expiry tracking
(deliberately deferred with the target decision above). (Notification
delivery #13, attachments #16, and vendors/expenses #17 are
implemented — `providerName` free text may migrate in a later cleanup.)

### app-foundations `maintenance-core` evaluation

Reviewed `spizeck/app-foundations/modules/maintenance-core`
(`README.md`, `src/dates.ts`, `src/due-state.ts`, `src/schedule.ts`,
`src/readings.ts`, `src/records.ts`, `standards/maintenance.md`,
`runbooks/maintenance.md`, `docs/maintenance-extraction.md`) as
copy/adapt guidance — it is pure domain logic, so nothing is a runtime
dependency.

**Reused / adapted:**

- **Calendar-date semantics** — `LocalDate` ≈ SARbase's `YYYY-MM-DD`
  validated dates pinned to `@db.Date` UTC midnight; "today" is
  resolved at the application boundary (`organizationToday` /
  `calendarDateInZone`), never inside decision logic — same shape as
  `evaluateDueState(schedule, asOf, policy)`.
- **Due-state is a fact, never an operational verdict** — the
  module's "maintenance state never mutates operational state" /
  Resource-Blocks boundary matches SARbase's defect/status separation.
- **Schedule vs. record separation** — `MaintenancePlan`/`Inspection
Definition` play the schedule role; `MaintenanceRecord`/
  `InspectionRecord` are the history. SARbase additionally derives the
  due point from the latest record at read time rather than storing a
  mutable `nextDueAt` on the plan — the standard's "two writes can
  diverge" hazard is structurally impossible here.
- **`unknown` ≠ `ok`** — plans with no records report "never
  performed"; a meter with no reading yields no meter-due fact.
- **Meter due** — `currentReading >= nextDueAt` is overdue; the
  threshold is `lastServiceReading + interval` (≈ `advanceAfterService`
  semantics). SARbase does not implement the 10%-of-interval
  "due-soon" window for meters; meter entries report reached/not
  reached plus remaining/overBy amounts, while date dues use the
  caller-supplied day window.
- **Immutable history** — defect `DefectChange` and the
  `*RecordChange` correction snapshots implement the same
  "the past is not rewritten" rule as `records.ts` + `amendsRecordId`.

**Deliberate differences:**

- **Record identity stays stable.** `maintenance-core` models
  corrections as new records with `amendsRecordId`. SARbase updates
  material fields in place and appends `InspectionRecordChange` /
  `MaintenanceRecordChange` before/after rows — friendlier for
  correction-heavy clerical use and keeps ids stable for future
  attachment linkage, while preserving the same audit property.
- **Reset/replacement is archive + new meter, not a reset flag.**
  `applyMeterReading` allows a decrease with `allowMeterReset`; SARbase
  has no reset flag — a meter's observation order is strictly
  non-decreasing for its lifetime and a replacement is a new
  `AssetMeter`, matching the model's own "meter lifetime" framing and
  keeping every meter's history self-consistent.
- **Meters live on assets, not inside the schedule.** The plan only
  references a meter and an interval; readings are first-class
  append-only rows shared by direct entry and record provenance, so
  inspection-time and service-time captures feed one sequence.
- **No `kind` taxonomy on records.** maintenance-core splits
  service/unscheduled/inspection/note; SARbase keeps inspections as
  their own typed record family (they carry org-defined definitions
  and recurrence) and treats all maintenance rows uniformly —
  the factual boundary the issue asks for.

## Attachments and organizational documents

Issue #16 adds first-class file records. The full reference —
provider abstraction, upload/download flow, security model — is
`docs/attachments.md`. The domain-model essentials:

- **`Attachment`** is the durable file record: organization-scoped,
  sanitized `displayFilename`, validated `mediaType`, `sizeBytes`,
  `storageProvider` + opaque `storageKey`
  (`organizations/<org>/attachments/<uuid>`), server-computed
  `checksumSha256`, `ACTIVE`/`DELETED` status, scalar
  `uploadedByAuthIdentityId`. No blobs in PostgreSQL, no public URLs,
  no business context in keys.
- **Explicit link tables** — `IncidentAttachment`,
  `IncidentNoteAttachment`, `MemberQualificationAttachment`,
  `TrainingEventAttachment`, `AssetAttachment`,
  `InspectionRecordAttachment`, `MaintenanceRecordAttachment`,
  `DefectAttachment`, `ExpenseAttachment` — instead of a polymorphic
  `entityType`/`entityId`
  row. Each carries composite same-org FKs on both sides plus
  `@@unique([targetId, attachmentId])`; PostgreSQL rejects
  cross-organization pairings structurally.
- **`AttachmentEvent`** is append-only lifecycle history
  (`UPLOADED`/`LINKED`/`UNLINKED`/`DELETED`) with a snapshot of the
  entity at event time, optional reason, honest `storageDeleted` flag,
  and scalar actor id — the same survivability policy as incident
  change history.
- **`OrganizationDocument`** + **`OrganizationDocumentVersion`** model
  org-level documents (policies, SOPs, manuals, registrations,
  insurance). Versions are append-only rows over attachments; the
  current file is the highest `versionNumber` and archiving is a
  status, not a deletion — replacing a policy never erases the prior
  file.
- **Deletion is a tombstone**, not a hard delete: status flips, link
  rows are retained (rendered as deleted), physical object deletion is
  attempted and its outcome recorded on the `DELETED` event. Attachment
  mutations on protected records — `CLOSED` incidents, `APPROVED` or
  `REIMBURSED` expenses — require an explicit recorded reason.

## Vendors, expenses, and reimbursements

Issue #17 adds lightweight financial recordkeeping — where something
was bought, what it cost, what it was for, and whether a personally
paid volunteer has been repaid. The full reference is
`docs/expenses.md`. **SARbase is not accounting software**: no ledger,
no payments, no invoicing, no FX. The essentials:

- **`Vendor`** — organization-scoped contact/reference record
  (`name`, `contactName`, `email`, `phone`, `website`,
  `accountReference`, `notes`, `ACTIVE`/`INACTIVE`). Names are not
  unique — `accountReference` disambiguates. Vendors are never
  deleted: `INACTIVE` blocks new spending but stays on history.
- **`Expense`** — organization-scoped purchase record with an
  atomic per-organization `EXP-<n>` reference. `amountMinor` is an
  integer count of minor units (USD 42.15 → `4215`) and `currency` an
  ISO 4217 code from an explicit exponent table — exact money, never
  floating point, one currency per record, no conversion.
  `expenseDate` is an organization-local `@db.Date` calendar date.
  Optional `vendorId`, free-text `category`, `description`,
  `submittedByMemberId`, `paidByMemberId` (who paid out of pocket).
- **Two independent axes**: `status` (`DRAFT`/`SUBMITTED`/`APPROVED`/
  `REJECTED` — APPROVED terminal, REJECTED needs a note and returns to
  DRAFT for rework) and `reimbursementStatus` (`NOT_REQUIRED`/`PENDING`/
  `REIMBURSED` — requires `paidByMemberId`, un-marking needs a note,
  records a fact rather than processing a payment).
- **Typed context links** — `ExpenseIncident`, `ExpenseTrainingEvent`,
  `ExpenseAsset`, `ExpenseMaintenanceRecord`, `ExpenseInventoryItem`
  rows with composite same-org FKs on both ends and
  `@@unique([expenseId, targetId])`. One expense, several contexts.
- **`ExpenseEvent`** (append-only system feed) + **`ExpenseChange`**
  (typed before/after columns per material correction) — written in
  the same transaction as the change they record. Corrections on
  APPROVED/REIMBURSED expenses require a reason; no-op edits write
  nothing. Scalar `actorAuthIdentityId` throughout — history survives
  identity deletion.
- **Receipts are `Attachment`s** linked through `ExpenseAttachment` —
  the full issue #16 pipeline (neutral storage, private downloads,
  tombstones, reason-required mutations on protected records), nothing
  duplicated.
- **ADMIN-only** — financial records are sensitive; every surface
  resolves the record's own `organizationId` before checking the
  grant, and foreign ids are indistinguishable from missing ones.

## Lifecycle and history

- Members are **deactivated/reactivated**, never deleted through the
  application. `INACTIVE` preserves identity and all historical
  references; incident, training, and expense records point at members
  that must still exist.
- Units and organizations have no app-level deletion workflow at all in
  this issue; the `Restrict` FKs make even administrative deletion
  conservative.
- Status changes are ordinary column updates today. Training
  **attendance** edits, **defect lifecycle** transitions, and
  **material inspection/maintenance corrections** are the exceptions —
  they append immutable `TrainingAttendanceChange` / `DefectChange` /
  `InspectionRecordChange` / `MaintenanceRecordChange` rows (see
  above). **Deferred:** the generic audit-history work (a later issue)
  is expected to strengthen other material history — who changed
  status, event details, when — into durable audit records rather than
  relying on `updatedAt` and runtime logs.

## Authentication and authorization

Issue #6 replaced the issue #5 temporary gate with real auth — the full
reference is `docs/authentication.md`. The model in brief:

- **`AuthIdentity`** — a login identity (`provider` + `providerUid`
  unique, normalized email, `ACTIVE`/`DISABLED`). Auto-provisioned at
  first verified sign-in with zero access; provider identifiers never
  land on `Member`.
- **`Member.authIdentityId`** — optional FK to an identity (`SetNull` on
  delete). Globally one identity may link to member records in several
  organizations, but `@@unique([organizationId, authIdentityId])`
  caps it at **one linked member per organization per identity**;
  each member links to at most one identity, and unlinked members
  coexist (NULLs are distinct).
- **`OrganizationAccess`** — explicit `(authIdentityId, organizationId,
role)` rows; the sole source of org-scoped authorization. `OrgRole` is
  `MEMBER` or `ADMIN` (application administration only — it implies no
  SAR command authority or operational qualification).

`Member` remains a domain person record, not an account. `MemberUnit`
membership is never an authorization input — units are internal
groupings, not security boundaries.

No row-level security or tenant middleware exists yet; ownership is a
data constraint first, enforced by the composite FKs above plus the
centralized helpers in `src/lib/auth/authorize.ts`.

## Validation

Server-side Zod schemas (`src/lib/domain/schemas.ts`):

- `name` (organization, unit): required, trimmed, 1–120 chars.
- `timezone` (organization): IANA identifier validated via `Intl`;
  blank → `UTC` (the migration default for pre-existing orgs — set the
  real zone in organization settings).
- `displayName` (member): required, trimmed, 1–120 chars.
- `email`: optional; blank → `null`; trimmed, lowercased, format-checked.
- `phone`: optional; blank → `null`; permissive `+ digits, spaces,
( ) . -` pattern, normalized at write time to digits plus an optional
  leading `+`.
- `status`: `ACTIVE` | `INACTIVE`.
- Availability statement: `status` required
  (`AVAILABLE`/`UNAVAILABLE`/`OFF_ISLAND`/`UNKNOWN`); `until` optional
  `YYYY-MM-DD` calendar date that must not already be past in the
  organization's timezone (the write path rejects dates the org's local
  calendar has already passed); `note` optional ≤200. Contact
  preferences: four channel booleans; email requires a member `email`,
  SMS/WhatsApp require a member `phone`.
- Unit assignments: array of unit ids, all verified same-organization.
- Qualification definition: `name` required (1–120, trimmed),
  `description` optional ≤500.
- Member qualification: `definitionId` required; `issuedOn`/`expiresOn`
  optional `YYYY-MM-DD` calendar dates (impossible dates rejected; expiry
  may not precede issue when both exist); `issuer`/`reference` optional
  ≤120; `notes` optional ≤2000. Blank fields are absent, not errors.
- Training event: `title` required (1–120); `date` required real
  calendar date; `durationMinutes` optional int 1–1440; `location`
  ≤160, `instructorName` ≤120, `notes`/`followUp` ≤2000; `topics`
  ≤24 labels × ≤60 chars, deduped; `unitId`/`leadMemberId` must resolve
  to same-organization records; attendance `memberIds` deduped and
  same-organization.
- Training history filters (org admin page query params):
  `trainingUnit` is `org` (organization-wide events) or a unit id —
  unknown/cross-org ids simply match nothing; `trainingFrom`/
  `trainingTo` are optional `YYYY-MM-DD` calendar dates validated with
  the same date-only rules — invalid values are ignored.
- Storage location: `name` required (1–120, trimmed); `description`
  optional ≤500; at most one of `parentLocationId`/`containingAssetId`
  (both must resolve same-organization; self-parenting and
  container-graph cycles rejected by the domain).
- Asset: `name` required; `category` ≤60, `manufacturer`/`model`/
  `serialNumber`/`vendor` ≤120, `assetTag` ≤60 (unique per
  organization when present), `notes` ≤2000 — all optional;
  `purchaseDate` optional `YYYY-MM-DD` calendar date; `unitId`,
  `parentAssetId` (not self, acyclic), `storageLocationId` must
  resolve same-organization; `status`/`condition` bounded enums.
- Inventory item: `name` required; `quantity` required — a
  non-negative decimal string (≤9 integer digits, ≤3 decimal places)
  stored as exact `DECIMAL(14,3)`; `unitOfMeasure` ≤30; `unitId` and
  `storageLocationId` same-organization; bounded `condition`/`status`
  enums; `notes` ≤2000.
- Inspection definition: `name` required; `description` ≤500;
  `recurrenceType` calendar-only (`NONE`/`CALENDAR_DAYS`/
  `CALENDAR_MONTHS`); a positive `intervalValue` is required iff a
  recurrence is chosen.
- Inspection record: `definitionId` required (same-org, ACTIVE
  definition); `performedOn` required calendar date; `nextDueOn` may
  not precede it; inspector member must be same-org; meter id and
  reading must arrive together (same-org, same-asset, ACTIVE meter,
  non-negative ≤3-decimal value); `conditionObserved` bounded enum;
  `notes` ≤2000.
- Maintenance plan: `name` required (unique per asset); `intervalType`
  `NONE`/`CALENDAR_DAYS`/`CALENDAR_MONTHS`/`METER_INTERVAL`; calendar
  intervals require positive `intervalValue`, meter intervals require
  same-asset `meterId` + positive decimal `meterInterval`; mixing
  fields across modes is rejected.
- Maintenance record: `title` and `performedOn` required; optional
  same-org, same-asset, ACTIVE `planId`; `nextDueOn` may not precede
  `performedOn`; meter id + reading pair as for inspections;
  `providerName`/`workPerformed`/`notes` bounded text.
- Defect: `title` required; `reportedOn` required; reporter member
  same-org; `resolvedOn` required when resolving and may not precede
  `reportedOn`; bounded `description`/`resolutionNotes`/history `note`.
- Meter: `name` required (unique per asset); `unit` required ≤30.
  Reading: non-negative decimal (≤9 integer digits, ≤3 decimals),
  `recordedOn` required calendar date, optional same-org member,
  `notes` ≤500 — and the value must keep the meter's observation order
  non-decreasing (a decrease means archive + new meter, not an edit).
- Inspection/maintenance corrections: same fields as creation minus
  the immutable provenance; optional `correctionNote` ≤500 recorded on
  the change row.
- Vendor: `name` required (1–120, trimmed); `contactName`/
  `accountReference` ≤120, `email` normalized, `phone` normalized,
  `website` http(s) ≤200, `notes` ≤2000 — all optional.
- Expense: `expenseDate` required calendar date; `amount` display text
  parsed by `parseMoneyAmount` (zero/negative/extra-precision
  rejected); `currency` required 3-letter code from the supported ISO
  table; `vendorId`/`submittedByMemberId`/`paidByMemberId` optional
  same-org references (new vendor assignments must be ACTIVE; a
  correction may keep the record's already-attached inactive vendor);
  `category` ≤60,
  `description` ≤2000; `reimbursementStatus` `NOT_REQUIRED`/`PENDING`
  at create. Corrections take the same fields plus an optional
  `reason` ≤500 — required by the domain once APPROVED/REIMBURSED.
  Rejection `note` required; link `note` ≤200; reimbursement `note`
  required when un-marking REIMBURSED.
- Expense list filters (query params): `vendor`, `from`/`to`
  `YYYY-MM-DD` (invalid ignored), `category`, `status`, `reimbursement`
  bounded enums, `asset`/`incident` link-target ids — foreign ids
  simply match nothing.
