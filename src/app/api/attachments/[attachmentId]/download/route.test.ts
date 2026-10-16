import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HTTP-boundary tests for the attachment download route. The domain
 * layer's coverage is deep (auth, tombstones, provider resolution,
 * staged-object verification) — this file pins the ROUTE's own
 * contract: which thrown error becomes which status code, and the
 * download-only response headers. Everything above the handler is
 * mocked; nothing here needs a database, a session, or storage.
 */

const {
  getAuthContextMock,
  requireAttachmentForStaffOrOwnerMock,
  openAttachmentDownloadMock,
  reconcileAttachmentScanMock,
  getFileStorageProviderMock,
  attachmentFindUniqueOrThrowMock,
} = vi.hoisted(() => ({
  getAuthContextMock: vi.fn(),
  requireAttachmentForStaffOrOwnerMock: vi.fn(),
  openAttachmentDownloadMock: vi.fn(),
  reconcileAttachmentScanMock: vi.fn(),
  getFileStorageProviderMock: vi.fn(),
  attachmentFindUniqueOrThrowMock: vi.fn(),
}));

vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  log: vi.fn(),
  logExpected: vi.fn(),
  logOperational: vi.fn(),
}));
vi.mock("@/lib/auth/context", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAuthContext: getAuthContextMock,
}));
vi.mock("@/lib/auth/authorize", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireAttachmentForStaffOrOwner: requireAttachmentForStaffOrOwnerMock,
}));
vi.mock("@/lib/domain/attachments", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openAttachmentDownload: openAttachmentDownloadMock,
}));
vi.mock("@/lib/domain/malware-scan", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reconcileAttachmentScan: reconcileAttachmentScanMock,
}));
vi.mock("@/lib/storage/resolve", () => ({
  getFileStorageProvider: getFileStorageProviderMock,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    attachment: { findUniqueOrThrow: attachmentFindUniqueOrThrowMock },
  },
}));

import { AuthorizationError } from "@/lib/auth/context";
import { AttachmentDeletedError } from "@/lib/domain/attachments";
import { AttachmentScanBlockedError } from "@/lib/domain/malware-scan";
import { StorageError } from "@/lib/storage/provider";

import { GET } from "./route";

const ATTACHMENT_ID = "att_1";
// requireAttachmentForStaffOrOwner returns the resolved attachment row; the
// route passes it straight to openAttachmentDownload.
const attachment = { id: ATTACHMENT_ID, organizationId: "org_1" };
const ctx = { identity: { id: "auth_1" }, members: [], access: [] };

function callGet(requestId?: string) {
  const request = new Request(
    `http://localhost/api/attachments/${ATTACHMENT_ID}/download`,
    requestId ? { headers: { "x-request-id": requestId } } : undefined,
  );
  return GET(request, {
    params: Promise.resolve({ attachmentId: ATTACHMENT_ID }),
  });
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(body.error.code).toBe(code);
  // The envelope carries a correlation id and never leaks internals.
  expect(body.error.referenceId).toBeTruthy();
  expect(response.headers.get("x-request-id")).toBe(body.error.referenceId);
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContextMock.mockResolvedValue(ctx);
  requireAttachmentForStaffOrOwnerMock.mockResolvedValue(attachment);
  openAttachmentDownloadMock.mockResolvedValue({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("file-bytes"));
        controller.close();
      },
    }),
    sizeBytes: 10,
    mediaType: "application/pdf",
    displayFilename: "report.pdf",
  });
});

describe("GET /api/attachments/[attachmentId]/download", () => {
  it("streams the object with download-only response headers", async () => {
    const response = await callGet();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("file-bytes");
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("echoes a well-formed inbound x-request-id", async () => {
    const response = await callGet("smoke-req-42");
    expect(response.headers.get("x-request-id")).toBe("smoke-req-42");
  });

  it("returns 401 when there is no authenticated context", async () => {
    getAuthContextMock.mockResolvedValue(null);
    await expectError(await callGet(), 401, "UNAUTHENTICATED");
    // The attachment is never resolved for an unauthenticated caller.
    expect(requireAttachmentForStaffOrOwnerMock).not.toHaveBeenCalled();
  });

  it("collapses foreign-org and fabricated ids to the same 404", async () => {
    requireAttachmentForStaffOrOwnerMock.mockRejectedValue(
      new AuthorizationError(),
    );
    await expectError(await callGet(), 404, "NOT_FOUND");
    // Nothing about the id's existence is disclosed downstream.
    expect(openAttachmentDownloadMock).not.toHaveBeenCalled();
  });

  it("returns 404 for a tombstoned attachment", async () => {
    openAttachmentDownloadMock.mockRejectedValue(new AttachmentDeletedError());
    await expectError(await callGet(), 404, "NOT_FOUND");
  });

  it("returns 410 when the stored object is gone", async () => {
    openAttachmentDownloadMock.mockRejectedValue(
      new StorageError("object_not_found", "missing object"),
    );
    await expectError(await callGet(), 410, "OBJECT_MISSING");
  });

  it("returns 503 when file storage is not configured", async () => {
    openAttachmentDownloadMock.mockRejectedValue(
      new StorageError("config_missing", "no provider"),
    );
    await expectError(await callGet(), 503, "STORAGE_NOT_CONFIGURED");
    // A configuration gap is not retryable from the client's side.
    const response = await callGet();
    expect(response.headers.get("Retry-After")).toBeNull();
  });

  it("returns 503 + Retry-After on transient storage failures", async () => {
    openAttachmentDownloadMock.mockRejectedValue(
      new StorageError("provider_unavailable", "connection reset"),
    );
    const response = await callGet();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe("STORAGE_UNAVAILABLE");
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("normalizes unexpected throws to a generic 500 envelope", async () => {
    openAttachmentDownloadMock.mockRejectedValue(
      new Error("provider text that must not leak"),
    );
    const response = await callGet();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).not.toContain("provider text");
  });

  it("returns 423 + Retry-After while a scan is pending and unreconciled", async () => {
    openAttachmentDownloadMock.mockRejectedValue(
      new AttachmentScanBlockedError("PENDING"),
    );
    reconcileAttachmentScanMock.mockResolvedValue({ outcome: "NO_TAG" });
    const response = await callGet();
    expect(response.status).toBe(423);
    const body = await response.json();
    expect(body.error.code).toBe("SCAN_NOT_CLEARED");
    expect(response.headers.get("Retry-After")).toBe("10");
  });

  it("serves a pending attachment once tag reconciliation clears it", async () => {
    openAttachmentDownloadMock
      .mockRejectedValueOnce(new AttachmentScanBlockedError("PENDING"))
      .mockResolvedValueOnce({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("file-bytes"));
            controller.close();
          },
        }),
        sizeBytes: 10,
        mediaType: "application/pdf",
        displayFilename: "report.pdf",
      });
    reconcileAttachmentScanMock.mockResolvedValue({ outcome: "APPLIED_CLEAN" });
    attachmentFindUniqueOrThrowMock.mockResolvedValue(attachment);
    const response = await callGet();
    expect(response.status).toBe(200);
    // The re-fetched row — not the stale pre-reconciliation one — is
    // what gets served.
    expect(attachmentFindUniqueOrThrowMock).toHaveBeenCalledWith({
      where: { id: ATTACHMENT_ID },
    });
    expect(openAttachmentDownloadMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed to 423 when reconciliation itself errors", async () => {
    openAttachmentDownloadMock.mockRejectedValue(
      new AttachmentScanBlockedError("PENDING"),
    );
    reconcileAttachmentScanMock.mockRejectedValue(new Error("s3 timeout"));
    const response = await callGet();
    expect(response.status).toBe(423);
    const body = await response.json();
    expect(body.error.code).toBe("SCAN_NOT_CLEARED");
  });

  it("blocks an infected file with 423 and no reconcile attempt", async () => {
    openAttachmentDownloadMock.mockRejectedValue(
      new AttachmentScanBlockedError("INFECTED"),
    );
    const response = await callGet();
    expect(response.status).toBe(423);
    const body = await response.json();
    expect(body.error.code).toBe("SCAN_NOT_CLEARED");
    expect(body.error.message).toContain("malware scan");
    // Only PENDING attempts lazy tag reconciliation.
    expect(reconcileAttachmentScanMock).not.toHaveBeenCalled();
  });

  it("blocks an unscanned (UNKNOWN) file with 423", async () => {
    openAttachmentDownloadMock.mockRejectedValue(
      new AttachmentScanBlockedError("UNKNOWN"),
    );
    const response = await callGet();
    expect(response.status).toBe(423);
    const body = await response.json();
    expect(body.error.code).toBe("SCAN_NOT_CLEARED");
  });
});
