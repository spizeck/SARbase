import { ApiError, withApiObservability } from "@/lib/api";
import { isAuthorizationError } from "@/lib/auth/context";
import { getAuthContext } from "@/lib/auth/context";
import { ExportFilterError } from "@/lib/exports/filters";
import {
  ExportRateLimitedError,
  ExportTooLargeError,
  runCsvExport,
} from "@/lib/exports/service";

/**
 * Organization CSV export download (issue #19).
 *
 * GET-only and read-side, but it writes a DataExportEvent audit row
 * inside the export transaction — an export that cannot be audited is
 * never produced. Responses are download-only (`Content-Disposition:
 * attachment`, `nosniff`) and `private, no-store` so generated exports
 * are never shared-cached.
 *
 * Authorization is org-scoped ADMIN: the orgId and dataset key in the
 * URL are untrusted selectors — a foreign org, a non-admin caller, or
 * an unknown dataset key all collapse to the same opaque 404.
 */

interface RouteContext {
  params: Promise<{ orgId: string; dataset: string }>;
}

async function handleGet(request: Request, context: RouteContext) {
  const { orgId, dataset } = await context.params;

  const ctx = await getAuthContext();
  if (!ctx) {
    throw new ApiError("UNAUTHENTICATED", 401, "Authentication required.");
  }

  let result;
  try {
    result = await runCsvExport(
      ctx,
      orgId,
      dataset,
      new URL(request.url).searchParams,
    );
  } catch (error) {
    if (error instanceof ExportFilterError) {
      throw new ApiError("INVALID_FILTERS", 400, error.message);
    }
    if (error instanceof ExportRateLimitedError) {
      throw new ApiError(
        "RATE_LIMITED",
        429,
        "Too many exports. Please wait before retrying.",
        { retryAfterSeconds: error.retryAfterSeconds },
      );
    }
    if (error instanceof ExportTooLargeError) {
      throw new ApiError(
        "EXPORT_TOO_LARGE",
        400,
        "The dataset is too large to export this way.",
      );
    }
    if (isAuthorizationError(error)) {
      // Deliberate collapse: foreign org / non-admin / fabricated id
      // are indistinguishable from a nonexistent route.
      throw new ApiError("NOT_FOUND", 404, "Not found.");
    }
    throw error;
  }
  if (!result) {
    throw new ApiError("NOT_FOUND", 404, "Not found.");
  }

  return new Response(result.csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${result.filename}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}

export const GET = withApiObservability<Request, RouteContext>(
  "exports.dataset",
  handleGet,
);
