import { ApiError, withApiObservability } from "@/lib/api";
import { getAuthContext } from "@/lib/auth/context";
import { requireOrgAdminForAttachment } from "@/lib/auth/authorize";
import {
  AttachmentDeletedError,
  attachmentContentDisposition,
  openAttachmentDownload,
} from "@/lib/domain/attachments";
import {
  AttachmentScanBlockedError,
  reconcileAttachmentScan,
} from "@/lib/domain/malware-scan";
import { logExpected } from "@/lib/logging";
import { prisma } from "@/lib/prisma";
import { getFileStorageProvider } from "@/lib/storage/resolve";
import { StorageError } from "@/lib/storage/provider";

/**
 * Authorized attachment download (issue #16).
 *
 * Files are PRIVATE — there is no public URL shape for stored objects
 * and no signed URLs are issued or persisted. Every request streams the
 * bytes through this route AFTER the attachment row is resolved and the
 * caller's ADMIN grant for the attachment's own organizationId is
 * verified. An attachment id outside the caller's scope is
 * indistinguishable from a nonexistent one.
 *
 * Response posture: download-only. `Content-Disposition: attachment`
 * plus `nosniff` keep even permitted types (PDF, images) from executing
 * or rendering in the origin context — uploaded content is untrusted.
 */

interface RouteContext {
  params: Promise<{ attachmentId: string }>;
}

/** Factual user-facing message for a blocked download, by scan state. */
function scanBlockedMessage(scanStatus: string): string {
  switch (scanStatus) {
    case "PENDING":
      return "This file is still being scanned for malware. Please try again shortly.";
    case "INFECTED":
      return "This file was blocked by a malware scan.";
    default:
      // SCAN_FAILED, UNKNOWN, or a migrated/unscanned state — fail closed.
      return "This file is unavailable: security scan did not complete.";
  }
}

async function handleGet(_request: Request, context: RouteContext) {
  const { attachmentId } = await context.params;

  const ctx = await getAuthContext();
  if (!ctx) {
    throw new ApiError("UNAUTHENTICATED", 401, "Authentication required.");
  }

  let attachment;
  try {
    attachment = await requireOrgAdminForAttachment(ctx, attachmentId);
  } catch {
    // AuthorizationError deliberately collapses to a generic 404 — no
    // existence disclosure for foreign-org or fabricated ids.
    throw new ApiError("NOT_FOUND", 404, "Not found.");
  }

  let download;
  try {
    download = await openAttachmentDownload(attachment);
  } catch (error) {
    if (error instanceof AttachmentDeletedError) {
      throw new ApiError("NOT_FOUND", 404, "Not found.");
    }
    if (error instanceof AttachmentScanBlockedError) {
      if (error.scanStatus === "PENDING") {
        // Missed-event recovery: the EventBridge delivery may have
        // failed. Read the GuardDuty object tag once — if the object
        // version we recorded is already tagged clean, apply that
        // result and serve the download now. A reconciliation failure
        // never unblocks the file — it degrades to the same 423.
        try {
          const reconciled = await reconcileAttachmentScan(
            attachment,
            getFileStorageProvider(),
          );
          if (reconciled.outcome === "APPLIED_CLEAN") {
            const current = await prisma.attachment.findUniqueOrThrow({
              where: { id: attachment.id },
            });
            download = await openAttachmentDownload(current);
            return respondWithDownload(download);
          }
        } catch (reconcileError) {
          logExpected({
            event: "attachment.scan_reconcile_failed",
            subsystem: "attachments",
            entityType: "Attachment",
            entityId: attachment.id,
            errorName:
              reconcileError instanceof Error ? reconcileError.name : "unknown",
          });
        }
        throw new ApiError(
          "SCAN_NOT_CLEARED",
          423,
          scanBlockedMessage("PENDING"),
          { retryAfterSeconds: 10 },
        );
      }
      throw new ApiError(
        "SCAN_NOT_CLEARED",
        423,
        scanBlockedMessage(error.scanStatus),
      );
    }
    if (error instanceof StorageError) {
      if (error.code === "object_not_found") {
        // Metadata exists but the object is gone — an honest 410, logged
        // (data loss / failed cleanup is an operator fact worth seeing).
        logExpected({
          event: "attachment.object_missing",
          subsystem: "attachments",
          entityType: "Attachment",
          entityId: attachment.id,
          organizationId: attachment.organizationId,
        });
        throw new ApiError(
          "OBJECT_MISSING",
          410,
          "The file content is no longer available.",
        );
      }
      if (error.code === "config_missing") {
        throw new ApiError(
          "STORAGE_NOT_CONFIGURED",
          503,
          "File storage is not configured for this deployment.",
        );
      }
      throw new ApiError(
        "STORAGE_UNAVAILABLE",
        503,
        "File storage is temporarily unavailable. Please try again.",
        { retryAfterSeconds: 30, cause: error },
      );
    }
    throw error;
  }

  return respondWithDownload(download);
}

function respondWithDownload(
  download: Awaited<ReturnType<typeof openAttachmentDownload>>,
) {
  return new Response(download.stream, {
    status: 200,
    headers: {
      "content-type": download.mediaType,
      "content-disposition": attachmentContentDisposition(
        download.displayFilename,
      ),
      "content-length": String(download.sizeBytes),
      "x-content-type-options": "nosniff",
      // Private, per-request data — never shared-cached.
      "cache-control": "private, no-store",
    },
  });
}

export const GET = withApiObservability<Request, RouteContext>(
  "attachments.download",
  handleGet,
);
