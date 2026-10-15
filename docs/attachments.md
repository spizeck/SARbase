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
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

`POST` is the only method the browser uses — uploads are presigned
POSTs (multipart form); downloads are proxied through the application,
so no `GET` exposure is needed or wanted. A preview bucket that serves
hosted smoke tests adds the preview origins to `AllowedOrigins`, e.g.
`"https://sar-base-*.vercel.app"`.

### Minimal IAM posture

The credential needs: `PutObject` on `staging/*` (the browser POST is
signed by the server — the browser holds no credentials),
`GetObject`/`DeleteObject` on `staging/*` and `organizations/*`,
`PutObject` on `organizations/*` (proxied puts + promote copies), and
`HeadObject` (covered by `GetObject`) on both. When GuardDuty Malware
Protection is enabled, add `s3:GetObjectTagging` (and
`s3:GetObjectVersionTagging` on a versioned bucket) — reconciliation
reads the `GuardDutyMalwareScanStatus` object tag. Scope all of it to
the one bucket; a dedicated prefix or separate bucket per environment
is required — **production and preview never share writable storage**.

## AWS S3 activation (operator runbook)

The `s3` provider uses exactly five AWS API operations — `PutObject`,
`GetObject`, `HeadObject`, `CopyObject`, `DeleteObject` — plus presigned
POST signing (no API call; the signature is computed locally). The
IAM actions those map to are `s3:PutObject`, `s3:GetObject`,
`s3:DeleteObject` — `HeadObject` is covered by `s3:GetObject`, and
`CopyObject` reads the source (`s3:GetObject`) and writes the
destination (`s3:PutObject`). The app never lists keys, so no
`s3:ListBucket` is granted. All key material lives under exactly two
prefixes: `staging/` and `organizations/`.

Provider-specific behavior the finalize path relies on:

- **`x-amz-copy-source-if-match`** (S3 `CopyObject` conditional
  header) pins the promotion to the ETag observed during verification
  — the TOCTOU guard. Native AWS S3 supports this; if you point
  `FILE_STORAGE_S3_ENDPOINT` at an S3-compatible store instead, verify
  it honors conditional copy headers (R2 and recent MinIO do; older
  MinIO silently ignores them).
- **ETag presence** — AWS S3 always returns an ETag from `HeadObject`.
  If a compatible store ever returned none, promotion would proceed
  unconditionally; do not use such a store.

### 1. Create the bucket

Production and preview get **separate buckets** — e.g.
`sarbase-files-prod` and `sarbase-files-preview`. Separate buckets are
the isolation boundary; prefix-sharing one bucket is weaker and not
recommended.

- **Region:** the AWS region closest to your Vercel function region —
  `us-east-1` is the default unless Vercel is configured otherwise.
- **Block Public Access:** all four settings ON (the default).
- **Object Ownership:** "Bucket owner enforced" (the default — ACLs
  disabled). The provider never sends ACLs; this must stay on.
- **Default encryption:** SSE-S3 (AES-256) — the default. SSE-KMS is
  optional hardening but adds key-policy complexity; only adopt it if
  you need key-level audit.
- **Versioning:** REQUIRED when GuardDuty Malware Protection for S3 is
  enabled (see [Malware scanning](#malware-scanning-guardduty-malware-protection-for-s3)).
  Scan results carry the object's `versionId`; with versioning ON the
  application binds each result to the exact bytes it scanned, so a
  stale result can never clear replacement bytes. Without versioning
  the binding falls back to the ETag — still fail-safe, but weaker.
  The cost is tombstone semantics: `DeleteObject` writes a delete
  marker and the bytes persist as a noncurrent version — add a
  lifecycle rule with `NoncurrentVersionExpiration` covering both
  `staging/` and `organizations/` so deleted content actually expires.
- **If malware scanning is not configured** (no GuardDuty protection
  plan on this bucket): versioning can be left OFF — SARbase does its
  own record versioning, and deletes are deliberate tombstones. Turn it
  ON when enabling the protection plan; existing objects keep working
  (their `versionId` is simply absent, and scan results bind by ETag).

### 2. Lifecycle rule — expire abandoned staging objects

Apply to prefix `staging/`, expire current versions after **7 days**:

```json
{
  "Rules": [
    {
      "ID": "expire-abandoned-staging",
      "Status": "Enabled",
      "Filter": { "Prefix": "staging/" },
      "Expiration": { "Days": 7 },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 7 }
    }
  ]
}
```

The `NoncurrentVersionExpiration` clause is harmless with versioning
off and essential with versioning on — without it a deleted staging
object's bytes persist as noncurrent versions. Confirm the console rule
is scoped to prefix `staging/` exactly: S3 lifecycle filters are literal
string prefixes, and the code writes only under
`staging/organizations/<orgId>/` (`ATTACHMENT_STAGING_PREFIX` in
`src/lib/domain/attachments.ts`).

This is the backstop for interrupted/abandoned direct uploads —
finalize deletes staging objects on success, the lifecycle catches
what never finalized.

### 3. CORS

Apply the CORS block from [Bucket CORS](#bucket-cors) above, with
`AllowedOrigins` set to the real app origin
(`https://<your-domain>`). Expect an `OPTIONS` preflight before each
upload — per the Fetch spec, attaching an `XMLHttpRequest.upload`
progress listener (which the upload forms do) upgrades the cross-origin
POST to a preflighted request even though multipart form data is
otherwise safelisted. The rule above answers it: `POST` in
`AllowedMethods` covers the preflight's `Access-Control-Request-Method`,
and `AllowedHeaders`/`AllowedOrigins` admit it.

### 4. IAM policy and credentials

Create a dedicated IAM user (e.g. `sarbase-app-prod`) with an inline or
attached policy scoped to one bucket and two prefixes — replace
`<BUCKET>`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SarbaseAttachmentObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": [
        "arn:aws:s3:::<BUCKET>/staging/*",
        "arn:aws:s3:::<BUCKET>/organizations/*"
      ]
    }
  ]
}
```

Then create an access key pair for that user ("Application running
outside AWS" use case). That pair feeds the `FILE_STORAGE_S3_*` Vercel
variables — **the secret access key also derives the HMAC key that
signs upload tickets**, so rotating it invalidates outstanding grants
(15-minute window; harmless). Rotate by creating a second key, updating
Vercel, redeploying, then deactivating the old key.

The preview bucket gets its own user and policy with the same shape —
**never reuse production credentials on a preview.**

### 5. Vercel environment variables

Production environment scope:

| Variable                            | Value                     |
| ----------------------------------- | ------------------------- |
| `FILE_STORAGE_PROVIDER`             | `s3`                      |
| `FILE_STORAGE_S3_BUCKET`            | `sarbase-files-prod`      |
| `FILE_STORAGE_S3_REGION`            | `us-east-1` (your region) |
| `FILE_STORAGE_S3_ACCESS_KEY_ID`     | the IAM access key        |
| `FILE_STORAGE_S3_SECRET_ACCESS_KEY` | the IAM secret — SECRET   |

Leave `FILE_STORAGE_S3_ENDPOINT` **unset** for AWS (it exists for
R2/MinIO).

Vercel environment variables are snapshotted at deploy time — a
deployment already running never sees a variable added afterward.
Saving these variables activates nothing until the next production
deployment; verify `FILE_STORAGE_PROVIDER` is exactly `s3` — a typo
fails closed at provider resolution (uploads error out) rather than
silently falling back to ephemeral local storage.

Preview environment scope — only if preview uploads should exercise
the real path: same five variables pointed at `sarbase-files-preview`
plus `ALLOW_S3_IN_PREVIEW=true` (the resolver fails closed without the
explicit opt-in — see `src/lib/storage/resolve.ts`).

### 6. Verify activation

After deploying with the variables set:

1. **Upload** — as an org admin, attach a PDF to an incident. In
   browser devtools the file POST goes to `https://<bucket>.s3.<region>
.amazonaws.com` — no large request body reaches Vercel. A `204`
   response is the normal AWS answer for presigned POST.
2. **Download** — the attachment row downloads through
   `/api/attachments/<id>/download` and the object exists under
   `organizations/<orgId>/attachments/` in the bucket.
3. **Access control** — `GET /api/attachments/<foreign-org-id>/download`
   returns 404; the bucket itself has no public access (confirm with
   the AWS "check public access" banner).
4. **Cleanup** — start an upload and abandon it; confirm the
   `staging/` lifecycle rule exists and will expire the object.
5. **Failure mode** — if `FILE_STORAGE_S3_*` values are wrong the
   provider fails closed at first use with a `StorageConfigError`;
   uploads surface a safe error, nothing is written.

### 7. Rollback

Object storage is independent of code deploys: rolling back the Vercel
deployment (instant rollback) restores the previous application
behavior while the bucket and objects stay untouched. If storage is
misconfigured, uploads/deletes fail with honest errors — nothing is
silently lost, and metadata rows never claim an object exists without
the object having been verified.

### 8. Cost posture

At attachment scale (≤ 25 MiB each, modest volume) S3 spend is
dominated by storage — pennies per GB-month; requests and the
staging-prefix lifecycle are negligible. Still set an **AWS Budgets**
alert (e.g. $5/month with email notification) so a pathological uploader
or a misconfigured loop shows up as an alert, not a bill.

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
4. Malware-scan gate: `s3` attachments must be `CLEAN` — anything else is
   `423 SCAN_NOT_CLEARED` (PENDING first attempts one tag reconciliation —
   see below).
5. Stream via the **recorded** `storageProvider` (each row names its provider,
   so a migrated store keeps serving old objects).
6. Headers: `Content-Type` from the row, `Content-Disposition: attachment`
   with an RFC 5987-encoded safe filename, `X-Content-Type-Options: nosniff`,
   private no-store cache control. Nothing renders uploaded content inline.

## Malware scanning (GuardDuty Malware Protection for S3)

S3-backed attachments are **download-blocked until a verified GuardDuty
scan result clears them**. The gate is fail-closed at the single byte
path (`openAttachmentDownload`): `PENDING`, `INFECTED`, `SCAN_FAILED`,
and `UNKNOWN` all refuse bytes; only `CLEAN` serves.

### Scan lifecycle states

| `scanStatus`  | Meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| `PENDING`     | Uploaded; awaiting a verified scan result                        |
| `CLEAN`       | `COMPLETED` + `NO_THREATS_FOUND` for the recorded object version |
| `INFECTED`    | `COMPLETED` + `THREATS_FOUND`                                    |
| `SCAN_FAILED` | `SKIPPED` (`UNSUPPORTED`/`ACCESS_DENIED`) or `FAILED`            |
| `UNKNOWN`     | No trustworthy result — incl. rows predating the integration     |

New S3 uploads start `PENDING` with the stored object's `versionId` /
`ETag` recorded at finalize. Historical rows keep the `UNKNOWN` default —
**they are never auto-cleaned**; see Backfill below.

### Data flow

```
browser → presigned POST → S3 staging object
        → finalize (server) → CopyObject to organizations/… (version pinned)
        → Attachment row { scanStatus: PENDING, storageVersionId, storageETag }

GuardDuty (protection plan on bucket) → EventBridge event
"GuardDuty Malware Protection Object Scan Result"
        → Lambda forwarder → POST /api/internal/guardduty-scan-result
        → AttachmentScanEvent row (immutable ledger, awsEventId unique)
        → Attachment.scanStatus updated IFF event versionId/ETag matches
          the recorded object version
```

Every received event is stored in `AttachmentScanEvent` before any
attachment mutation — the ledger is the audit trail: `outcome` records
`APPLIED_*`, `NO_ATTACHMENT` (re-applied when the attachment finalizes),
`STALE_VERSION`, `UNMAPPED_RESULT`, `DUPLICATE`, or `RECEIVED` (stored,
not yet evaluated).

### Endpoint authentication and validation

`POST /api/internal/guardduty-scan-result`:

- Requires `Authorization: Bearer $MALWARE_SCAN_WEBHOOK_TOKEN`
  (constant-time compare). Unconfigured token → 503; wrong token → 401.
- Validates the EventBridge envelope: `source === "aws.guardduty"`,
  `detail-type === "GuardDuty Malware Protection Object Scan Result"`,
  `account === MALWARE_SCAN_AWS_ACCOUNT_ID`, `region ===
FILE_STORAGE_S3_REGION`, `detail.s3ObjectDetails.bucketName ===
FILE_STORAGE_S3_BUCKET`, and `objectKey` matching
  `organizations/<org>/attachments/<id>`. Any mismatch → 400, logged
  with the event id only (bodies may carry attacker-controlled content
  and are never logged).
- Idempotent: `awsEventId` is unique; redelivery returns `DUPLICATE`
  with no state change.
- Ordered: an event whose `time` predates the recorded `scannedAt` cannot
  downgrade a terminal state.
- Version-bound: the event's `versionId` must equal the recorded
  `storageVersionId` (ETag fallback on unversioned stores) — a result
  for an overwritten object is recorded as `STALE_VERSION` and never
  clears the new bytes.

### Reconciliation (missed or delayed events)

Two recovery paths cover a stuck `PENDING`:

1. **Finalize-time pickup** — events that arrive between the S3 copy and
   the row commit are stored `NO_ATTACHMENT`, then applied when the
   attachment row is created.
2. **Tag reconciliation** — with the GuardDuty _post-scan tagging_ option
   enabled, `reconcileAttachmentScan` reads the
   `GuardDutyMalwareScanStatus` object tag (S3 `GetObjectTagging`) after
   verifying the tag belongs to the recorded object version. Triggered
   lazily on a `PENDING` download attempt and by the admin "Recheck scan"
   action. A tag for the wrong version is ignored.

The app also needs `s3:GetObjectTagging` (and `s3:GetObjectVersionTagging`
on versioned buckets) on the `organizations/*` prefix — see Minimal IAM
posture above.

### AWS setup (operator runbook)

The production bucket is `sarbase-documents-prod-983902695382`
(`us-east-1`). Steps — none of these are applied by code:

1. **Enable GuardDuty Malware Protection for S3** — GuardDuty console →
   Malware Protection for S3 → add the bucket. Enable **post-scan
   object tagging** (`GuardDutyMalwareScanStatus`) so reconciliation can
   read results without waiting on event delivery.
2. **Enable bucket versioning** (bucket → Properties → Bucket
   versioning → Enable) so every scan result pins to an object version;
   add the `NoncurrentVersionExpiration` lifecycle rule noted in
   [Create the bucket](#1-create-the-bucket).
3. **EventBridge rule** — default event bus, pattern:
   `source = aws.guardduty`, `detail-type = GuardDuty Malware Protection
Object Scan Result`, `detail.s3ObjectDetails.bucketName = <bucket>`.
4. **Lambda forwarder** — a minimal function (Python or Node) that POSTs
   the raw event body to `https://<app>/api/internal/guardduty-scan-result`
   with header `Authorization: Bearer <MALWARE_SCAN_WEBHOOK_TOKEN>`. Store
   the token in the Lambda environment or Secrets Manager; the function
   needs no other AWS permissions. Add a DLQ on the Lambda (or an
   SQS between EventBridge and Lambda) so undelivered events are retained
   for replay — a failed delivery must never silently leave a file
   permanently pending.
5. **Vercel env** — set `MALWARE_SCAN_WEBHOOK_TOKEN` (≥32 random chars,
   matching the Lambda) and `MALWARE_SCAN_AWS_ACCOUNT_ID` (`983902695382`
   for the production account). The bucket and region come from the
   existing `FILE_STORAGE_S3_*` variables.
6. **IAM** — extend the app credential per Minimal IAM posture with
   `s3:GetObjectTagging` + `s3:GetObjectVersionTagging` on
   `arn:aws:s3:::<bucket>/organizations/*`.

### End-to-end verification

- Clean file: upload any allowed file; confirm the row starts `PENDING`,
  transitions to `CLEAN` when the event arrives, and the download works.
- EICAR: upload a `.txt` containing the standard EICAR antivirus test
  string (`X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`).
  GuardDuty should report `THREATS_FOUND`; the file must stay blocked
  and show "File blocked — security threat detected". No real malware is
  involved — EICAR is an industry-standard inert test string.

### Historical attachments (backfill)

Rows created before this migration carry `scanStatus = UNKNOWN` and are
download-blocked on `s3`. Options, in order of preference:

1. **Rescan** — copy each object in place (`aws s3api copy-object` with
   the same key, or GuardDuty's on-demand scan if available) so a fresh
   scan event clears it. The copy produces a new version — update
   `storageVersionId`/`storageETag` from the copy response, or the new
   event will be recorded `STALE_VERSION`.
2. **Tag reconciliation** — if the protection plan scanned the objects
   already, the admin "Recheck scan" action applies the tag when the
   recorded version still matches.
3. **Temporary operator review** — for objects that cannot be scanned,
   keep them `UNKNOWN`/blocked; do not bulk-mark `CLEAN`.

### Monitoring

- `attachment.scan_event_rejected` log events — identity/shape failures.
- `attachment.scan_reconcile_failed` — tag-read failures.
- `attachment.scan_result` — every applied outcome; alert on
  `APPLIED_INFECTED` (possible live malware in the org's files) and on a
  sustained `PENDING` count (query `Attachment` where `scanStatus =
PENDING` older than ~10 minutes — indicates delivery failure).
- `AttachmentScanEvent` rows stuck at `RECEIVED` indicate a crash
  between ledger write and application — investigate, the attachment
  remains blocked.

### Rollback

Application rollback is safe: restore the previous deployment. Attachments
keep their last scan state — reverting removes the download gate (the
columns remain, inert). Forward-only mitigation: do NOT drop the
`AttachmentScanEvent` table or scan columns; the migration is pure
additive and can stay.

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
- **Malware scanning gates downloads.** S3-backed attachments are
  download-blocked until a verified GuardDuty scan result clears the
  exact object version — see
  [Malware scanning](#malware-scanning-guardduty-malware-protection-for-s3).
  The allowlist, magic-byte checks, `attachment` disposition, and
  `nosniff` remain as layered mitigations on top.
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

## Exporting attachment data (issue #19)

Two halves, deliberately separate:

- **Metadata** — the `attachments` CSV export carries `id`,
  `displayFilename`, `mediaType`, `sizeBytes`, `checksumSha256`,
  `description`, `status` (including `DELETED` tombstones — history
  stays honest), provider name, timestamps, and scalar actor ids.
  `attachment-links` maps every attachment to the records it hangs off
  via `(linkType, attachmentId, targetId)`. `storageKey` is **not**
  exported — it is a storage implementation detail, not a portability
  contract.
- **Files** — bytes are never inlined into CSV. Each file remains
  retrievable through the authorized download route above, correlated
  by `attachmentId` and verifiable against `checksumSha256`.
  Self-hosters scripting a storage-level bulk export can read
  `storageKey` directly from the `Attachment` table.

Full export semantics: `docs/reporting.md`.

## Future seams

- **#18 search** — `displayFilename`, `description`, document `title`/
  `category` are indexable metadata. File-content indexing/OCR is out of
  scope by design.
