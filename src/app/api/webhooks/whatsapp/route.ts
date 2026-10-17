import { timingSafeEqual } from "node:crypto";

import { ApiError, withApiObservability } from "@/lib/api";
import { recordWhatsappDeliveryEvents } from "@/lib/domain/notification-delivery";
import { parseWhatsAppEnvironment } from "@/lib/env";
import { logExpected } from "@/lib/logging";
import {
  parseWhatsappWebhookBody,
  verifyWhatsappSignature,
} from "@/lib/notifications/whatsapp-webhook";

/**
 * Meta WhatsApp Business Platform webhook (issue #101).
 *
 * GET — subscription challenge. Meta calls this once at webhook
 * registration: `hub.mode=subscribe`, `hub.verify_token`,
 * `hub.challenge`. Echo the challenge only when the verify token
 * matches; anything else is 403.
 *
 * POST — status callbacks. Every delivery must carry a valid
 * `X-Hub-Signature-256` (HMAC-SHA256 of the RAW body with the app
 * secret). Signed bodies are parsed into normalized status events and
 * reconciled against notification attempts. Meta retries on non-2xx —
 * ingest is idempotent by the event-table unique constraint, so a 200
 * is returned for every well-formed signed payload, including ones
 * whose wamids match nothing.
 *
 * Fail-closed posture:
 * - 503 until WHATSAPP_APP_SECRET, WHATSAPP_PHONE_NUMBER_ID, and (for
 *   GET) WHATSAPP_WEBHOOK_VERIFY_TOKEN are configured — a partially
 *   configured deployment rejects rather than guessing.
 * - 401 for a missing/malformed/mismatched signature — the body is
 *   never parsed for unauthenticated traffic.
 * - 400 for signed bodies that fail shape or sender-id validation.
 * - Nothing is logged except rejection reasons — raw payloads may carry
 *   phone numbers and message metadata.
 */

function tokenEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function handleGet(request: Request) {
  const env = parseWhatsAppEnvironment();
  if (!env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    throw new ApiError(
      "WHATSAPP_WEBHOOK_NOT_CONFIGURED",
      503,
      "WhatsApp webhook verification is not configured on this deployment.",
    );
  }

  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (
    mode !== "subscribe" ||
    !token ||
    !challenge ||
    !tokenEquals(token, env.WHATSAPP_WEBHOOK_VERIFY_TOKEN)
  ) {
    throw new ApiError("FORBIDDEN", 403, "Webhook verification failed.");
  }

  // Meta expects the challenge echoed verbatim as plain text.
  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

async function handlePost(request: Request) {
  const env = parseWhatsAppEnvironment();
  if (!env.WHATSAPP_APP_SECRET || !env.WHATSAPP_PHONE_NUMBER_ID) {
    throw new ApiError(
      "WHATSAPP_WEBHOOK_NOT_CONFIGURED",
      503,
      "WhatsApp webhook ingest is not configured on this deployment.",
    );
  }

  const rawBody = await request.text();
  if (
    !verifyWhatsappSignature(
      rawBody,
      request.headers.get("x-hub-signature-256"),
      env.WHATSAPP_APP_SECRET,
    )
  ) {
    throw new ApiError("UNAUTHENTICATED", 401, "Authentication required.");
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new ApiError("BAD_REQUEST", 400, "Request body must be JSON.");
  }

  const parsed = parseWhatsappWebhookBody(body, env.WHATSAPP_PHONE_NUMBER_ID);
  if (!parsed.ok) {
    logExpected({
      event: "notification.whatsapp_webhook_rejected",
      subsystem: "notifications",
      outcome: "expected_failure",
      detail: { reason: parsed.reason },
    });
    throw new ApiError("BAD_REQUEST", 400, "Webhook payload rejected.");
  }

  const outcome = await recordWhatsappDeliveryEvents(parsed.events);
  return Response.json(outcome, { status: 200 });
}

// No path params — the context arg exists only to satisfy the router's
// handler contract.
type Ctx = { params: Promise<Record<string, never>> };

export const GET = withApiObservability<Request, Ctx>(
  "notifications.whatsapp_webhook_verify",
  (request) => handleGet(request),
);

export const POST = withApiObservability<Request, Ctx>(
  "notifications.whatsapp_webhook_events",
  (request) => handlePost(request),
);
