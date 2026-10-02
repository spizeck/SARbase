import { createHmac } from "node:crypto";

import { resolveSiteUrl } from "@/lib/site";

/**
 * Callout response-link credentials (issue #14).
 *
 * The public `/respond?t=<token>` link is a bearer credential. It is
 * DERIVED, never stored: the token is
 *
 *   base64url(HMAC-SHA256(CALLOUT_RESPONSE_TOKEN_SECRET,
 *                          "callout-response:<calloutId>:<memberId>"))
 *
 * so the same value is securely recomputed on every send — initial
 * dispatch and retry alike — and only its SHA-256 hash is persisted on
 * the invitation for lookup. The persisted Notification body carries
 * CALLOUT_RESPONSE_URL_PLACEHOLDER instead of the live URL; the
 * notification layer substitutes the recomputed link at provider-send
 * time. No database row, log line, or telemetry payload ever holds the
 * raw token — it exists only in the outbound email and the member's
 * link. Rotating the secret changes every derivation, which revokes
 * all outstanding response links.
 */

/** Notification template name for callout invitation emails. */
export const CALLOUT_INVITATION_TEMPLATE = "callout_invitation";

/**
 * Written into the stored Notification.bodyText where the live
 * response link belongs. Substituted with the recomputed URL at
 * provider-send time so the durable record holds no usable credential.
 */
export const CALLOUT_RESPONSE_URL_PLACEHOLDER = "{callout-response-url}";

/**
 * The server-held pepper for token derivation. Required in production —
 * without it invitation activation fails loudly before any row is
 * written rather than emitting links under a shared fallback. Outside
 * production a fixed value keeps dev/test deterministic; it is a dev
 * convenience, never a credential boundary.
 */
function responseTokenPepper(): string {
  const pepper = process.env.CALLOUT_RESPONSE_TOKEN_SECRET;
  if (pepper) return pepper;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "CALLOUT_RESPONSE_TOKEN_SECRET is not configured; callout links cannot be issued.",
    );
  }
  return "sarbase-dev-callout-response-token-secret";
}

/** Fail-fast config check for callers about to write invitations. */
export function assertCalloutResponseTokenConfigured(): void {
  responseTokenPepper();
}

/**
 * The raw bearer token emailed to the invitee — recomputed identically
 * on every send. Never persist the return value.
 */
export function deriveInvitationResponseToken(
  calloutId: string,
  memberId: string,
): string {
  return createHmac("sha256", responseTokenPepper())
    .update(`callout-response:${calloutId}:${memberId}`)
    .digest("base64url");
}

/** The full link substituted into the email body at send time. */
export function invitationResponseUrl(
  calloutId: string,
  memberId: string,
): string {
  const token = deriveInvitationResponseToken(calloutId, memberId);
  return `${resolveSiteUrl()}/respond?t=${encodeURIComponent(token)}`;
}
