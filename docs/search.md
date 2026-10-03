# Global search (issue #18)

Global search turns SARbase's accumulated records into usable
institutional memory: an admin types "3/8 line", "flares", a member
name, a serial number, an incident reference, or a vendor name and gets
grouped links back to the records they already have access to.

## Architecture

**Federated per-domain queries, merged in application code.** There is
no denormalized search table, no `tsvector` column, and no external
search service. Each searchable domain has one bounded Prisma query in
`src/lib/search/domains.ts`; `searchOrganizationRecords` in
`src/lib/search/search.ts` runs the domains the caller's role permits
in parallel and merges deterministic results.

This shape was chosen deliberately:

- **Authorization stays in the WHERE clause.** A record the caller
  cannot access is never selected, so it cannot leak through a result,
  a snippet, a count, or a suggestion endpoint. A unified search table
  would have to duplicate per-domain permission rules and could leak
  through denormalized rows; federated queries inherit each domain's
  existing scoping for free.
- **Strong domain integrity is preserved.** Results are real domain
  rows mapped to a display shape, not a second source of truth that can
  drift.
- **Expected scale does not justify an index pipeline.** SARbase
  organizations hold hundreds to low thousands of records per domain.
  Org-scoped `ILIKE` scans at that size are well within interactive
  budgets (see "Performance"), and the per-domain scan limit bounds the
  worst case.

### Registry seam

`SEARCH_DOMAINS` in `src/lib/search/domains.ts` is the extension point.
A domain entry is `{ type, adminOnly, search }` — an isolated searcher
plus a role flag. Adding Vendor/Expense search after issue #17 merges
is: write `searchVendors`/`searchExpenses`, append two registry entries.
No orchestration, routing, or UI change is required. The `adminOnly`
flag is also the seam for future member-visible domains.

## PostgreSQL features

v1 uses **case-insensitive `ILIKE` token matching only** (`contains` +
`mode: "insensitive"` via Prisma, always bound parameters):

- Every query token must appear in at least one searchable field of the
  record (AND across tokens, OR across fields). This makes "3/8 line"
  match "3/8 double-braid line", "oil marine" match a title + provider
  pair, and multi-word names match in any order.
- Each domain runs **two bounded passes** merged by id: an `equals`
  pass over the same fields, then the contains token scan. The exact
  pass exists so a buried identifier can't be starved by the 50-row
  scan cap — `INC-7` still surfaces when `INC-70`–`INC-79`, `INC-170`…
  fill the contains window.
- No `pg_trgm`, no `tsvector`, no generated columns, no new indexes,
  and no new extension. The migration surface for this feature is
  **zero** — nothing to enable on Neon, nothing to drift, nothing a new
  deployment must remember to provision.
- `%` and `_` in user input are literal — Prisma escapes LIKE
  metacharacters in `contains` filters.

If a future dataset makes trigram or full-text matching worthwhile,
`pg_trgm` is available on Neon and could be added behind a migration
plus a new match class — the registry and result contract would not
change. That is a documented upgrade path, not v1 scope.

## Query normalization and safety

`normalizeSearchQuery` (`src/lib/search/query.ts`):

- trims, collapses repeated whitespace, lowercases;
- preserves punctuation that carries meaning — slashes (`3/8`),
  hyphens (`INC-7`), apostrophes;
- minimum length **2** characters — shorter queries return an honest
  "not accepted" outcome rather than a scan;
- maximum length **100** characters — longer input is truncated and the
  query runs on the truncated form;
- dedupes tokens; beyond **8 tokens** the whole normalized string is
  matched as one phrase instead of silently dropping terms.

All matching uses bound parameters. There is no string interpolation
into SQL anywhere in the search path.

## Result shape

```
SearchResult {
  type        — member | unit | qualification | training | asset |
                inventory | location | inspection | maintenance |
                defect | incident | callout | document | attachment
  id, title, subtitle?, snippet?, href
}
```

`href` always points at an existing page — member records to the member
page, incidents/documents/callouts to their detail pages, maintenance
family records to the maintenance overview, attachments to the page of
the record they are attached to (resolved through the link tables).
Snippets are plain text windows built from the matched field at query
time — nothing is stored, and highlighting renders via safe React text
nodes, never injected HTML.

## Ranking

Deterministic and explainable — no opaque score:

1. **exact** — a searchable field equals the normalized query
   (`INC-7`, an asset tag, a serial number)
2. **prefix** — a field starts with the query
3. **phrase** — a field contains the full normalized query
4. **tokens** — all tokens covered by one field, then spread across
   fields

Within a class, ordering is `title` (case-insensitive), then `id` — so
the same query always returns the same order. Nothing ranks people by
attributes, participation, or perceived usefulness; a member name match
is a text match like any other.

## Limits

| bound                          | value                   |
| ------------------------------ | ----------------------- |
| per-domain scan (rows fetched) | 50                      |
| displayed results per group    | 8                       |
| overall groups                 | one per registered type |
| minimum query length           | 2 chars                 |
| maximum query length           | 100 chars (truncated)   |
| max matched tokens             | 8 (then phrase-only)    |

A group with more matches than the display limit reports "has more" —
the intended path is refining the query or applying a type filter, not
pagination. Type filtering (`?type=`) restricts to one domain.

## Authorization model

Every registered domain is `adminOnly` today, matching the application:
every record surface under `/admin` is ADMIN-gated, and the MEMBER role
exposes only the member's own account data on `/account`. Therefore:

- The search page (`/admin/organizations/{orgId}/search`) sits behind
  `requireOrgAdminOrNotFound`, the same gate as every admin page.
- `searchOrganizationRecords` independently filters the registry by
  role — a MEMBER caller gets an honestly empty outcome, not an error
  and not partial leakage.
- A caller with no `OrganizationAccess` row for the org gets the same
  empty outcome — indistinguishable from "no matches".
- Incident records, incident notes, attachment metadata, and document
  metadata are searched only under the admin domains, consistent with
  their existing ADMIN-only surfaces.

Member email is searchable for ADMINs only (the admin member page
already displays it). Member phone is not searched. Contact details are
never shown in result subtitles.

## Domains and fields searched

| type          | fields                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------- |
| member        | displayName, email                                                                                |
| unit          | name                                                                                              |
| qualification | definition name/description; record issuer, reference, notes, member, definition                  |
| training      | title, location, instructor, notes, follow-up, unit, lead member, topic labels                    |
| asset         | name, category, manufacturer, model, serial number, asset tag, vendor, notes                      |
| inventory     | name, category, vendor, unit of measure, notes, storage location                                  |
| location      | name, description, parent location, containing asset                                              |
| inspection    | definition name/description; record inspector, notes, asset, definition                           |
| maintenance   | plan name/description; record title, work performed, provider, notes, asset                       |
| defect        | title, description, reporter, resolution notes, asset, reporting member                           |
| incident      | reference, title, summary, note bodies                                                            |
| callout       | title, message, unit                                                                              |
| vendor        | name, contact name, email, phone, website, account reference, notes                               |
| expense       | reference, category, description, review/reimbursement notes, vendor, submitted-by/paid-by member |
| document      | title, category, notes                                                                            |
| attachment    | display filename, description — metadata only, ACTIVE rows only                                   |

## Boundaries

- **No binary attachment content search, no OCR.** Attachments match on
  `displayFilename`/`description` metadata only; file bytes are never
  read, and storage keys/providers are never exposed.
- **No semantic/AI search, no operational recommendations.** Results
  are factual record links.
- **No capability ranking.** Nothing here orders volunteers.

## Privacy and logging

The raw query text is **never logged** — queries routinely carry names,
casualty details, and vendor information, and `src/lib/logging.ts`
forbids content-shaped fields anyway. The single `search.executed`
event carries structural metrics only: organization id, actor id,
query-length bucket (short/medium/long), result count, duration. A
failing domain logs `search.domain_failed` with the safe error summary
(class/digest/code only) and contributes zero hits — one degraded
domain never blanks the page.

## Performance

Measured against a synthetic dataset of ~1,350 rows in one organization
(400 members, 400 assets, 200 inventory items, 200 incidents, 150
training events), a full multi-domain search completes well under one
second in the db test environment; the test asserts a generous bound to
catch accidental quadratic regressions rather than micro-benchmark.

Each domain is a pair of bounded queries (exact + contains; more where
a domain spans two tables, plus attachment parent resolution) — on the
order of two dozen small parallel queries per search, no N+1. At
SARbase scale no additional indexes are warranted. The benchmark
covers one organization with ~1,350 rows — `organizationId` narrows
each scan to one org's rows and `scanLimit` caps what is returned, but
organizations far larger than the fixture should re-validate with an
EXPLAIN pass before assuming the same headroom.
