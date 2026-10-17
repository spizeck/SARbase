import Link from "next/link";
import type { Metadata } from "next";

import { requireAuth } from "@/lib/auth/authorize";
import { hasAcceptedCurrentTerms } from "@/lib/legal/acceptance";
import { PRIVACY_POLICY, TERMS_OF_SERVICE } from "@/lib/legal/documents";

import { AcceptTermsForm } from "./accept-form";

export const metadata: Metadata = {
  title: "Accept Terms",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Versioned Terms acceptance. Reachable only while signed in;
 * enforcement (every authenticated surface redirects here) activates
 * only when LEGAL_ACCEPTANCE_REQUIRED=true AND the Terms document is
 * marked approved — drafts can never be mandatory.
 */
export default async function AcceptTermsPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const ctx = await requireAuth({ allowWithoutTerms: true });
  const { next } = await searchParams;
  // Internal paths only — a leading "//" would be a protocol-relative
  // (external) URL, so the second character may not be a slash.
  const safeNext =
    next && /^\/[a-zA-Z0-9\-_][a-zA-Z0-9\-_/.?=&]*$/.test(next)
      ? next
      : undefined;

  const alreadyAccepted = await hasAcceptedCurrentTerms(ctx.identity.id);
  // A draft document can never be enforced — isTermsAcceptanceEnforced
  // requires status "approved".
  const isDraft = TERMS_OF_SERVICE.status !== "approved";

  return (
    <main className="mx-auto max-w-lg px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">
        Terms of Service
      </h1>

      {isDraft && (
        <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          These documents are drafts under legal review and are not yet in
          effect. Acceptance is not currently required by this deployment.
        </p>
      )}

      <p className="mt-4 text-sm leading-6 text-neutral-700">
        Before using SARbase you must read and accept the{" "}
        <Link
          href="/terms"
          className="font-medium underline underline-offset-4"
        >
          Terms of Service
        </Link>{" "}
        (version {TERMS_OF_SERVICE.version}). The{" "}
        <Link
          href="/privacy"
          className="font-medium underline underline-offset-4"
        >
          Privacy Policy
        </Link>{" "}
        (version {PRIVACY_POLICY.version}) describes how your information is
        processed.
      </p>

      {alreadyAccepted ? (
        <div className="mt-6">
          <p className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            You have already accepted version {TERMS_OF_SERVICE.version}
            of the Terms of Service.
          </p>
          <p className="mt-4">
            <Link
              href={safeNext ?? "/org"}
              className="text-sm font-medium text-neutral-900 underline underline-offset-4"
            >
              Continue
            </Link>
          </p>
        </div>
      ) : (
        <div className="mt-6 rounded-md border border-neutral-200 p-5">
          <AcceptTermsForm next={safeNext} />
        </div>
      )}
    </main>
  );
}
