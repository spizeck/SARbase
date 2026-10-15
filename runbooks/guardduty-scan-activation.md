# GuardDuty malware-scan activation

Ordered, reversible activation of `s3` attachment scan-gating for
SARbase. Written for operators: every step has a verification and the
procedure is safe to pause between phases. The ordering is deliberate —
**event delivery is proven BEFORE the application gate goes live**, so
no upload is ever stranded at `PENDING` by a dead pipeline.

Scope: production bucket `sarbase-documents-prod-983902695382`,
region `us-east-1`, account `983902695382`. Preview environments use a
separate stack, bucket, and token — never share them.

## Safety invariants (never do these)

- Never bulk-set `scanStatus = CLEAN` on historical rows — a clean
  state must come from a verified GuardDuty result for the recorded
  object version.
- Never delete or quarantine objects as a reaction to `INFECTED`
  without an owner-approved retention/incident decision — the bytes
  are evidence.
- Never reuse the production `MALWARE_SCAN_WEBHOOK_TOKEN` in preview.
- Never point the production rule at a preview deployment (or vice
  versa) — one stack per environment.
- Never log bearer tokens, object keys from untrusted input, or event
  bodies — the application already logs only event ids/outcomes.

## Phase 0 — pre-deployment checks

1. Confirm GuardDuty Malware Protection for S3 lists the production
   bucket as protected (GuardDuty console → Malware Protection for S3).
2. Confirm bucket versioning is enabled (bucket → Properties).
3. Run the inventory (read-only) and record the baseline:

   ```
   npm run attachments:scan-inventory
   ```

   Expect every historical `s3` row under `s3/UNKNOWN` — they will be
   blocked once the gate ships. Share the blocked-by-organization
   counts with the owners before proceeding; blocked historical files
   are the visible impact of activation.

4. Confirm the app IAM credential has the tagging actions from
   `docs/attachments.md` (IAM policy) — `s3:GetObjectTagging`,
   `s3:GetObjectVersionTagging` on `staging/*` + `organizations/*`,
   `s3:PutObjectTagging` on `organizations/*`. Apply the IAM change
   first; it is additive and safe before the code ships.

## Phase 1 — Vercel configuration (no deploy yet)

Set in the **Production** environment scope — they take effect on the
next deployment:

| Variable                      | Value                             |
| ----------------------------- | --------------------------------- |
| `MALWARE_SCAN_WEBHOOK_TOKEN`  | ≥32 random chars — generate fresh |
| `MALWARE_SCAN_AWS_ACCOUNT_ID` | `983902695382`                    |

Generate the token (`openssl rand -hex 32` or equivalent) and keep the
plaintext only until step 2 of Phase 2.

## Phase 2 — AWS event delivery (before the app deploys)

Deploy the CloudFormation stack from `infra/guardduty-scan-events.yaml`:

```
aws cloudformation deploy \
  --stack-name sarbase-prod-guardduty-scan-events \
  --region us-east-1 \
  --parameter-overrides \
    EnvironmentName=prod \
    AppBaseUrl=https://<production-domain> \
    S3BucketName=sarbase-documents-prod-983902695382 \
    WebhookBearerToken=<the generated token> \
    AlarmTopicArn=<optional SNS topic ARN> \
  --capabilities CAPABILITY_NAMED_IAM
```

Verify:

- Rule `sarbase-prod-guardduty-scan-result` is ENABLED on the default
  bus, pattern bucket `sarbase-documents-prod-983902695382`, key prefix
  `organizations/`.
- API destination targets `https://<domain>/api/internal/guardduty-scan-result`.
- DLQ `sarbase-prod-guardduty-scan-dlq` exists; alarm
  `sarbase-prod-guardduty-scan-dlq` is configured.
- The Events-managed Secrets Manager secret for the connection exists.
  You never need to read it — EventBridge manages rotation storage.

**Smoke the endpoint contract** (before the app build has the env
vars, the endpoint answers 503 — that still proves reachability):

```
curl -i -X POST https://<domain>/api/internal/guardduty-scan-result \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"id":"activation-probe"}'
```

`503` or `400` (never a hang or a redirect) = the route is reachable.
A `404` means the code is not deployed yet — expected until Phase 3.

## Phase 3 — enable GuardDuty post-scan tagging

GuardDuty console → Malware Protection for S3 → the bucket's plan →
Edit → enable **"Add the scan result status as tags"**
(`GuardDutyMalwareScanStatus`). Verify by scanning a throwaway object:
put a small test file under `staging/`, then
`aws s3api get-object-tagging --bucket <b> --key <k>` returns
`GuardDutyMalwareScanStatus` after a few minutes.

## Phase 4 — application deployment

1. Merge PR #70 (the scan-gate implementation). The migration is
   additive — `scanStatus`, `scanResultStatus`, `scanStatusReason`,
   `scannedAt`, `scanEventId`, `storageVersionId`, `storageETag`,
   `AttachmentScanEvent`; existing rows default to `UNKNOWN`.
2. Deploy production — `prisma migrate deploy` runs in the release
   step; confirm `prisma migrate status` is clean afterward.
3. Existing attachments become blocked the moment the deployment is
   live — that is expected and was measured in Phase 0.

## Phase 5 — verify the full lifecycle

1. **Clean file**: as an org admin, upload an ordinary PDF. Expect the
   UI to show "Scanning for malware", then "Scan complete" within a
   few minutes, then download works. In the DB the row transitions
   `PENDING → CLEAN` and an `AttachmentScanEvent` row records
   `APPLIED_CLEAN`.
2. **EICAR**: upload a `.txt` containing the EICAR test string —
   expect `THREATS_FOUND`, `INFECTED`, the UI shows
   "File blocked — security threat detected", downloads return 423.
   EICAR is an inert industry-standard test string, not malware.
3. **DLQ check**: `aws sqs get-queue-attributes` on the DLQ should show
   zero visible messages.
4. **Ledger check**: `AttachmentScanEvent` shows the two test events
   with the right outcomes; nothing stuck at `RECEIVED`.

## Phase 6 — historical backfill (owner decision required)

For each blocked historical attachment, in order of preference:

1. **Trigger a rescan** — `aws s3api copy-object` the object onto its
   own key. Versioning creates a NEW version; update the row's
   `storageVersionId`/`storageETag` to the copy response values, then
   the scan event clears it. Do this per-attachment with a reviewed
   script — never in an unreviewed bulk run.
2. **Tag reconciliation** — if GuardDuty already scanned the object,
   the admin "Recheck scan" action clears it when the tag matches the
   recorded version.
3. **Leave blocked** — objects that cannot be scanned stay `UNKNOWN`;
   downloads stay refused. Do not bulk-mark them clean.

Re-run `attachments:scan-inventory` after any backfill to confirm.

## Monitoring (standing)

- CloudWatch alarm `sarbase-prod-guardduty-scan-dlq` — terminal
  delivery failures. On fire: inspect DLQ messages (id + body), fix
  the cause (usually app unavailability or a rotated token), then
  `aws sqs` redrive or replay the events to the endpoint.
- Application logs: `attachment.scan_event_rejected`,
  `attachment.scan_reconcile_failed`, `attachment.scan_result`,
  `attachment.scan_preapply_failed`.
- Periodic `attachments:scan-inventory` — sustained `s3/PENDING`
  older than ~10 minutes means delivery is broken.
- GuardDuty console for `THREATS_FOUND` findings — pair with the
  `APPLIED_INFECTED` ledger rows for incident response.

## Rollback

Application rollback is safe at any point: instant-restore the
previous Vercel deployment. Attachment rows keep their last scan
state; the gate disappears but the ledger and columns remain inert.
Rollback must NOT be paired with a bulk `CLEAN` backfill — reverting
the gate is the safe way to restore access while scanning is broken.

AWS-side rollback (optional): disable the EventBridge rule; the stack
can stay parked. Do not delete the DLQ without draining it — parked
messages are the delivery-failure audit trail.
