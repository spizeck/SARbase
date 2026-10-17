"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { getAuthContextOrThrow } from "@/lib/auth/authorize";
import { AuthenticationError } from "@/lib/auth/context";
import { recordTermsAcceptance } from "@/lib/legal/acceptance";

/**
 * Terms acceptance action. Explicit checkbox required — the server
 * independently verifies the checkbox value was submitted, so a form
 * POST without it cannot record acceptance. Idempotent per
 * (identity, terms version).
 */

const acceptSchema = z.object({
  // The literal checkbox value — an unchecked box submits nothing.
  accept_terms: z.literal("on"),
  // Optional post-acceptance destination — internal paths only; the
  // character after the leading "/" may not be another "/" (that would
  // be a protocol-relative external URL).
  next: z
    .string()
    .regex(/^\/[a-zA-Z0-9\-_][a-zA-Z0-9\-_/.?=&]*$/)
    .optional(),
});

export interface AcceptTermsState {
  error?: string;
}

export async function acceptTermsAction(
  _prev: AcceptTermsState,
  formData: FormData,
): Promise<AcceptTermsState> {
  let ctx;
  try {
    ctx = await getAuthContextOrThrow();
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return { error: "Sign in to accept the Terms of Service." };
    }
    throw error;
  }

  const parsed = acceptSchema.safeParse({
    accept_terms: formData.get("accept_terms"),
    next: formData.get("next") ?? undefined,
  });
  if (!parsed.success) {
    return {
      error:
        "Read the Terms of Service and check the box to confirm you accept them.",
    };
  }

  await recordTermsAcceptance(ctx.identity.id);
  redirect(parsed.data.next ?? "/org");
}
