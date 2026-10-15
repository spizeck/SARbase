import { describe, expect, it } from "vitest";

import {
  summarizeScanInventory,
  type AttachmentScanRow,
} from "./attachment-scan-inventory";

function row(partial: Partial<AttachmentScanRow>): AttachmentScanRow {
  return {
    organizationId: "org-1",
    storageProvider: "s3",
    scanStatus: "UNKNOWN",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    storageVersionId: "v1",
    storageETag: "e1",
    ...partial,
  };
}

describe("summarizeScanInventory", () => {
  it("counts every provider × status combination", () => {
    const summary = summarizeScanInventory([
      row({ storageProvider: "s3", scanStatus: "CLEAN" }),
      row({ storageProvider: "s3", scanStatus: "PENDING" }),
      row({ storageProvider: "local", scanStatus: "UNKNOWN" }),
    ]);

    expect(summary.byProviderStatus).toEqual({
      "s3/CLEAN": 1,
      "s3/PENDING": 1,
      "local/UNKNOWN": 1,
    });
  });

  it("counts only non-CLEAN s3 rows as blocked", () => {
    const summary = summarizeScanInventory([
      row({ scanStatus: "CLEAN" }),
      row({ scanStatus: "PENDING", organizationId: "org-1" }),
      row({ scanStatus: "INFECTED", organizationId: "org-2" }),
      // local rows are never gated by the scan pipeline
      row({ storageProvider: "local", scanStatus: "UNKNOWN" }),
    ]);

    expect(summary.blockedTotal).toBe(2);
    expect(summary.blockedByOrg).toEqual({ "org-1": 1, "org-2": 1 });
  });

  it("reports the oldest blocked row and the unbindable subset", () => {
    const summary = summarizeScanInventory([
      row({
        createdAt: new Date("2026-02-01T00:00:00Z"),
        scanStatus: "PENDING",
      }),
      row({
        createdAt: new Date("2025-11-01T00:00:00Z"),
        scanStatus: "UNKNOWN",
        storageVersionId: null,
        storageETag: null,
      }),
      row({ scanStatus: "CLEAN", createdAt: new Date("2020-01-01T00:00:00Z") }),
    ]);

    expect(summary.oldestBlockedAt).toBe("2025-11-01T00:00:00.000Z");
    expect(summary.unbindable).toBe(1);
  });

  it("returns an empty-but-valid summary for an empty table", () => {
    const summary = summarizeScanInventory([]);
    expect(summary.blockedTotal).toBe(0);
    expect(summary.oldestBlockedAt).toBeNull();
    expect(summary.byProviderStatus).toEqual({});
  });
});
