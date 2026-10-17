import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HTTP-boundary tests for the WhatsApp webhook route (issue #101).
 * Signature verification and payload parsing run for real; the
 * environment and the domain write are mocked — the tests pin the
 * contract: GET challenges need the verify token, POSTs need a valid
 * X-Hub-Signature-256 over the raw body, signed-but-foreign payloads
 * reject, and only verified events reach the domain.
 */

const { parseWhatsAppEnvironmentMock, recordWhatsappDeliveryEventsMock } =
  vi.hoisted(() => ({
    parseWhatsAppEnvironmentMock: vi.fn(),
    recordWhatsappDeliveryEventsMock: vi.fn(),
  }));

vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  log: vi.fn(),
  logExpected: vi.fn(),
  logOperational: vi.fn(),
}));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  parseWhatsAppEnvironment: parseWhatsAppEnvironmentMock,
}));
vi.mock("@/lib/domain/notification-delivery", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordWhatsappDeliveryEvents: recordWhatsappDeliveryEventsMock,
}));

import { GET, POST } from "./route";

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token-long-enough";
const PHONE_ID = "123456789012345";

function configured() {
  parseWhatsAppEnvironmentMock.mockReturnValue({
    WHATSAPP_APP_SECRET: APP_SECRET,
    WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  });
}

function signedBody(payload: unknown, secret = APP_SECRET) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret)
    .update(raw)
    .digest("hex")}`;
  return { raw, signature };
}

function callPost(payload: unknown, signature?: string | null) {
  const { raw, signature: sig } = signedBody(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const effective = signature === undefined ? sig : signature;
  if (effective) headers["x-hub-signature-256"] = effective;
  const request = new Request("http://localhost/api/webhooks/whatsapp", {
    method: "POST",
    headers,
    body: raw,
  });
  return POST(request, { params: Promise.resolve({}) });
}

function callGet(query: string) {
  const request = new Request(
    `http://localhost/api/webhooks/whatsapp?${query}`,
  );
  return GET(request, { params: Promise.resolve({}) });
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: PHONE_ID },
              statuses: [
                {
                  id: "wamid.TEST1",
                  status: "delivered",
                  timestamp: "1735000000",
                  recipient_id: "5994161234",
                },
              ],
              ...overrides,
            },
          },
        ],
      },
    ],
  };
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(body.error.code).toBe(code);
}

beforeEach(() => {
  vi.clearAllMocks();
  configured();
  recordWhatsappDeliveryEventsMock.mockResolvedValue({
    recorded: 1,
    deduplicated: 0,
    unmatched: 0,
  });
});

describe("GET /api/webhooks/whatsapp (subscription challenge)", () => {
  it("echoes the challenge for the correct verify token", async () => {
    const response = await callGet(
      `hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=abc123`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abc123");
  });

  it("rejects a wrong verify token with 403", async () => {
    await expectError(
      await callGet(
        "hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123",
      ),
      403,
      "FORBIDDEN",
    );
  });

  it("rejects missing challenge parameters with 403", async () => {
    await expectError(
      await callGet(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`),
      403,
      "FORBIDDEN",
    );
    await expectError(
      await callGet(
        `hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=x`,
      ),
      403,
      "FORBIDDEN",
    );
  });

  it("fails closed with 503 until the verify token is configured", async () => {
    parseWhatsAppEnvironmentMock.mockReturnValue({});
    await expectError(
      await callGet(
        `hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=x`,
      ),
      503,
      "WHATSAPP_WEBHOOK_NOT_CONFIGURED",
    );
  });
});

describe("POST /api/webhooks/whatsapp (status callbacks)", () => {
  it("fails closed with 503 until the app secret and phone id are configured", async () => {
    parseWhatsAppEnvironmentMock.mockReturnValue({});
    await expectError(
      await callPost(validPayload()),
      503,
      "WHATSAPP_WEBHOOK_NOT_CONFIGURED",
    );
    expect(recordWhatsappDeliveryEventsMock).not.toHaveBeenCalled();
  });

  it("rejects a missing signature with 401", async () => {
    await expectError(
      await callPost(validPayload(), null),
      401,
      "UNAUTHENTICATED",
    );
  });

  it("rejects a signature made with the wrong secret with 401", async () => {
    const { signature } = signedBody(validPayload(), "attacker-secret");
    await expectError(
      await callPost(validPayload(), signature),
      401,
      "UNAUTHENTICATED",
    );
    expect(recordWhatsappDeliveryEventsMock).not.toHaveBeenCalled();
  });

  it("rejects a valid signature over a tampered body with 401", async () => {
    const raw = JSON.stringify(validPayload());
    const signature = `sha256=${createHmac("sha256", APP_SECRET)
      .update(raw)
      .digest("hex")}`;
    const request = new Request("http://localhost/api/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      body: raw.replace("delivered", "read"),
    });
    await expectError(
      await POST(request, { params: Promise.resolve({}) }),
      401,
      "UNAUTHENTICATED",
    );
  });

  it("rejects a signed payload for a different phone number id with 400", async () => {
    const payload = validPayload();
    payload.entry[0]!.changes[0]!.value.metadata.phone_number_id = "999";
    await expectError(await callPost(payload), 400, "BAD_REQUEST");
    expect(recordWhatsappDeliveryEventsMock).not.toHaveBeenCalled();
  });

  it("rejects a signed payload with the wrong object type with 400", async () => {
    await expectError(
      await callPost({ object: "page", entry: [] }),
      400,
      "BAD_REQUEST",
    );
  });

  it("rejects a signed non-JSON body with 400", async () => {
    const raw = "not json{";
    const signature = `sha256=${createHmac("sha256", APP_SECRET)
      .update(raw)
      .digest("hex")}`;
    const request = new Request("http://localhost/api/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      body: raw,
    });
    await expectError(
      await POST(request, { params: Promise.resolve({}) }),
      400,
      "BAD_REQUEST",
    );
  });

  it("ingests a verified callback and returns the reconciliation outcome", async () => {
    const response = await callPost(validPayload());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      recorded: 1,
      deduplicated: 0,
      unmatched: 0,
    });
    const events = recordWhatsappDeliveryEventsMock.mock.calls[0]![0];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      providerMessageId: "wamid.TEST1",
      status: "DELIVERED",
    });
  });

  it("returns 200 for signed callbacks that match no attempts", async () => {
    recordWhatsappDeliveryEventsMock.mockResolvedValue({
      recorded: 0,
      deduplicated: 0,
      unmatched: 1,
    });
    const response = await callPost(validPayload());
    expect(response.status).toBe(200);
  });
});
