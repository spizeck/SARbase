"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getFirebaseAuth } from "@/lib/firebase/admin";
import { isFirebaseAdminConfigured } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/logging";
import {
  AUTH_PROVIDER,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  createSessionCookie,
} from "@/lib/auth/session";
import { getAuthContext } from "@/lib/auth/context";

/**
 * Authentication lifecycle actions.
 *
 * CSRF: these are Next.js Server Actions — the framework rejects
 * cross-origin invocations (Origin/Host mismatch) before this code runs,
 * and the session cookie is SameSite=Lax + HttpOnly on top of that.
 *
 * IMPORTANT: the idToken is NEVER trusted as authorization input — it is
 * verified server-side by Firebase Admin before anything is written, and
 * only the verified claims (sub, email) reach the database. The token
 * itself is never logged or stored.
 */

const idTokenSchema = z.string().min(1).max(8192);

export interface SessionActionResult {
  ok: boolean;
  /** Opaque machine reason — no internal detail leaks to the client. */
  error?: "invalid_credentials" | "account_disabled" | "not_configured";
}

/**
 * Exchange a freshly signed-in Firebase ID token for a server-verified,
 * HTTP-only session cookie. Auto-provisions an AuthIdentity with ZERO
 * access on first sign-in — organization grants and member links are
 * always explicit administrative acts, never inferred at login.
 */
export async function createSessionAction(
  idToken: string,
): Promise<SessionActionResult> {
  const parsed = idTokenSchema.safeParse(idToken);
  if (!parsed.success) {
    return { ok: false, error: "invalid_credentials" };
  }

  // Unconfigured deployments fail closed without touching Firebase.
  if (!isFirebaseAdminConfigured()) {
    log({
      event: "auth.session_failed",
      level: "warn",
      outcome: "expected_failure",
      subsystem: "auth",
      failureReason: "not_configured",
    });
    return { ok: false, error: "not_configured" };
  }

  let decoded;
  try {
    decoded = await getFirebaseAuth().verifyIdToken(parsed.data, true);
  } catch {
    log({
      event: "auth.session_failed",
      level: "warn",
      outcome: "expected_failure",
      subsystem: "auth",
      failureReason: "invalid_credentials",
    });
    return { ok: false, error: "invalid_credentials" };
  }

  const email = decoded.email?.toLowerCase().trim() ?? null;
  const identity = await prisma.authIdentity.upsert({
    where: {
      provider_providerUid: {
        provider: AUTH_PROVIDER,
        providerUid: decoded.sub,
      },
    },
    update: { email },
    create: {
      provider: AUTH_PROVIDER,
      providerUid: decoded.sub,
      email,
    },
  });

  if (identity.status !== "ACTIVE") {
    log({
      event: "auth.login_denied",
      level: "warn",
      outcome: "expected_failure",
      subsystem: "auth",
      actorId: identity.id,
      failureReason: "account_disabled",
    });
    return { ok: false, error: "account_disabled" };
  }

  const sessionCookie = await createSessionCookie(parsed.data);
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, sessionCookie, sessionCookieOptions());

  log({
    event: "auth.login",
    subsystem: "auth",
    actorId: identity.id,
  });

  return { ok: true };
}

/**
 * Sign out: revoke the account's refresh tokens server-side (so the
 * minted session cookie stops verifying immediately rather than at
 * expiry) and clear the cookie. Best-effort revocation — the cookie is
 * always cleared.
 */
export async function signOutAction(): Promise<void> {
  const ctx = await getAuthContext();
  if (ctx) {
    try {
      await getFirebaseAuth().revokeRefreshTokens(ctx.identity.providerUid);
    } catch {
      log({
        event: "auth.revocation_failed",
        level: "warn",
        outcome: "operational_failure",
        subsystem: "auth",
        actorId: ctx.identity.id,
      });
    }
  }

  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, "", {
    ...sessionCookieOptions(),
    maxAge: 0,
  });

  redirect("/");
}
