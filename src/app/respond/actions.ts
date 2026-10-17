"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import {
  respondToCalloutToken,
  hashResponseToken,
  CalloutClosedError,
  CalloutTokenInvalidError,
} from "@/lib/domain/callouts";
import { calloutResponseSchema } from "@/lib/domain/schemas";
import { logExpected } from "@/lib/logging";
import { checkRateLimit } from "@/lib/rate-limit/rate-limit";
import { clientIpFromHeaders, rateLimitKey } from "@/lib/rate-limit/keys";
import { getRateLimitStore } from "@/lib/rate-limit/default-store";

import type { ActionState } from "../admin/actions";

/**
 * Public token-gated response action (issue #14).
 *
 * The token itself is the credential — no sign-in is required. It is a
 * high-entropy HMAC-derived value carried in the emailed link; only its
 * SHA-256 hash is ever persisted or rate-limited against. The raw token
 * is never logged and never appears in rate-limit keys.
 *
 * Failures are deliberately opaque and identical for every invalid
 * input — a bad token cannot probe whether an invitation exists.
 *
 * Rate limit: two fixed windows. A client-wide guard (60/min per IP)
 * runs first so spraying many distinct tokens cannot multiply the
 * budget; the per-token window (30/min on hashed token + IP) then
 * bounds brute-force against one known invitation. Both are generous
 * enough that a volunteer can freely change their mind. In production
 * the windows live in Postgres and are shared across instances — see
 * src/lib/rate-limit/rate-limit.ts.
 */

const responseRateLimitStore = getRateLimitStore();
const CLIENT_RATE_LIMIT = { limit: 60, windowMs: 60_000 };
const RESPONSE_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function respondToCalloutTokenAction(
  token: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const hdrs = await headers();
  const clientIp = clientIpFromHeaders({
    "x-forwarded-for": hdrs.get("x-forwarded-for") ?? undefined,
    "x-real-ip": hdrs.get("x-real-ip") ?? undefined,
  });

  // Client-wide guard: token rotation must not refresh the budget.
  const clientLimited = await checkRateLimit(
    responseRateLimitStore,
    rateLimitKey("callout.respond.client", clientIp),
    CLIENT_RATE_LIMIT,
  );
  const limited = clientLimited.allowed
    ? await checkRateLimit(
        responseRateLimitStore,
        rateLimitKey("callout.respond", hashResponseToken(token), clientIp),
        RESPONSE_RATE_LIMIT,
      )
    : clientLimited;
  if (!limited.allowed) {
    logExpected({
      event: "callout.respond_rate_limited",
      subsystem: "callouts",
      rateLimitScope: "callout.respond",
    });
    return {
      message: "Too many attempts. Please wait a moment and try again.",
    };
  }

  const parsed = calloutResponseSchema.safeParse(formData.get("response"));
  if (!parsed.success) {
    return { message: "Choose a response." };
  }

  try {
    await respondToCalloutToken(token, parsed.data);
  } catch (error) {
    if (error instanceof CalloutClosedError) {
      return { message: error.message };
    }
    if (error instanceof CalloutTokenInvalidError) {
      return { message: error.message };
    }
    throw error;
  }
  // Marks the route stale so the post-action refresh re-renders the
  // updated response — without it the client keeps the stale UI.
  revalidatePath("/respond");
  return {};
}
