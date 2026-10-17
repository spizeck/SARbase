import type { Metadata } from "next";

import { LegalDocumentView } from "@/components/legal-document";
import { LegalFooter } from "@/components/legal-footer";
import { PRIVACY_POLICY } from "@/lib/legal/documents";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How SARbase collects, uses, retains, and protects personal information for participating search-and-rescue organizations and their members.",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <LegalDocumentView doc={PRIVACY_POLICY} />
      <LegalFooter className="mt-12" />
    </main>
  );
}
