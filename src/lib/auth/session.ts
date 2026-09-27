import type { DecodedIdToken } from "firebase-admin/auth";

import { getFirebaseAuth } from "@/lib/firebase/admin";

/**
 * Session cookie lifecycle for Firebase-backed auth.
 *
 * The browser authenticates with the Firebase client SDK (email +
 * password), then posts the resulting ID token to `createSessionAction`,
 * which verifies it server-side and mints a Firebase session cookie.
 * Every request thereafter verifies the cookie with revocation checking
 * (`checkRevoked: true`), so `revokeRefreshTokens` on sign-out/disable
 * takes effect on the next request — not when the cookie expires.
 *
 * Cookie policy: HttpOnly (never readable by JS), SameSite=Lax (blocks
 * cross-site POSTs carrying the cookie), Secure whenever the deployment
 * is HTTPS — Vercel preview/production, or any deployment whose
 * APP_BASE_URL is https. Plain-HTTP local dev stays usable.
 */
export const SESSION_COOKIE_NAME = "sarbase_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 5; // 5 days

export const AUTH_PROVIDER = "firebase";

export function shouldUseSecureCookies(): boolean {
  if (
    process.env.VERCEL_ENV === "production" ||
    process.env.VERCEL_ENV === "preview"
  ) {
    return true;
  }
  return process.env.APP_BASE_URL?.startsWith("https://") ?? false;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  } as const;
}

/**
 * Verify a session cookie against Firebase, including revocation. Never
 * throws — invalid, expired, revoked, or unconfigured-auth cookies all
 * resolve to `null` (fail closed).
 */
export async function verifySessionCookie(
  sessionCookie: string,
): Promise<DecodedIdToken | null> {
  try {
    const auth = getFirebaseAuth();
    return await auth.verifySessionCookie(sessionCookie, true);
  } catch {
    return null;
  }
}

/**
 * Mint a Firebase session cookie from a verified ID token. Throws when
 * the token is invalid or auth is unconfigured — callers must verify
 * the token first and treat a throw as an auth failure.
 */
export async function createSessionCookie(idToken: string): Promise<string> {
  const auth = getFirebaseAuth();
  return auth.createSessionCookie(idToken, {
    expiresIn: SESSION_MAX_AGE_SECONDS * 1000,
  });
}
