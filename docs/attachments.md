# Attachments and organizational documents (issue #16)

SARbase stores files as durable, organization-scoped metadata records behind a
provider-neutral storage boundary. Attachments are documentary evidence and
organizational records: incident photos, qualification certificates, inspection
sheets, maintenance invoices, manuals, registrations, insurance documents,
policies, SOPs, and general reference material.

> Uploaded files are treated as untrusted content. SARbase stores and serves
> them as documentary records; it does not infer operational conclusions from
> file contents.

Nothing in this layer performs OCR, image recognition, content classification,
readiness scoring, or any SAR operational judgment. The system stores,
retrieves, organizes, and audits files — that is the entire contract.

## Storage-provider abstraction

```
application intent → domain metadata + provider put → provider result →
Attachment row + append-only AttachmentEvent
```

| Layer             | Code                                                        |
| ----------------- | ----------------------------------------------------------- |
| Provider contract | `FileStorageProvider` (`src/lib/storage/provider.ts`)       |
| Local dev adapter | `LocalFileStorageProvider` (`src/lib/storage/local.ts`)     |
| Test fake         | `InMemoryFileStorageProvider` (`src/lib/storage/memory.ts`) |
| Cloud adapter     | `S3FileStorageProvider` (`src/lib/storage/s3.ts`)           |
| Resolution        | `resolveFileStorageProvider` (`src/lib/storage/resolve.ts`) |
| Domain            | `src/lib/domain/attachments.ts` — never sees SDK types      |

`FileStorageProvider` exposes `put`, `openRead`, `head`, and `delete`. All
provider failures normalize to `StorageError` with a small `StorageErrorCode`
(`config_missing`, `object_not_found`, `provider_unavailable`,
`provider_error`) — provider SDK
types and raw error strings never cross the boundary, so credentials, bucket
URLs, and request metadata cannot leak into logs or responses.

### Providers

- **`local`** (default outside production): objects under
  `FILE_STORAGE_LOCAL_ROOT` — a directory outside the source tree, gitignored.
  Self-hosters may use it in production but own filesystem backup.
- **`s3`**: any S3-compatible API (AWS S3, Cloudflare R2, MinIO) via
  `@aws-sdk/client-s3` + `@aws-sdk/s3-presigned-post`. Buckets are expected to
  be **private**; SARbase never builds public or presigned _read_ URLs — every
  download streams through the authorized route. The only signing is
  short-lived, write-only presigned POSTs for direct uploads (see below).
- **`memory`**: deterministic in-process fake for tests; never selectable via
  configuration at all — tests inject it directly.

Production fails closed: `FILE_STORAGE_PROVIDER` must be explicit, `s3` without
complete credentials is a configuration error, and `local` requires an explicit
`FILE_STORAGE_LOCAL_ROOT` (self-hosting is supported; an ephemeral default root
is not).

### Environment

`src/lib/env.ts` → `parseStorageEnvironment()` — lazy per-concern parsing; a
missing/invalid storage config fails at the provider boundary, never at import
time. See `.env.example` for the `FILE_STORAGE_*` variables. None are
`NEXT_PUBLIC_*`; credentials stay server-side.

## Data model

### `Attachment` — the durable file record

One row per stored object: `organizationId`, `displayFilename` (sanitized,
user-facing only), `mediaType` (validated allowlist), `sizeBytes`,
`storageProvider`, `storageKey`, `checksumSha256`, optional `description`,
`status` (`ACTIVE`/`DELETED`), `uploadedByAuthIdentityId` (scalar — history
outlives identity deletion), tombstone fields, timestamps.

No blobs in PostgreSQL. No public URLs. `@@unique([id, organizationId])`
enables composite same-org FKs; indexes cover org/time and org/checksum.

### Storage keys

Opaque and organization-scoped:

```
organizations/<organizationId>/attachments/<uuid>
```

Keys never contain filenames, member names, incident titles, or any other
business context. `displayFilename` is the only place a (sanitized) name
survives.

### Explicit link tables

Nine same-org link tables — `IncidentAttachment`, `IncidentNoteAttachment`,
`MemberQualificationAttachment`, `TrainingEventAttachment`, `AssetAttachment`,
`InspectionRecordAttachment`, `MaintenanceRecordAttachment`, `DefectAttachment`,
`ExpenseAttachment` (issue #17 receipts and invoices)
— each with a composite `(targetId, organizationId)` FK to the target,
composite `(attachmentId, organizationId)` FK to `Attachment`,
`@@unique([targetId, attachmentId])` for deduplication, scalar
`createdByAuthIdentityId`, and indexes. A free-form polymorphic `entityType` +
`entityId` link was deliberately rejected: PostgreSQL cannot FK-check a generic
id pair, and cross-organization integrity is a hard requirement.

### `AttachmentEvent` — append-only lifecycle history

One row per `UPLOADED` | `LINKED` | `UNLINKED` | `DELETED`: attachment id,
organization, snapshot of the linked entity type/id at event time, optional
reason, `storageDeleted` flag (whether physical object removal actually
succeeded — recorded honestly, never claimed on provider failure), scalar
`actorAuthIdentityId`, `createdAt`. Rows are never updated or deleted; both
FKs are `Restrict`. The file can be gone, the identity deleted, the link
removed — the history row still says what happened.

### `OrganizationDocument` + `OrganizationDocumentVersion`

Organization-level records that are not attached to another row — policies,
SOPs, manuals, insurance, registrations, forms.

- `OrganizationDocument`: `title`, `category`, `effectiveOn`, `expiresOn`,
  `notes`, `status` (`ACTIVE`/`ARCHIVED`), scalar creator.
- `OrganizationDocumentVersion`: append-oriented rows pointing at an
  `Attachment` with a monotonically increasing `versionNumber`. The current
  file is the highest `versionNumber`; replacing a policy **adds** a version —
  the old file stays downloadable and auditable.
- Archiving is a status flag, not deletion: the document and all versions
  remain, it just leaves the "current" list.

## Upload flow

Two paths exist behind the same policy. The preferred path on providers
that support it (S3) is **direct-to-store**, keeping file bytes off the
hosting platform entirely — the serverless request-body limit (~4.5 MB
on Vercel) never applies. Providers without direct-upload support fall
back to the classic **proxied** path.

### Direct-to-store (prepare → client POST → finalize)

```
client → prepare action  → authorized upload grant (presigned POST + ticket)
client → object store    → file bytes, straight to a staging key
client → finalize action → verified, promoted, recorded
```

1. **Prepare** — the form asks a server action for an upload grant with
   the declared name/type/size. The server resolves the target record,
   derives the real organization, enforces admin authorization, rate
   limits, and the protected-record reason rule, then validates the
   declared metadata (allowlisted type, extension/type consistency,
   ≤ 25 MiB). Only then does it mint:
   - a **presigned POST** (`createPresignedPost`) scoped to one exact
     staging key, with the declared `Content-Type` as an exact-match
     policy field and `content-length-range` pinned to the declared
     byte size — the store edge itself rejects a relabeled or resized
     upload. 15-minute expiry.
   - an **upload ticket** — an HMAC-SHA256-signed grant
     (`src/lib/storage/upload-ticket.ts`) binding staging key, final
     key, actor, declared type/size, and the same expiry. The signing
     secret derives from the S3 credential; rotating it rotates grants.
2. **Client upload** — the browser POSTs the signed fields plus the
   file straight to the bucket as multipart form data (the only way
   progress events exist). Bytes never touch the app.
3. **Finalize** — the client echoes the grant handles back. The server
   re-resolves the record and re-checks authorization and the reason
   rule, verifies the ticket (signature, expiry, actor, key pair,
   declared fields), verifies the staging key lives in this
   organization's staging namespace, `HEAD`s the staging object, then
   **streams it once** computing SHA-256 and sampling the head for the
   magic-byte/text checks — against the real stored bytes, not client
   claims. On success it `CopyObject`s staging → final key **pinned to
   the verified ETag** (`x-amz-copy-source-if-match` — the presigned
   POST stays valid until expiry, so a replayed grant cannot swap the
   object's bytes between verification and promotion), deletes the
   staging copy, and commits `Attachment` + link + `UPLOADED`/`LINKED`
   events in one transaction.
4. **Compensation** — a failed commit deletes the promoted object;
   a rejected staged object is deleted from staging. Finalize is
   idempotent: retrying a grant whose record already committed returns
   the existing row.

### Staged-object lifecycle

Unfinalized objects live under `staging/organizations/<orgId>/<uuid>` —
a prefix a bucket **lifecycle rule should expire** (e.g. delete after
7 days). Abandoned uploads therefore cost nothing forever, never
collide with the recorded `organizations/` namespace, and can never be
recorded without a ticket.

### Bucket CORS

The bucket must allow browser POSTs **from the app origin only**:

```json
[
  {
    "AllowedOrigins": ["https://<app-host>"],
    "AllowedMethods": ["POST"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3000
  }
]
```

### Minimal IAM posture

The credential needs: `PutObject` on `staging/*` (the browser POST is
signed by the server — the browser holds no credentials),
`GetObject`/`DeleteObject` on `staging/*` and `organizations/*`,
`PutObject` on `organizations/*` (proxied puts + promote copies), and
`HeadObject` (covered by `GetObject`) on both. Scope all of it to the
one bucket; a dedicated prefix or separate bucket per environment is
required — **production and preview never share writable storage**.

### Proxied fallback

`uploadAttachment` (and the document variants) in
`src/lib/domain/attachments.ts` — used when the configured provider
lacks direct-upload support (local dev, `memory` tests):

1. Resolve the **target record** and derive the real organization from it —
   caller-supplied ids are untrusted selectors only.
2. Validate metadata (zod) and the file: allowlisted media type, extension
   sanity check against the declared type, magic-byte signature check for the
   formats that have one (PDF, JPEG, PNG, WebP, ZIP-based DOCX/XLSX), ≤ 25 MiB
   (`ATTACHMENT_MAX_BYTES`), non-empty.
3. Sanitize `displayFilename`: basename, control characters stripped, length
   capped — never a storage key.
4. Generate the opaque key; `storage.put` the bytes; compute SHA-256
   server-side.
5. `Attachment` + link row + `UPLOADED`/`LINKED` events in one transaction.
6. If persistence fails after the object landed, best-effort
   `storage.delete` compensates for the orphan; the failure still propagates.

The DB transaction opens only after the object is stored — no long-held
transaction across a network upload.

## Download flow

`GET /api/attachments/[attachmentId]/download`:

1. Require auth; resolve the attachment; derive its organization from the row.
2. `requireOrgAdmin` against that organization — foreign-org and nonexistent
   ids get the same opaque 404.
3. `DELETED` attachments are not served.
4. Stream via the **recorded** `storageProvider` (each row names its provider,
   so a migrated store keeps serving old objects).
5. Headers: `Content-Type` from the row, `Content-Disposition: attachment`
   with an RFC 5987-encoded safe filename, `X-Content-Type-Options: nosniff`,
   private no-store cache control. Nothing renders uploaded content inline.

## Policy

| Rule            | Value                                                        |
| --------------- | ------------------------------------------------------------ |
| Max size        | 25 MiB per file                                              |
| Allowed types   | PDF, JPEG, PNG, WebP, plain text, CSV, DOCX, XLSX            |
| Rejected        | HTML, SVG, scripts/executables, archives, macros             |
| Signature check | magic bytes for PDF/JPEG/PNG/WebP/ZIP containers             |
| Checksum        | SHA-256, computed server-side at upload                      |
| Authorization   | organization ADMIN only; no member/public/callout-token path |

Checksum is for integrity verification and duplicate-content awareness
(`@@index([organizationId, checksumSha256])`), never authorization and never
auto-merge — two records may intentionally reference identical bytes.

## Deletion and retention

- **Unlink** removes the link row and appends `UNLINKED`; the file and its
  metadata survive.
- **Delete** tombstones: `status=DELETED`, `deletedAt`, `deletedByAuthIdentityId`,
  `DELETED` event. Link rows are retained (record pages render them as deleted
  with strikethrough — the historical association is itself evidence). Physical
  `storage.delete` is attempted and the outcome recorded in the event's
  `storageDeleted` flag — a provider failure is reported honestly, never claimed
  as success, and a later delete retries the physical removal.
- No hard-delete path exists. Tombstones and events persist.

SARbase provides the mechanics; each organization sets its own retention
policy. There is no automatic deletion scheduler.

## Protected records — reasoned mutations

Two record states protect their evidence set without freezing it:

- A `CLOSED` incident, and
- an `APPROVED` or already-`REIMBURSED` expense — financial evidence.

Attachment mutations (upload, unlink, delete of a linked file) on a
protected record require an explicit reason, which lands on the
resulting `AttachmentEvent` and mirrored record-history rows
(`IncidentTimelineEvent` / `ExpenseEvent` `ATTACHMENT_ADDED` /
`ATTACHMENT_REMOVED`). The rule lives in the domain's entity resolution
(`requiresReason`), not in the UI. The change is audited; it is not
silent.

## Security and privacy

- Files are never publicly addressable: private bucket semantics or a local
  directory; every read goes through the authorized route.
- Cross-organization access fails opaquely at both the domain and the FK
  level — a foreign admin cannot link to, list, download, or unlink another
  org's attachment even with a guessed id.
- Logs carry attachment/org ids, provider name, size, and outcome — never
  file bodies, raw filenames, signed URLs, credentials, or descriptions.
- **No malware scanning exists.** Treat every stored file as hostile: the
  allowlist, magic-byte checks, `attachment` disposition, and `nosniff` are
  the mitigation. A scanning seam can slot into the upload flow later.
- Callout response tokens and `/respond` paths have no attachment access.

## Backup and restore

The PostgreSQL backup (`npm run db:backup`, restore drill) covers **metadata
only** — attachment rows, links, documents, and audit events. File bytes live
in the configured object store:

- `local` provider → include `FILE_STORAGE_LOCAL_ROOT` in filesystem backups.
- `s3` provider → provider-side backup/versioning is an operator concern.

A database restore without the object store leaves honest tombstones-in-waiting:
metadata intact, objects unreachable (`object_not_found`), downloads failing
cleanly rather than serving wrong content.

## Future seams

- **#18 search** — `displayFilename`, `description`, document `title`/
  `category` are indexable metadata. File-content indexing/OCR is out of
  scope by design.
