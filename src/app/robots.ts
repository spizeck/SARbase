import type { MetadataRoute } from "next";

import { siteUrl } from "@/lib/site";

/**
 * robots.txt. Resolved per request, so environment-driven rules take
 * effect on the next request without a rebuild.
 *
 * Add `Disallow` entries for routes that should not be indexed (admin,
 * preview surfaces, token-bearing links). robots rules are indexing
 * hygiene, never access control — enforcement belongs server-side.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/account"],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
