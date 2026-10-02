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
import { InMemoryRateLimitStore } from "@/lib/rate-limit/memory-store";

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
 * Rate limit: fixed-window on the hashed token + client IP; generous
 * (30/min) so a volunteer can freely change their mind while still
 * bounding brute-force against a known invitation. The bundled
 * in-memory store is per-process best-effort — see
 * src/lib/rate-limit/rate-limit.ts.
 */

const responseRateLimitStore = new InMemoryRateLimitStore();
const RESPONSE_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function respondToCalloutTokenAction(
  token: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const hdrs = await headers();
  const limited = await checkRateLimit(
    responseRateLimitStore,
    rateLimitKey(
      "callout.respond",
      hashResponseToken(token),
      clientIpFromHeaders({
        "x-forwarded-for": hdrs.get("x-forwarded-for") ?? undefined,
        "x-real-ip": hdrs.get("x-real-ip") ?? undefined,
      }),
    ),
    RESPONSE_RATE_LIMIT,
  );
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
