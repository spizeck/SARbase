import type { Metadata } from "next";

import { LegalDocumentView } from "@/components/legal-document";
import { LegalFooter } from "@/components/legal-footer";
import {
  SARBASE_REPOSITORY_URL,
  TERMS_OF_SERVICE,
} from "@/lib/legal/documents";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Terms governing use of the SARbase platform by participating search-and-rescue organizations and their members.",
};

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <LegalDocumentView doc={TERMS_OF_SERVICE} />
      <p className="mt-8 text-xs text-neutral-500">
        Related:{" "}
        <a
          href={`${SARBASE_REPOSITORY_URL}/blob/main/docs/legal/hosting-and-self-hosting.md`}
          className="underline underline-offset-4 hover:text-neutral-700"
          target="_blank"
          rel="noreferrer"
        >
          Hosting &amp; self-hosting policy
        </a>
      </p>
      <LegalFooter className="mt-4" />
    </main>
  );
}
