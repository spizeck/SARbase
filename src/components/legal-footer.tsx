import Link from "next/link";

import {
  SARBASE_LICENSE_NAME,
  SARBASE_REPOSITORY_URL,
} from "@/lib/legal/documents";

/**
 * Privacy/Terms/source links for public pages and sign-in surfaces.
 * Subtle by design — legal links should be findable, not loud.
 * The repository link makes the AGPL-3.0 license and source code easy
 * to find, as the license intends.
 */
export function LegalFooter({ className = "" }: { className?: string }) {
  return (
    <footer className={`text-xs text-neutral-500 ${className}`}>
      <Link href="/privacy" className="hover:underline">
        Privacy Policy
      </Link>
      <span aria-hidden="true"> · </span>
      <Link href="/terms" className="hover:underline">
        Terms of Service
      </Link>
      <span aria-hidden="true"> · </span>
      <a
        href={SARBASE_REPOSITORY_URL}
        className="hover:underline"
        target="_blank"
        rel="noreferrer"
      >
        Source code ({SARBASE_LICENSE_NAME})
      </a>
    </footer>
  );
}
