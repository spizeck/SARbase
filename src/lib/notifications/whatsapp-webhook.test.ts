import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

/**
 * Unit tests for Meta webhook signature verification and status
 * payload parsing (issue #101). All payloads are synthetic — no real
 * Meta traffic, phone numbers, or secrets.
 */

import {
  parseWhatsappWebhookBody,
  verifyWhatsappSignature,
} from "./whatsapp-webhook";

const SECRET = "test-app-secret-not-real";
const PHONE_ID = "123456789012345";

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function webhookBody(statuses: unknown[], phoneNumberId = PHONE_ID) {
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
              metadata: {
                display_phone_number: "15550001111",
                phone_number_id: phoneNumberId,
              },
              statuses,
            },
          },
        ],
      },
    ],
  };
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    id: "wamid.HBgMTEST",
    status: "delivered",
    timestamp: "1735000000",
    recipient_id: "5994161234",
    ...overrides,
  };
}

describe("verifyWhatsappSignature", () => {
  const body = JSON.stringify({ object: "whatsapp_business_account" });

  it("accepts a correctly signed body", () => {
    expect(verifyWhatsappSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a signature over a different body (tampering)", () => {
    const signed = sign(body);
    const tampered = body.replace("whatsapp", "evil");
    expect(verifyWhatsappSignature(tampered, signed, SECRET)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    expect(
      verifyWhatsappSignature(body, sign(body, "wrong-secret"), SECRET),
    ).toBe(false);
  });

  it("rejects missing, malformed, and non-hex headers", () => {
    expect(verifyWhatsappSignature(body, null, SECRET)).toBe(false);
    expect(verifyWhatsappSignature(body, "sha1=abc", SECRET)).toBe(false);
    expect(verifyWhatsappSignature(body, "sha256=zzzz", SECRET)).toBe(false);
    expect(verifyWhatsappSignature(body, "sha256=", SECRET)).toBe(false);
  });
});

describe("parseWhatsappWebhookBody", () => {
  it("normalizes every Meta status value", () => {
    const parsed = parseWhatsappWebhookBody(
      webhookBody([
        status({ id: "w1", status: "sent", timestamp: "1735000000" }),
        status({ id: "w2", status: "delivered", timestamp: "1735000001" }),
        status({ id: "w3", status: "read", timestamp: "1735000002" }),
        status({
          id: "w4",
          status: "failed",
          timestamp: "1735000003",
          errors: [{ code: 131047, title: "Re-engagement required" }],
        }),
      ]),
      PHONE_ID,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.events.map((e) => e.status)).toEqual([
      "SENT",
      "DELIVERED",
      "READ",
      "FAILED",
    ]);
    expect(parsed.events[0]!.occurredAt).toEqual(new Date(1735000000 * 1000));
    // The provider error CODE is kept — never the provider's title/message.
    expect(parsed.events[3]!.providerErrorCode).toBe("131047");
    expect(parsed.events[0]!.providerMessageId).toBe("w1");
  });

  it("maps unrecognized statuses to OTHER rather than dropping them", () => {
    const parsed = parseWhatsappWebhookBody(
      webhookBody([status({ status: "deleted" })]),
      PHONE_ID,
    );
    expect(parsed.ok && parsed.events[0]!.status).toBe("OTHER");
  });

  it("rejects payloads that are not a whatsapp_business_account object", () => {
    expect(parseWhatsappWebhookBody({ object: "page" }, PHONE_ID)).toEqual({
      ok: false,
      reason: "not_whatsapp_object",
    });
    expect(parseWhatsappWebhookBody(null, PHONE_ID)).toEqual({
      ok: false,
      reason: "not_whatsapp_object",
    });
  });

  it("rejects status callbacks addressed to a different phone number id", () => {
    const parsed = parseWhatsappWebhookBody(
      webhookBody([status()], "999999999999999"),
      PHONE_ID,
    );
    expect(parsed).toEqual({ ok: false, reason: "phone_number_mismatch" });
  });

  it("rejects status entries missing the wamid or timestamp", () => {
    expect(
      parseWhatsappWebhookBody(
        webhookBody([status({ id: undefined })]),
        PHONE_ID,
      ),
    ).toEqual({ ok: false, reason: "malformed_status" });
    expect(
      parseWhatsappWebhookBody(
        webhookBody([status({ timestamp: "not-a-number" })]),
        PHONE_ID,
      ),
    ).toEqual({ ok: false, reason: "malformed_status" });
    expect(
      parseWhatsappWebhookBody(webhookBody(["not-an-object"]), PHONE_ID),
    ).toEqual({ ok: false, reason: "malformed_status" });
  });

  it("ignores inbound messages and changes without statuses", () => {
    const body = webhookBody([]);
    (body.entry[0]!.changes[0]!.value as Record<string, unknown>).messages = [
      { from: "5994161234", type: "text", text: { body: "STOP" } },
    ];
    const parsed = parseWhatsappWebhookBody(body, PHONE_ID);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.events).toHaveLength(0);
  });
});
