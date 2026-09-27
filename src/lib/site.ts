/**
 * Canonical site origin — the single source of truth for canonical URLs,
 * sitemap/robots URLs, Open Graph URLs, and JSON-LD `@id`s. Overridable
 * via `NEXT_PUBLIC_SITE_URL`; the resolved value never has a trailing
 * slash so callers can safely build `${siteUrl}/path` URLs.
 *
 * Import `siteUrl` (or call `resolveSiteUrl` in tests) rather than
 * re-reading `NEXT_PUBLIC_SITE_URL` anywhere else.
 *
 * Derived from the Deep Dive Brewing implementation, generalized to a
 * localhost-safe default.
 */
export function resolveSiteUrl(
  raw: string | undefined = process.env.NEXT_PUBLIC_SITE_URL,
): string {
  return (raw ?? "http://localhost:3000").replace(/\/+$/, "");
}

export const siteUrl = resolveSiteUrl();
