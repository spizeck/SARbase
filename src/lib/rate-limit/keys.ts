import { createHash } from "node:crypto";

/**
 * Derive an opaque rate-limit key. Raw IPs, emails, and user ids must
 * never appear in limiter keys — they would leak into logs, metrics,
 * and store dumps. Hashing scope+subject keeps the key stable per
 * (endpoint, client) pair while remaining useless to anyone who reads
 * the store.
 */
export function rateLimitKey(scope: string, ...subjects: string[]): string {
  const digest = createHash("sha256")
    .update([scope, ...subjects].join(":"))
    .digest("hex");
  return `rl:${scope}:${digest.slice(0, 32)}`;
}

/**
 * Best-effort client IP extraction for Vercel/proxied deployments.
 * Reads the first (client-most) x-forwarded-for entry; falls back to
 * x-real-ip. Returns "unknown" rather than guessing — a shared bucket
 * for unidentified clients is safer than keying on a wrong header.
 *
 * Header-derived IPs are spoofable; pair with a second subject (user id,
 * token hash) on authenticated endpoints.
 */
export function clientIpFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string {
  const forwarded = headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (value) {
    const first = value.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers["x-real-ip"];
  const realValue = Array.isArray(real) ? real[0] : real;
  return realValue?.trim() || "unknown";
}
