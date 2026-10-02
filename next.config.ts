import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// tsconfig path aliases are not resolved inside next.config — keep this
// import relative.
import { buildSecurityHeaders } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  // This application may sit inside a larger workspace with its own
  // lockfiles. Pinning the root stops Next from inferring a parent
  // directory as the workspace root.
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
  experimental: {
    serverActions: {
      // Attachment uploads (issue #16) submit files through Server
      // Actions; the default 1 MB cap would reject anything larger
      // before it reaches validation. 32mb covers the 25 MiB file cap
      // plus multipart overhead; the domain layer enforces the real
      // policy.
      bodySizeLimit: "32mb",
    },
  },
  poweredByHeader: false,
  images: {
    // AVIF encodes photographic content meaningfully smaller than WebP at
    // the same quality; WebP remains the fallback for older browsers.
    formats: ["image/avif", "image/webp"],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: buildSecurityHeaders(),
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // Upload source maps ONLY when org/project/auth-token are configured —
  // credential-free CI builds must not attempt uploads.
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Delete uploaded maps from the published bundle so source is not
  // publicly downloadable from the deployment.
  sourcemaps: { deleteSourcemapsAfterUpload: true },
  // The SDK's own build-time telemetry reports nothing we need; the
  // module's privacy posture is off-by-default for outbound data.
  telemetry: false,
});
