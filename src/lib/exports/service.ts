/**
 * Export orchestration (issue #19).
 *
 * Pipeline — authentication and authorization happen before this
 * function runs; it owns everything from validation through audit:
 *
 *   filters validated → rate budget → one Repeatable Read transaction
 *   (rows + DataExportEvent insert) → CSV serialize → response.
 *
 * Guarantees:
 * - The exported rows and the audit event commit ATOMICALLY. If the
 *   DataExportEvent insert fails the whole transaction rolls back and
 *   no CSV is produced — a sensitive export never escapes its audit
 *   trail (fail closed).
 * - Repeatable Read means the dataset rows reflect one consistent
 *   snapshot even if records change while the export is generated.
 * - Rate limiting uses the shared fixed-window limiter. The bundled
 *   store is per-process — a best-effort throttle, documented as such.
 * - A hard row cap bounds in-memory generation. Expected SARbase
 *   datasets are hundreds-to-thousands of rows; the cap is a safety
 *   rail, not a quota.
 */

import { Prisma } from "@prisma/client";

import { AuthorizationError, type AuthContext } from "@/lib/auth/context";
import { requireOrgAdmin } from "@/lib/auth/authorize";
import { calendarDateInZone, formatDateOnly } from "@/lib/dates";
import { prisma } from "@/lib/prisma";
import { InMemoryRateLimitStore } from "@/lib/rate-limit/memory-store";
import { checkRateLimit } from "@/lib/rate-limit/rate-limit";
import { rateLimitKey } from "@/lib/rate-limit/keys";

import { toCsv } from "./csv";
import { getExportDataset, type DatasetDef } from "./datasets";
import { auditFilterMetadata, parseExportFilters } from "./filters";

/** Safety rail for in-memory CSV generation — see module docstring. */
export const MAX_EXPORT_ROWS = 50_000;

const exportRateLimitStore = new InMemoryRateLimitStore();
const EXPORT_RATE_LIMIT = { limit: 60, windowMs: 60_000 };

export class ExportRateLimitedError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("Export rate limit exceeded.");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ExportTooLargeError extends Error {}

export interface ExportResult {
  filename: string;
  csv: string;
  dataset: DatasetDef;
  recordCount: number;
}

/**
 * Generate one CSV export. Returns null when the dataset key is unknown
 * (the route renders that identically to a denied/fake key: 404).
 *
 * Throws AuthorizationError for non-admin or foreign-org scope,
 * ExportFilterError for invalid/unsupported filters, and
 * ExportRateLimitedError when the budget is exhausted.
 */
export async function runCsvExport(
  ctx: AuthContext,
  organizationId: string,
  datasetKey: string,
  params: URLSearchParams,
): Promise<ExportResult | null> {
  requireOrgAdmin(ctx, organizationId);
  const dataset = getExportDataset(datasetKey);
  if (!dataset) return null;
  const filters = parseExportFilters(params, dataset.filters);

  const rate = await checkRateLimit(
    exportRateLimitStore,
    rateLimitKey("export.generate", organizationId, ctx.identity.id),
    EXPORT_RATE_LIMIT,
  );
  if (!rate.allowed) {
    throw new ExportRateLimitedError(rate.retryAfterSeconds);
  }

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { timezone: true },
  });
  if (!organization) {
    // The org doesn't exist but the caller claimed admin access — the
    // grant is what matters; treat exactly like any inaccessible org.
    throw new AuthorizationError();
  }

  const table = await prisma.$transaction(
    async (tx) => {
      const t = await dataset.run(
        tx,
        organizationId,
        organization.timezone,
        filters,
      );
      if (t.rows.length > MAX_EXPORT_ROWS) {
        throw new ExportTooLargeError(
          `Dataset exceeds the ${MAX_EXPORT_ROWS}-row export limit.`,
        );
      }
      const auditFilters = auditFilterMetadata(filters);
      await tx.dataExportEvent.create({
        data: {
          organizationId,
          actorAuthIdentityId: ctx.identity.id,
          exportType: dataset.key,
          format: "csv",
          // NULL when unfiltered — never JSON null, which reads as a value.
          ...(auditFilters ? { filters: auditFilters } : {}),
          recordCount: t.rows.length,
        },
      });
      return t;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );

  const today = formatDateOnly(calendarDateInZone(organization.timezone));
  return {
    filename: `sarbase-${dataset.key}-${today}.csv`,
    csv: toCsv(table),
    dataset,
    recordCount: table.rows.length,
  };
}
