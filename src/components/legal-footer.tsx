import Link from "next/link";

/**
 * Privacy/Terms links for public pages and sign-in surfaces.
 * Subtle by design — legal links should be findable, not loud.
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
    </footer>
  );
}
