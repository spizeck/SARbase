"use server";

import { cookies, headers } from "next/headers";
import { z } from "zod";

import { getFirebaseAuth } from "@/lib/firebase/admin";
import { isFirebaseAdminConfigured } from "@/lib/env";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  createSessionCookie,
} from "@/lib/auth/session";
import {
  acceptMemberInvitation,
  InvitationAcceptanceError,
} from "@/lib/domain/invitations";
import { hashMemberInvitationToken } from "@/lib/domain/invitationTokens";
import { log, logExpected, summarizeError } from "@/lib/logging";
import { checkRateLimit } from "@/lib/rate-limit/rate-limit";
import { clientIpFromHeaders, rateLimitKey } from "@/lib/rate-limit/keys";
import { getRateLimitStore } from "@/lib/rate-limit/default-store";

/**
 * Member-invitation acceptance — the public, token-gated counterpart of
 * the admin invite actions.
 *
 * The bearer token is supplied by the emailed link; the ID token is a
 * fresh Firebase credential from the browser's own sign-in/register.
 * Both are verified server-side: `verifyIdToken(checkRevoked)` proves
 * the identity, and only the VERIFIED claims (sub, email,
 * email_verified) reach the invitation logic. Neither token is logged,
 * stored, or rate-limited under its raw value.
 *
 * CSRF: Next.js Server Actions reject cross-origin invocations before
 * this code runs.
 */

const acceptRateLimitStore = getRateLimitStore();
const ACCEPT_RATE_LIMIT = { limit: 10, windowMs: 60_000 };

const tokenSchema = z.string().min(1).max(512);
const idTokenSchema = z.string().min(1).max(8192);

export interface AcceptInvitationResult {
  ok: boolean;
  /** User-safe message — InvitationAcceptanceError text is honest-state. */
  error?: string;
}

export async function acceptMemberInvitationAction(
  token: string,
  idToken: string,
): Promise<AcceptInvitationResult> {
  const parsedToken = tokenSchema.safeParse(token);
  const parsedIdToken = idTokenSchema.safeParse(idToken);
  if (!parsedToken.success || !parsedIdToken.success) {
    return { ok: false, error: "This invitation link is invalid." };
  }

  const hdrs = await headers();
  const limited = await checkRateLimit(
    acceptRateLimitStore,
    rateLimitKey(
      "invitation.accept",
      hashMemberInvitationToken(parsedToken.data),
      clientIpFromHeaders({
        "x-forwarded-for": hdrs.get("x-forwarded-for") ?? undefined,
        "x-real-ip": hdrs.get("x-real-ip") ?? undefined,
      }),
    ),
    ACCEPT_RATE_LIMIT,
  );
  if (!limited.allowed) {
    logExpected({
      event: "member_invitation.accept_rate_limited",
      subsystem: "invitations",
      rateLimitScope: "invitation.accept",
    });
    return {
      ok: false,
      error: "Too many attempts. Please wait a moment and try again.",
    };
  }

  if (!isFirebaseAdminConfigured()) {
    logExpected({
      event: "member_invitation.accept_failed",
      subsystem: "invitations",
      failureReason: "not_configured",
    });
    return {
      ok: false,
      error: "Authentication is not configured on this deployment.",
    };
  }

  let decoded;
  try {
    decoded = await getFirebaseAuth().verifyIdToken(parsedIdToken.data, true);
  } catch {
    return {
      ok: false,
      error: "Sign-in could not be verified. Sign in again and retry.",
    };
  }

  let result;
  try {
    result = await acceptMemberInvitation(parsedToken.data, {
      uid: decoded.sub,
      email: decoded.email ?? null,
      emailVerified: decoded.email_verified === true,
    });
  } catch (error) {
    if (error instanceof InvitationAcceptanceError) {
      logExpected({
        event: "member_invitation.accept_failed",
        subsystem: "invitations",
        failureReason: error.reason,
      });
      return { ok: false, error: error.message };
    }
    throw error;
  }

  // The invitation is consumed — mint the session so the new member
  // lands signed in. A mint failure is not fatal: the link is spent but
  // the member can sign in normally from /login.
  try {
    const sessionCookie = await createSessionCookie(parsedIdToken.data);
    const store = await cookies();
    store.set(SESSION_COOKIE_NAME, sessionCookie, sessionCookieOptions());
  } catch (error) {
    logExpected({
      event: "member_invitation.session_mint_failed",
      subsystem: "invitations",
      actorId: result.authIdentityId,
      ...summarizeError(error),
    });
  }

  log({
    event: "member_invitation.accepted",
    subsystem: "invitations",
    entityType: "MemberInvitation",
    entityId: result.invitationId,
    actorId: result.authIdentityId,
  });
  return { ok: true };
}
