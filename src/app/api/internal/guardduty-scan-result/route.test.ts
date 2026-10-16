import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HTTP-boundary tests for the GuardDuty scan-result ingest route. The
 * envelope parser is exercised for real (it is a pure function) — the
 * mocks cover only the environment and the ledger write, so these tests
 * pin the route's contract: configuration fails closed at 503, the
 * bearer token gates at 401, malformed or foreign events reject at 400,
 * and only a verified event reaches the domain.
 */

const {
  parseMalwareScanEnvironmentMock,
  parseStorageEnvironmentMock,
  recordGuardDutyScanEventMock,
} = vi.hoisted(() => ({
  parseMalwareScanEnvironmentMock: vi.fn(),
  parseStorageEnvironmentMock: vi.fn(),
  recordGuardDutyScanEventMock: vi.fn(),
}));

vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  log: vi.fn(),
  logExpected: vi.fn(),
  logOperational: vi.fn(),
}));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  parseMalwareScanEnvironment: parseMalwareScanEnvironmentMock,
  parseStorageEnvironment: parseStorageEnvironmentMock,
}));
vi.mock("@/lib/domain/malware-scan", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordGuardDutyScanEvent: recordGuardDutyScanEventMock,
}));

import { POST } from "./route";

const TOKEN = "test-token-that-is-long-enough-for-the-schema";
const ORG_ID = "org_1";
const BUCKET = "sarbase-documents-prod-983902695382";

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    time: new Date().toISOString(),
    account: "983902695382",
    region: "us-east-1",
    source: "aws.guardduty",
    "detail-type": "GuardDuty Malware Protection Object Scan Result",
    detail: {
      resourceType: "S3_OBJECT",
      scanStatus: "COMPLETED",
      s3ObjectDetails: {
        bucketName: BUCKET,
        objectKey: `organizations/${ORG_ID}/attachments/att-1`,
        versionId: "ver-1",
        eTag: "etag-1",
      },
      scanResultDetails: { scanResultStatus: "NO_THREATS_FOUND" },
    },
    ...overrides,
  };
}

function callPost(body: unknown, token?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const request = new Request(
    "http://localhost/api/internal/guardduty-scan-result",
    {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
  return POST(request, { params: Promise.resolve({}) });
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(body.error.code).toBe(code);
}

function configured() {
  parseMalwareScanEnvironmentMock.mockReturnValue({
    MALWARE_SCAN_WEBHOOK_TOKEN: TOKEN,
    MALWARE_SCAN_AWS_ACCOUNT_ID: "983902695382",
  });
  parseStorageEnvironmentMock.mockReturnValue({
    FILE_STORAGE_PROVIDER: "s3",
    FILE_STORAGE_S3_BUCKET: BUCKET,
    FILE_STORAGE_S3_REGION: "us-east-1",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  configured();
  recordGuardDutyScanEventMock.mockResolvedValue("APPLIED_CLEAN");
});

describe("POST /api/internal/guardduty-scan-result", () => {
  it("fails closed with 503 until the webhook token is configured", async () => {
    parseMalwareScanEnvironmentMock.mockReturnValue({
      MALWARE_SCAN_AWS_ACCOUNT_ID: "983902695382",
    });
    await expectError(
      await callPost(validEvent(), TOKEN),
      503,
      "SCAN_INGEST_NOT_CONFIGURED",
    );
    expect(recordGuardDutyScanEventMock).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the expected account or bucket is unset", async () => {
    parseMalwareScanEnvironmentMock.mockReturnValue({
      MALWARE_SCAN_WEBHOOK_TOKEN: TOKEN,
    });
    await expectError(
      await callPost(validEvent(), TOKEN),
      503,
      "SCAN_INGEST_NOT_CONFIGURED",
    );
    expect(recordGuardDutyScanEventMock).not.toHaveBeenCalled();
  });

  it("rejects a missing bearer token with 401", async () => {
    await expectError(await callPost(validEvent()), 401, "UNAUTHENTICATED");
    expect(recordGuardDutyScanEventMock).not.toHaveBeenCalled();
  });

  it("rejects a wrong bearer token with 401", async () => {
    await expectError(
      await callPost(validEvent(), "wrong-token-with-same-length-xxxx"),
      401,
      "UNAUTHENTICATED",
    );
    expect(recordGuardDutyScanEventMock).not.toHaveBeenCalled();
  });

  it("rejects a bearer token of a different length without throwing", async () => {
    await expectError(
      await callPost(validEvent(), "x"),
      401,
      "UNAUTHENTICATED",
    );
  });

  it("rejects a non-JSON body with 400", async () => {
    await expectError(await callPost("not json{", TOKEN), 400, "BAD_REQUEST");
    expect(recordGuardDutyScanEventMock).not.toHaveBeenCalled();
  });

  it("rejects an event naming a foreign bucket with 400", async () => {
    const event = validEvent();
    event.detail.s3ObjectDetails.bucketName = "someone-elses-bucket";
    await expectError(await callPost(event, TOKEN), 400, "BAD_REQUEST");
    expect(recordGuardDutyScanEventMock).not.toHaveBeenCalled();
  });

  it("rejects an event naming a foreign account with 400", async () => {
    await expectError(
      await callPost(validEvent({ account: "111111111111" }), TOKEN),
      400,
      "BAD_REQUEST",
    );
    expect(recordGuardDutyScanEventMock).not.toHaveBeenCalled();
  });

  it("rejects a non-attachment key shape with 400", async () => {
    const event = validEvent();
    event.detail.s3ObjectDetails.objectKey = `staging/${ORG_ID}/file`;
    await expectError(await callPost(event, TOKEN), 400, "BAD_REQUEST");
    expect(recordGuardDutyScanEventMock).not.toHaveBeenCalled();
  });

  it("rejects an event from another source with 400", async () => {
    await expectError(
      await callPost(validEvent({ source: "aws.s3" }), TOKEN),
      400,
      "BAD_REQUEST",
    );
  });

  it("applies a verified event and returns its outcome", async () => {
    const response = await callPost(validEvent(), TOKEN);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "APPLIED_CLEAN" });
    expect(recordGuardDutyScanEventMock).toHaveBeenCalledOnce();
    const input = recordGuardDutyScanEventMock.mock.calls[0]![0];
    expect(input.id).toBe("evt-1");
    expect(input.bucketName).toBe(BUCKET);
    expect(input.objectKey).toBe(`organizations/${ORG_ID}/attachments/att-1`);
    expect(input.versionId).toBe("ver-1");
  });

  it("reports duplicate redelivery as a 200 no-op", async () => {
    recordGuardDutyScanEventMock.mockResolvedValue("DUPLICATE");
    const response = await callPost(validEvent(), TOKEN);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "DUPLICATE" });
  });
});
