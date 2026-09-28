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

## Lifecycle and history

- Members are **deactivated/reactivated**, never deleted through the
  application. `INACTIVE` preserves identity and all historical
  references; incident, training, and expense records will later point
  at members that must still exist.
- Units and organizations have no app-level deletion workflow at all in
  this issue; the `Restrict` FKs make even administrative deletion
  conservative.
- Status changes are ordinary column updates today. **Deferred:** the
  audit-history work (a later issue) is expected to strengthen material
  history — who changed status, when — into durable audit records rather
  than relying on `updatedAt`.

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
( ) . -` pattern.
- `status`: `ACTIVE` | `INACTIVE`.
- Unit assignments: array of unit ids, all verified same-organization.
- Qualification definition: `name` required (1–120, trimmed),
  `description` optional ≤500.
- Member qualification: `definitionId` required; `issuedOn`/`expiresOn`
  optional `YYYY-MM-DD` calendar dates (impossible dates rejected; expiry
  may not precede issue when both exist); `issuer`/`reference` optional
  ≤120; `notes` optional ≤2000. Blank fields are absent, not errors.
