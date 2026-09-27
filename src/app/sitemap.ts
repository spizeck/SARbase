import type { MetadataRoute } from "next";

import { siteUrl } from "@/lib/site";

/**
 * sitemap.xml. Resolved per request so environment-driven surface changes
 * (feature flags, maintenance mode) are reflected without a rebuild.
 * List only indexable, canonical URLs — excluded routes must also be
 * absent here, not merely marked noindex.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: siteUrl,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
