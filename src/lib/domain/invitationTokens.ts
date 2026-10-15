import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { resolveSiteUrl } from "@/lib/site";

/**
 * Member-invitation link credentials.
 *
 * The emailed `/invite?t=<token>` link is a bearer credential. It is
 * DERIVED, never stored: the token is
 *
 *   base64url(HMAC-SHA256(MEMBER_INVITATION_TOKEN_SECRET,
 *                          "member-invitation:<invitationId>:<tokenVersion>"))
 *
 * so the current version's value is securely recomputed on every send —
 * initial dispatch and retry alike — and only its SHA-256 hash is
 * persisted on the invitation for lookup. The persisted Notification
 * body carries MEMBER_INVITATION_URL_PLACEHOLDER instead of the live
 * URL; the notification layer substitutes the recomputed link at
 * provider-send time. No database row, log line, or telemetry payload
 * ever holds the raw token.
 *
 * Unlike callout response tokens — which are stable per (callout,
 * member) — an invitation's token carries a monotonically increasing
 * `tokenVersion`. A resend bumps the version: the new link is derived,
 * the superseded hash is overwritten, and every earlier link stops
 * resolving. Rotating the secret changes every derivation, which
 * revokes all outstanding invitation links.
 */
export const MEMBER_INVITATION_TEMPLATE = "member_invitation";

/**
 * Written into the stored Notification.bodyText where the live
 * invitation link belongs. Substituted with the recomputed URL at
 * provider-send time so the durable record holds no usable credential.
 */
export const MEMBER_INVITATION_URL_PLACEHOLDER = "{member-invitation-url}";

/** Invitations are valid for 7 days from the send that issued them. */
export const MEMBER_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The server-held pepper for token derivation. Required in production —
 * without it invitation issuance fails loudly before any row is written
 * rather than emitting links under a shared fallback. Outside
 * production a fixed value keeps dev/test deterministic; it is a dev
 * convenience, never a credential boundary.
 */
function invitationTokenPepper(): string {
  const pepper = process.env.MEMBER_INVITATION_TOKEN_SECRET;
  if (pepper) return pepper;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "MEMBER_INVITATION_TOKEN_SECRET is not configured; invitation links cannot be issued.",
    );
  }
  return "sarbase-dev-member-invitation-token-secret";
}

/** Fail-fast config check for callers about to write invitations. */
export function assertMemberInvitationTokenConfigured(): void {
  invitationTokenPepper();
}

/**
 * The raw bearer token emailed to the invitee for the invitation's
 * CURRENT tokenVersion. Never persist the return value.
 */
export function deriveMemberInvitationToken(
  invitationId: string,
  tokenVersion: number,
): string {
  return createHmac("sha256", invitationTokenPepper())
    .update(`member-invitation:${invitationId}:${tokenVersion}`)
    .digest("base64url");
}

/** SHA-256 lookup key for a presented token — safe to persist. */
export function hashMemberInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The full link substituted into the email body at send time. */
export function memberInvitationUrl(
  invitationId: string,
  tokenVersion: number,
): string {
  const token = deriveMemberInvitationToken(invitationId, tokenVersion);
  return `${resolveSiteUrl()}/invite?t=${encodeURIComponent(token)}`;
}

/**
 * Whether `presentedToken` is the LIVE credential for this invitation —
 * a timing-safe comparison against the current version's derivation.
 * The stored hash gets the caller to the row; this check makes version
 * bumps (resends) and secret rotation actually revoke.
 */
export function verifyMemberInvitationToken(
  invitationId: string,
  tokenVersion: number,
  presentedToken: string,
): boolean {
  const expected = Buffer.from(
    deriveMemberInvitationToken(invitationId, tokenVersion),
  );
  const presented = Buffer.from(presentedToken);
  return (
    expected.length === presented.length && timingSafeEqual(expected, presented)
  );
}
