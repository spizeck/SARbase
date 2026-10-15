import {
  listEntityAttachments,
  type AttachmentEntityType,
} from "@/lib/domain/attachments";
import { resolveActorLabels } from "@/lib/domain/actors";

import { attachmentScanLabel } from "@/lib/domain/malware-scan";

import {
  deleteAttachmentAction,
  finalizeAttachmentUploadAction,
  prepareAttachmentUploadAction,
  recheckAttachmentScanAction,
  unlinkAttachmentAction,
  uploadAttachmentAction,
} from "./actions";
import {
  AttachmentUploadForm,
  DeleteAttachmentForm,
  RecheckScanForm,
  ScanPendingRefresh,
  UnlinkAttachmentForm,
} from "./attachment-forms";

/**
 * Record attachment section (issue #16) — the reusable list + upload UI
 * rendered on every attachable record's admin page.
 *
 * The caller has already verified ADMIN scope on the parent record.
 * `requireReason` marks targets inside a CLOSED incident's evidence set —
 * uploads, unlinks, and deletes then demand a recorded reason.
 */

export function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function AttachmentSection({
  entityType,
  entityId,
  organizationId,
  requireReason = false,
  heading = "Files",
  compact = false,
}: {
  entityType: AttachmentEntityType;
  entityId: string;
  organizationId: string;
  requireReason?: boolean;
  heading?: string;
  /** Compact layout for inline use inside table/detail rows. */
  compact?: boolean;
}) {
  const rows = await listEntityAttachments(entityType, entityId);

  // Best-effort uploader display: member display name in this org, then
  // identity email, then the raw id — the shared audit-actor policy.
  const labels = await resolveActorLabels(
    organizationId,
    rows.map((r) => r.createdByAuthIdentityId),
  );
  const actorName = (id: string) => labels.get(id) ?? id;

  const uploadAction = uploadAttachmentAction.bind(null, entityType, entityId);
  const sectionId = `attachments-${entityType.toLowerCase()}-${entityId}`;
  const anyScanPending = rows.some(
    (r) =>
      r.attachment.status === "ACTIVE" &&
      r.attachment.storageProvider === "s3" &&
      r.attachment.scanStatus === "PENDING",
  );

  return (
    <section
      aria-labelledby={`${sectionId}-heading`}
      className={compact ? "mt-3" : "mt-10"}
    >
      {anyScanPending && <ScanPendingRefresh />}
      <h3
        id={`${sectionId}-heading`}
        className={compact ? "text-sm font-medium" : "text-lg font-medium"}
      >
        {heading}
      </h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-600">No files attached.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rows.map((row) => {
            const attachment = row.attachment;
            const deleted = attachment.status === "DELETED";
            const scanLabel = attachmentScanLabel(attachment);
            // Fail closed — a file is a download link only after a
            // verified clean scan (or on providers with no scanning).
            const scanCleared =
              attachment.storageProvider !== "s3" ||
              attachment.scanStatus === "CLEAN";
            const downloadable = !deleted && scanCleared;
            return (
              <li
                key={row.linkId}
                className="rounded-md border border-neutral-200 px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {downloadable ? (
                    <a
                      href={`/api/attachments/${attachment.id}/download`}
                      className="text-sm font-medium text-neutral-900 underline"
                    >
                      {attachment.displayFilename}
                    </a>
                  ) : (
                    <span
                      className={`text-sm ${
                        deleted
                          ? "text-neutral-500 line-through"
                          : "text-neutral-700"
                      }`}
                    >
                      {attachment.displayFilename}
                    </span>
                  )}
                  <span className="text-xs text-neutral-500">
                    {formatBytes(attachment.sizeBytes)}
                  </span>
                  {deleted && (
                    <span className="text-xs font-medium text-red-700">
                      Deleted
                    </span>
                  )}
                  {!deleted && scanLabel && (
                    <span
                      className={`text-xs font-medium ${
                        attachment.scanStatus === "INFECTED" ||
                        attachment.scanStatus === "SCAN_FAILED"
                          ? "text-red-700"
                          : attachment.scanStatus === "PENDING"
                            ? "text-amber-700"
                            : "text-neutral-500"
                      }`}
                    >
                      {scanLabel}
                    </span>
                  )}
                  {attachment.description && (
                    <span className="text-xs text-neutral-600">
                      — {attachment.description}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
                  <span>
                    Uploaded {attachment.createdAt.toLocaleDateString("en-US")}{" "}
                    by {actorName(row.createdByAuthIdentityId)}
                  </span>
                  {!deleted && !scanCleared && (
                    <RecheckScanForm
                      action={recheckAttachmentScanAction.bind(
                        null,
                        attachment.id,
                      )}
                    />
                  )}
                  {!deleted && (
                    <>
                      <UnlinkAttachmentForm
                        action={unlinkAttachmentAction.bind(
                          null,
                          entityType,
                          entityId,
                          attachment.id,
                        )}
                        requireReason={requireReason}
                      />
                      <DeleteAttachmentForm
                        action={deleteAttachmentAction.bind(
                          null,
                          attachment.id,
                        )}
                        requireReason={requireReason}
                      />
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className={compact ? "mt-3 max-w-md" : "mt-4 max-w-lg"}>
        <AttachmentUploadForm
          action={uploadAction}
          prepare={prepareAttachmentUploadAction.bind(
            null,
            entityType,
            entityId,
          )}
          finalize={finalizeAttachmentUploadAction.bind(
            null,
            entityType,
            entityId,
          )}
          requireReason={requireReason}
          idPrefix={sectionId}
        />
      </div>
    </section>
  );
}
