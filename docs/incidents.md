# Incident records, timeline, notes, and audit history (issue #15)

An **incident** is the durable administrative record of what an
organization recorded about an event: the initial report, factual
timestamps, who was recorded as participating, which assets were
recorded as used, human-authored notes, and every later correction.

> SARbase records incident facts and human-authored notes. It does not
> provide search planning, navigation, tactics, readiness judgments, or
> operational recommendations.

An incident is **not** a callout and **not** an operational picture.
There is no severity, priority, crew-sufficiency, verdict, or command
state anywhere in the model.

## Incident vs callout

The two records are deliberately separate concepts:

- A **Callout** (issue #14) is the notification/response event — who was
  invited and how they factually responded.
- An **Incident** is the durable administrative record — what was
  reported and what the organization later recorded about it.

A callout may exist with no incident, and an incident may exist with no
callout. When an incident does link to a callout the relationship is
one-to-one: `Incident.calloutId` carries a unique constraint, so at most
one incident record references a given callout. The link can be set at
creation or added once later via the explicit link action; it never
moves — a wrong link is corrected through the audit trail, not silent
retargeting. Creating an incident never rewrites the callout: its
invitations, responses, and notification history remain the standalone
record, linked rather than copied.

Creating an incident from a callout prefills only the factual title and
report text; **callout responses are never used to infer incident
participants**. An invitee answering `COMING` is a response fact, not a
participation fact — participation is recorded explicitly, separately.

## `Incident` — the record

Organization-scoped. Fields:

- `reference` — human-facing identifier `"INC-<n>"` allocated from the
  per-organization `IncidentSequence` row inside the creation
  transaction (`@@unique([organizationId, reference])`). Concurrent
  creations can never mint the same reference.
- `calloutId` — optional link, `@@unique([calloutId, organizationId])`.
- `title`, `summary` — the initial report, verbatim.
- `status` — `DRAFT` / `OPEN` / `CLOSED` (see lifecycle).
- Factual manual instants: `reportedAt`, `departedAt`, `onSceneAt`,
  `returnedAt`. These are entered as wall time in the organization's
  timezone and stored as instants; unknown times stay null — nothing is
  fabricated from surrounding events. They carry no operational meaning.
- Lifecycle instants: `openedAt`, `closedAt`, `closedByAuthIdentityId`.
- `createdByAuthIdentityId`, `createdAt`, `updatedAt`.

All children carry `organizationId` denormalized and bind parents via
composite foreign keys (`incidentId + organizationId`), so a
participation, note, or history row can never point across
organizations. `onDelete: Restrict` throughout — incidents and their
history are never hard-deleted through the application.

## Lifecycle

Deliberately small — it describes the state of the _record_, never the
operation:

- **DRAFT** — the record is being assembled.
- **OPEN** — the record is active/in progress from a recordkeeping
  perspective. This says nothing about operational command state.
- **CLOSED** — a human closed the record. Not immutable: corrections
  remain possible through the audited correction path.

Allowed transitions (validated server-side, row-locked, each writes a
`STATUS_CHANGED` timeline event): `DRAFT → OPEN`, `DRAFT → CLOSED`
(record-only entry), `OPEN → CLOSED`, `CLOSED → OPEN` (explicit human
reopen — `closedAt` clears, the earlier close stays in the timeline).
A transition to the current status is a quiet no-op, so double-submits
and racing closes write no duplicate history.

## Participants

### `IncidentMember`

Explicit fact: "this member was recorded as participating."
`memberId`, optional `roleNote` (free factual text — never a rank or
authority), `recordedAt`, `recordedByAuthIdentityId`.
`@@unique([incidentId, memberId])` prevents duplicates — a concurrent or
repeated add is a loud domain error.

### `IncidentAsset`

Same contract for durable assets: `assetId`, optional `note`,
`@@unique([incidentId, assetId])`. Listing an asset means it was
recorded as used — it implies nothing about readiness.

Removing either row deletes it and appends a `MEMBER_REMOVED` /
`ASSET_REMOVED` timeline event — the record that they were once recorded
(and when/by whom the row was removed) is preserved.

## Timeline — `IncidentTimelineEvent`

System-generated facts only: `INCIDENT_CREATED`, `STATUS_CHANGED`,
`CALLOUT_LINKED`, `MEMBER_ADDED`/`REMOVED`, `ASSET_ADDED`/`REMOVED`,
`CORRECTION_RECORDED`.

- `occurredAt` is when the recorded thing happened; `createdAt` is when
  SARbase wrote it. For system actions both are the action instant —
  kept distinct because a future source may carry its own time.
- `actorAuthIdentityId` is the scalar actor; `metadata` is a narrow JSON
  payload (participant names snapshotted so the sentence stays accurate
  after renames).
- Ordering is deterministic: `occurredAt`, then `createdAt`, then id.

The admin page merges these events with human notes into one
chronological feed, visually distinct — system facts are never styled as
human statements.

## Notes — `IncidentNote` + `IncidentNoteCorrection`

Human-authored text, never system truth: `kind` (`GENERAL` /
`AFTER_ACTION` / `CLOSING`), `body`, scalar `authorAuthIdentityId`,
optional `occurredAt` (a manually recorded observation time — a note can
honestly record "I saw X at 14:00" written later), `createdAt`.

Notes are never overwritten silently. Correcting a note updates `body`
and appends an `IncidentNoteCorrection` with `beforeBody`, `afterBody`,
optional `reason`, actor, and `createdAt` — the original wording is
always recoverable, and the UI shows correction history. A same-body
submission writes nothing.

A correction also carries a denormalized `incidentId` for org-scoped
incident-history queries; the composite foreign key
`(noteId, incidentId, organizationId) → IncidentNote(id, incidentId,
organizationId)` makes the database itself reject a correction whose
incident differs from its note's — the denormalized column cannot
drift.

## Material corrections — `IncidentChange`

Editing material fields (`title`, `summary`, the four factual
timestamps) writes a typed before/after `IncidentChange` row in the same
transaction as the update — a correction cannot commit without its audit
snapshot, and a failed mutation rolls back both. `reason` is persisted;
on a CLOSED incident it is required. No-change submissions write no
history and no timeline noise. The incident row is locked (`FOR UPDATE`)
inside each mutation transaction, so concurrent corrections serialize
and the audit chain is consistent (each `before` equals the previous
`after`).

## Closed incidents

- Ordinary mutation is unrestricted by status except one rule: on a
  CLOSED incident, a material-field correction requires a reason
  (`IncidentCorrectionReasonError` otherwise).
- A correction never reopens the record — `status` stays `CLOSED`;
  reopening is a separate explicit transition.
- A no-change submission on a closed record does not demand a reason.

## Actor attribution — scalar ID policy

Every history row stores a plain `actorAuthIdentityId` with **no foreign
key** to `AuthIdentity`. History survives identity deletion; display
resolves best-effort (linked member's display name in the same org →
identity email → the raw id). Issue #32 aligned the older FK-pinned
audit tables (`InspectionRecordChange`, `MaintenanceRecordChange`,
`DefectChange`) to this same policy — it is now uniform across all
audit/history actor columns.

## Authorization — sensitive data

Incidents may contain casualty and personal details, so the **entire
incident surface is ADMIN-only**: `requireOrgAdminForIncident` and the
participant/note variants resolve the record's own `organizationId` from
the database and require a live `OrganizationAccess` ADMIN grant. A
foreign or fabricated id is indistinguishable from 404. There is no
member-facing or token-accessible incident read path — the public
`/respond` route never touches these tables, and callout token
possession grants no incident access. If a future issue needs
incident-scoped member roles, the seam is a second role check alongside
`requireOrgAdminForIncident`, not a loosening of it.

Admin surfaces: `/admin/organizations/{orgId}/incidents` (list +
manual creation) and `…/incidents/{id}` (summary, linked callout,
factual timestamps, participants, assets, unified timeline/notes feed,
correction history, edit/correct). A callout's detail page offers
"Create incident record" when no incident is linked.

## Seams for later issues

- **Attachments (#16):** `Incident`, `IncidentNote`, and
  `IncidentTimelineEvent` rows are stable parents; an attachment table
  can composite-FK to `(id, organizationId)` on any of them. No
  placeholder fields exist yet.
- **Search (#18):** `title`, `summary`, `reference`, and note bodies are
  plain text fields; `reportedAt` and status support filtering.
- **Reporting (#19):** instants are stored honestly in UTC with org-zone
  entry/display, so factual summaries (counts, date ranges, durations)
  can be computed without reinterpreting the data.
