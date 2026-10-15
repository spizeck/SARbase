import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level contract for the CSV export endpoint (issue #19): auth
 * checks, opaque 404s, filter/429 mapping, and download headers.
 * getAuthContext and runCsvExport are stubbed — everything else is real.
 */

const { getAuthContextMock, runCsvExportMock } = vi.hoisted(() => ({
  getAuthContextMock: vi.fn(),
  runCsvExportMock: vi.fn(),
}));

vi.mock("@/lib/auth/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/context")>()),
  getAuthContext: getAuthContextMock,
}));

vi.mock("@/lib/exports/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exports/service")>()),
  runCsvExport: runCsvExportMock,
}));

import { AuthorizationError } from "@/lib/auth/context";
import { ExportFilterError } from "@/lib/exports/filters";
import { ExportRateLimitedError } from "@/lib/exports/service";

import { GET } from "./route";

const CTX = {
  params: Promise.resolve({ orgId: "org-1", dataset: "expenses" }),
};

function request(url = "https://app.test/x") {
  return new Request(url);
}

describe("GET /api/organizations/[orgId]/exports/[dataset]", () => {
  beforeEach(() => {
    getAuthContextMock.mockReset();
    runCsvExportMock.mockReset();
  });

  it("rejects unauthenticated callers", async () => {
    getAuthContextMock.mockResolvedValue(null);
    const res = await GET(request(), CTX);
    expect(res.status).toBe(401);
  });

  it("collapses denied org scope to an opaque 404", async () => {
    getAuthContextMock.mockResolvedValue({ identity: { id: "i1" } });
    runCsvExportMock.mockRejectedValue(new AuthorizationError());
    const res = await GET(request(), CTX);
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown datasets", async () => {
    getAuthContextMock.mockResolvedValue({ identity: { id: "i1" } });
    runCsvExportMock.mockResolvedValue(null);
    const res = await GET(request(), CTX);
    expect(res.status).toBe(404);
  });

  it("maps invalid filters to 400 and rate limits to 429", async () => {
    getAuthContextMock.mockResolvedValue({ identity: { id: "i1" } });
    runCsvExportMock.mockRejectedValueOnce(
      new ExportFilterError(
        "Invalid from — expected a YYYY-MM-DD calendar date.",
      ),
    );
    const bad = await GET(request(), CTX);
    expect(bad.status).toBe(400);

    runCsvExportMock.mockRejectedValueOnce(new ExportRateLimitedError(30));
    const limited = await GET(request(), CTX);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
  });

  it("serves CSV with download-only, no-store headers", async () => {
    getAuthContextMock.mockResolvedValue({ identity: { id: "i1" } });
    runCsvExportMock.mockResolvedValue({
      filename: "sarbase-expenses-2026-10-04.csv",
      csv: "﻿id,amountMinor\r\nx,1\r\n",
      recordCount: 1,
    });
    const res = await GET(request(), CTX);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="sarbase-expenses-2026-10-04.csv"',
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await res.text();
    expect(body).toContain("id,amountMinor");
    expect(runCsvExportMock).toHaveBeenCalledWith(
      { identity: { id: "i1" } },
      "org-1",
      "expenses",
      expect.any(URLSearchParams),
    );
  });
});
