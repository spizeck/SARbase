/**
 * WhatsApp webhook signature verification and payload parsing
 * (issue #101).
 *
 * Meta delivers two shapes of traffic to the webhook endpoint:
 *
 * - GET challenge: `hub.mode=subscribe`, `hub.verify_token`,
 *   `hub.challenge`. The endpoint must echo the challenge back when the
 *   verify token matches the shared token configured in the Meta app
 *   dashboard. Handled inline in the route (a token comparison, not a
 *   payload).
 * - POST events: a JSON document signed with the app secret in the
 *   `X-Hub-Signature-256` header (`sha256=<hex hmac>` over the RAW
 *   request body). Signature verification MUST happen before parsing —
 *   an unsigned or mis-signed body is never inspected beyond rejecting
 *   it.
 *
 * This module normalizes the delivery `statuses` callbacks only.
 * Inbound user messages, reactions, and other change fields are
 * ignored — SARbase does not converse over WhatsApp, it only sends and
 * reconciles delivery.
 *
 * Privacy: nothing here logs or returns raw payload content. Parsing
 * extracts ids, enum-like statuses, timestamps, and provider error
 * codes — never text fields, phone numbers, or profile data.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { NotificationDeliveryStatus } from "@prisma/client";

/** Meta unix-timestamp seconds → Date. */
const metaTimestamp = (seconds: string): Date | null => {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000);
};

/**
 * Constant-time HMAC verification of `X-Hub-Signature-256`.
 * `rawBody` must be the exact request bytes — verifying a parsed-then-
 * reserialized body silently breaks the signature.
 */
export function verifyWhatsappSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = signatureHeader.slice("sha256=".length).trim();
  if (!/^[0-9a-f]{64}$/i.test(expected)) return false;
  const actual = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected.toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One normalized delivery-status callback. */
export interface WhatsappStatusEvent {
  /** Meta `wamid` — matches `NotificationAttempt.providerMessageId`. */
  providerMessageId: string;
  status: NotificationDeliveryStatus;
  /** Provider-reported event time. */
  occurredAt: Date;
  /** Meta error code when status === FAILED — a code, never message text. */
  providerErrorCode: string | null;
}

export type WhatsappWebhookParseResult =
  | { ok: true; events: WhatsappStatusEvent[] }
  | {
      ok: false;
      reason:
        "not_whatsapp_object" | "phone_number_mismatch" | "malformed_status";
    };

const STATUS_MAP: Record<string, NotificationDeliveryStatus> = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Validate and normalize a WhatsApp webhook POST body.
 *
 * Security checks beyond JSON shape:
 * - `object` must be `whatsapp_business_account` — anything else is not
 *   a Meta delivery for this integration.
 * - every `statuses` change must carry `metadata.phone_number_id`
 *   equal to our configured sender id. The signature already
 *   authenticates Meta as the sender, but a single Meta app can host
 *   several phone numbers; this check pins callbacks to OUR sender so a
 *   misconfigured or multi-number app can't inject foreign wamids.
 *
 * A malformed status entry rejects the whole payload — partial
 * application of a signed payload would hide corruption behind a 200.
 */
export function parseWhatsappWebhookBody(
  body: unknown,
  expectedPhoneNumberId: string,
): WhatsappWebhookParseResult {
  if (!isRecord(body) || body.object !== "whatsapp_business_account") {
    return { ok: false, reason: "not_whatsapp_object" };
  }

  const events: WhatsappStatusEvent[] = [];
  for (const entry of asArray(body.entry)) {
    if (!isRecord(entry)) return { ok: false, reason: "malformed_status" };
    for (const change of asArray(entry.changes)) {
      if (!isRecord(change) || !isRecord(change.value)) {
        return { ok: false, reason: "malformed_status" };
      }
      const value = change.value;
      const metadata = isRecord(value.metadata) ? value.metadata : null;
      if (
        asArray(value.statuses).length > 0 &&
        metadata?.phone_number_id !== expectedPhoneNumberId
      ) {
        return { ok: false, reason: "phone_number_mismatch" };
      }
      for (const raw of asArray(value.statuses)) {
        if (!isRecord(raw)) return { ok: false, reason: "malformed_status" };
        const wamid = typeof raw.id === "string" ? raw.id : null;
        const occurredAt =
          typeof raw.timestamp === "string"
            ? metaTimestamp(raw.timestamp)
            : null;
        if (!wamid || !occurredAt) {
          return { ok: false, reason: "malformed_status" };
        }
        let providerErrorCode: string | null = null;
        const errors = asArray(raw.errors);
        if (errors.length > 0 && isRecord(errors[0])) {
          const code = errors[0].code;
          providerErrorCode =
            typeof code === "number" || typeof code === "string"
              ? String(code)
              : null;
        }
        events.push({
          providerMessageId: wamid,
          status:
            typeof raw.status === "string"
              ? (STATUS_MAP[raw.status] ?? "OTHER")
              : "OTHER",
          occurredAt,
          providerErrorCode,
        });
      }
    }
  }
  return { ok: true, events };
}
