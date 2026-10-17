import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { log } from "@/lib/logging";
import { isLegalAcceptanceFlagEnabled } from "@/lib/env";

import type { AuthContext } from "@/lib/auth/context";

import {
  PRIVACY_POLICY,
  TERMS_OF_SERVICE,
  legalDocumentHash,
} from "./documents";

/**
 * Versioned Terms acceptance (legal framework, Phase 7).
 *
 * Enforcement rules — deliberately two independent gates, both must
 * hold before any user is required to accept:
 *
 * 1. `LEGAL_ACCEPTANCE_REQUIRED=true` — an owner deployment decision.
 * 2. The Terms document's `status` is "approved" — set only after
 *    counsel review. Draft documents can NEVER be enforced: flipping
 *    the env flag early, or approving nothing, results in no gate.
 *
 * Acceptance records are append-only `TermsAcceptance` rows carrying
 * the identity, terms version + content hash, the privacy notice
 * version + hash that was presented, the mechanism, and the
 * timestamp. A new terms version produces a new required acceptance
 * (reacceptance); a repeat acceptance of the current version is an
 * idempotent no-op on the unique key.
 *
 * Terms acceptance is CONTRACT acceptance by the individual user.
 * Recording the privacy version is notice provenance — it is not, and
 * is never represented as, consent to personal-data processing.
 */

export const TERMS_ACCEPT_MECHANISM = "explicit_checkbox";

/** Both enforcement gates — flag set AND document approved. */
export function isTermsAcceptanceEnforced(): boolean {
  if (TERMS_OF_SERVICE.status !== "approved") return false;
  return isLegalAcceptanceFlagEnabled();
}

/** Whether this identity has an acceptance row for the CURRENT terms. */
export async function hasAcceptedCurrentTerms(
  authIdentityId: string,
): Promise<boolean> {
  const row = await prisma.termsAcceptance.findUnique({
    where: {
      authIdentityId_termsVersion: {
        authIdentityId,
        termsVersion: TERMS_OF_SERVICE.version,
      },
    },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Page-level gate — redirect unaccepted users to the accept screen
 * when enforcement is active. Called from `requireAuth` so every
 * authenticated surface fails closed by default; the accept page and
 * essential account surfaces opt out explicitly.
 */
export async function requireTermsAcceptance(ctx: AuthContext) {
  if (!isTermsAcceptanceEnforced()) return;
  if (await hasAcceptedCurrentTerms(ctx.identity.id)) return;
  redirect("/legal/accept");
}

/**
 * Record an explicit acceptance. Idempotent per (identity, terms
 * version) — the unique key makes double-submits and refreshes safe.
 * Returns the stored row (existing or newly created).
 */
export async function recordTermsAcceptance(
  authIdentityId: string,
  mechanism: string = TERMS_ACCEPT_MECHANISM,
) {
  const data = {
    authIdentityId,
    termsVersion: TERMS_OF_SERVICE.version,
    termsHash: legalDocumentHash(TERMS_OF_SERVICE),
    privacyVersion: PRIVACY_POLICY.version,
    privacyHash: legalDocumentHash(PRIVACY_POLICY),
    mechanism,
  };
  try {
    const row = await prisma.termsAcceptance.create({ data });
    log({
      event: "legal.terms_accepted",
      subsystem: "legal",
      actorId: authIdentityId,
      entityType: "TermsAcceptance",
      entityId: row.id,
      termsVersion: row.termsVersion,
    });
    return row;
  } catch (error) {
    // Concurrent double-submit: the unique key makes one winner —
    // return the existing row rather than erroring.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return prisma.termsAcceptance.findUniqueOrThrow({
        where: {
          authIdentityId_termsVersion: {
            authIdentityId,
            termsVersion: TERMS_OF_SERVICE.version,
          },
        },
      });
    }
    throw error;
  }
}
