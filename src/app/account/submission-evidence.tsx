import { listEntityAttachments } from "@/lib/domain/attachments";
import { attachmentScanLabel } from "@/lib/domain/malware-scan";

import { formatBytes } from "../admin/attachment-section";
import {
  AttachmentUploadForm,
  UnlinkAttachmentForm,
  ScanPendingRefresh,
} from "../admin/attachment-forms";
import {
  uploadMySubmissionAttachmentAction,
  prepareMySubmissionUploadAction,
  finalizeMySubmissionUploadAction,
  unlinkMySubmissionAttachmentAction,
} from "./actions";

/**
 * Evidence files on the caller's OWN pending submission (issue #71).
 *
 * Rendered only for submissions the page has already resolved to a
 * member linked to this identity — the bound actions re-verify
 * ownership server-side, so the submissionId here stays an untrusted
 * selector. Members can add files and remove links while the submission
 * is PENDING; physical deletion stays an administrator operation (the
 * tombstone policy preserves the record of what was uploaded).
 */
export async function SubmissionEvidenceSection({
  submissionId,
}: {
  submissionId: string;
}) {
  const rows = await listEntityAttachments("MEMBER_SUBMISSION", submissionId);
  const sectionId = `evidence-${submissionId}`;
  const anyScanPending = rows.some(
    (r) =>
      r.attachment.status === "ACTIVE" &&
      r.attachment.storageProvider === "s3" &&
      r.attachment.scanStatus === "PENDING",
  );

  return (
    <div aria-labelledby={`${sectionId}-heading`} className="mt-2">
      {anyScanPending && <ScanPendingRefresh />}
      <h4
        id={`${sectionId}-heading`}
        className="text-xs font-medium text-neutral-500"
      >
        Evidence files
      </h4>
      {rows.length === 0 ? (
        <p className="mt-1 text-xs text-neutral-500">No files attached yet.</p>
      ) : (
        <ul className="mt-1 space-y-1.5">
          {rows.map((row) => {
            const attachment = row.attachment;
            const deleted = attachment.status === "DELETED";
            const scanLabel = attachmentScanLabel(attachment);
            // Fail closed — downloadable only after a verified clean
            // scan (or on providers with no scanning).
            const scanCleared =
              attachment.storageProvider !== "s3" ||
              attachment.scanStatus === "CLEAN";
            const downloadable = !deleted && scanCleared;
            return (
              <li
                key={row.linkId}
                className="rounded border border-neutral-200 px-2.5 py-1.5"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {downloadable ? (
                    <a
                      href={`/api/attachments/${attachment.id}/download`}
                      className="text-xs font-medium text-neutral-900 underline"
                    >
                      {attachment.displayFilename}
                    </a>
                  ) : (
                    <span
                      className={`text-xs ${
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
                  {!deleted && (
                    <UnlinkAttachmentForm
                      action={unlinkMySubmissionAttachmentAction.bind(
                        null,
                        submissionId,
                        attachment.id,
                      )}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-2">
        <AttachmentUploadForm
          action={uploadMySubmissionAttachmentAction.bind(null, submissionId)}
          prepare={prepareMySubmissionUploadAction.bind(null, submissionId)}
          finalize={finalizeMySubmissionUploadAction.bind(null, submissionId)}
          idPrefix={sectionId}
        />
      </div>
    </div>
  );
}

/**
 * Evidence files on the caller's OWN verified qualification record
 * (issue #71) — read-only. Upload and unlink on verified records stay
 * administrator operations; members propose changes through the
 * submission flow instead. Downloads still pass the malware-scan gate
 * and the owner-scope authorization in the download route.
 */
export async function QualificationEvidenceList({
  qualificationId,
}: {
  qualificationId: string;
}) {
  const rows = await listEntityAttachments(
    "MEMBER_QUALIFICATION",
    qualificationId,
  );
  if (rows.length === 0) return null;
  return (
    <ul className="mt-1 space-y-1">
      {rows.map((row) => {
        const attachment = row.attachment;
        const deleted = attachment.status === "DELETED";
        const scanCleared =
          attachment.storageProvider !== "s3" ||
          attachment.scanStatus === "CLEAN";
        const downloadable = !deleted && scanCleared;
        return (
          <li
            key={row.linkId}
            className="flex flex-wrap items-baseline gap-x-2"
          >
            {downloadable ? (
              <a
                href={`/api/attachments/${attachment.id}/download`}
                className="text-xs font-medium text-neutral-900 underline"
              >
                {attachment.displayFilename}
              </a>
            ) : (
              <span
                className={`text-xs ${
                  deleted ? "text-neutral-500 line-through" : "text-neutral-700"
                }`}
              >
                {attachment.displayFilename}
              </span>
            )}
            <span className="text-xs text-neutral-500">
              {formatBytes(attachment.sizeBytes)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
