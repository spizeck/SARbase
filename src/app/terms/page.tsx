import type { Metadata } from "next";

import { LegalDocumentView } from "@/components/legal-document";
import { LegalFooter } from "@/components/legal-footer";
import { TERMS_OF_SERVICE } from "@/lib/legal/documents";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Terms governing use of the SARbase platform by participating search-and-rescue organizations and their members.",
};

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <LegalDocumentView doc={TERMS_OF_SERVICE} />
      <LegalFooter className="mt-12" />
    </main>
  );
}
