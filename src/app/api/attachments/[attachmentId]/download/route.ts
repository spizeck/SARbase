import { ApiError, withApiObservability } from "@/lib/api";
import { getAuthContext } from "@/lib/auth/context";
import { requireOrgAdminForAttachment } from "@/lib/auth/authorize";
import {
  AttachmentDeletedError,
  attachmentContentDisposition,
  openAttachmentDownload,
} from "@/lib/domain/attachments";
import { logExpected } from "@/lib/logging";
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
