// `npx tsx --env-file-if-exists=.env scripts/attachment-scan-inventory.ts`
//
// Inventory-only dry run for the malware-scan gate. Answers "what does
// enforcing scan clearance do to EXISTING attachments?" before anyone
// enables anything — read-only under all outcomes; it never mutates a
// row, never touches S3, never marks anything clean.
//
// Prints:
//   - attachment counts by storageProvider × scanStatus,
//   - per-organization breakdown of rows that would be BLOCKED
//     (every s3 row that is not CLEAN),
//   - the oldest blocked attachment (how far back the exposure runs),
//   - s3 rows missing both versionId and ETag (unbindable — a scan
//     result can never clear them; they need operator review),
//   - AttachmentScanEvent ledger posture (stuck RECEIVED rows, parked
//     NO_ATTACHMENT events awaiting a finalize).
//
// Use it before enabling enforcement (expect every historical s3 row
// to show UNKNOWN → blocked) and after a rescan backfill to confirm
// coverage.

import { pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

export interface AttachmentScanRow {
  organizationId: string;
  storageProvider: string;
  scanStatus: string;
  createdAt: Date;
  storageVersionId: string | null;
  storageETag: string | null;
}

export interface ScanInventorySummary {
  /** provider × status → count */
  byProviderStatus: Record<string, number>;
  /** organizationId → blocked s3 row count (s3 provider, not CLEAN) */
  blockedByOrg: Record<string, number>;
  blockedTotal: number;
  /** Oldest blocked s3 attachment — ISO string or null. */
  oldestBlockedAt: string | null;
  /**
   * s3 rows with neither identity field recorded — no scan result can
   * ever bind to them; they stay blocked until an operator re-uploads
   * or reviews.
   */
  unbindable: number;
}

/** Pure summarizer — unit-tested; the script only adds Prisma reads. */
export function summarizeScanInventory(
  rows: AttachmentScanRow[],
): ScanInventorySummary {
  const byProviderStatus: Record<string, number> = {};
  const blockedByOrg: Record<string, number> = {};
  let blockedTotal = 0;
  let oldestBlockedAt: string | null = null;
  let unbindable = 0;

  for (const row of rows) {
    const bucket = `${row.storageProvider}/${row.scanStatus}`;
    byProviderStatus[bucket] = (byProviderStatus[bucket] ?? 0) + 1;

    // Only s3 rows are gated — other providers have no scan pipeline.
    if (row.storageProvider !== "s3" || row.scanStatus === "CLEAN") continue;

    blockedTotal++;
    blockedByOrg[row.organizationId] =
      (blockedByOrg[row.organizationId] ?? 0) + 1;
    const iso = row.createdAt.toISOString();
    if (oldestBlockedAt === null || iso < oldestBlockedAt) {
      oldestBlockedAt = iso;
    }
    if (!row.storageVersionId && !row.storageETag) unbindable++;
  }

  return {
    byProviderStatus,
    blockedByOrg,
    blockedTotal,
    oldestBlockedAt,
    unbindable,
  };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.attachment.findMany({
      select: {
        organizationId: true,
        storageProvider: true,
        scanStatus: true,
        createdAt: true,
        storageVersionId: true,
        storageETag: true,
      },
    });
    const summary = summarizeScanInventory(rows);

    const ledgerByOutcome = await prisma.attachmentScanEvent.groupBy({
      by: ["outcome"],
      _count: { _all: true },
    });

    console.log("=== Attachment scan inventory (read-only) ===");
    console.log(`total attachments: ${rows.length}`);
    console.log("\nby provider/status:");
    for (const [key, count] of Object.entries(summary.byProviderStatus).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      console.log(`  ${key}: ${count}`);
    }
    console.log(
      `\nblocked s3 rows (any status but CLEAN): ${summary.blockedTotal}`,
    );
    console.log(`oldest blocked attachment: ${summary.oldestBlockedAt ?? "—"}`);
    console.log(`unbindable (no versionId/ETag): ${summary.unbindable}`);
    console.log("\nblocked by organization:");
    for (const [orgId, count] of Object.entries(summary.blockedByOrg).sort()) {
      console.log(`  ${orgId}: ${count}`);
    }
    console.log("\nscan event ledger by outcome:");
    for (const row of ledgerByOutcome.sort((a, b) =>
      a.outcome.localeCompare(b.outcome),
    )) {
      console.log(`  ${row.outcome}: ${row._count._all}`);
    }
    console.log(
      "\nRead-only — nothing was modified. A blocked count above zero " +
        "means those attachments cannot be downloaded until a verified " +
        "scan clears them; see docs/attachments.md (Historical attachments).",
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
