/**
 * Sentry event privacy scrubbing — pure functions applied via the SDK's
 * `beforeSend` / `beforeBreadcrumb` hooks.
 *
 * Provenance: RISE Saba's scrubber, generalized. The policy it encodes:
 *
 * - `sendDefaultPii: false` AND we still strip defensively — defaults can
 *   change, defense in depth should not depend on one flag.
 * - User identity is never reported: no `event.user`, no IP, no emails
 *   in any field.
 * - Request data is allowlist-only: a fixed set of innocuous headers;
 *   cookies, authorization, bodies, and query strings are dropped
 *   wholesale (query strings routinely carry bearer tokens).
 * - Breadcrumbs and extras are redacted with the app's own redactString
 *   so logging and error telemetry apply ONE redaction policy.
 */

/** A function matching the base template's `redactString` signature. */
export type Redactor = (value: string, keyIsIdentifier: boolean) => string;

/**
 * Request headers that may be forwarded to Sentry. Everything else —
 * notably cookie, authorization, x-forwarded-for, x-vercel-* tokens —
 * is dropped.
 */
export const ALLOWED_REQUEST_HEADERS = new Set([
  "host",
  "user-agent",
  "referer",
  "origin",
  "content-type",
  "accept",
  "accept-language",
]);

export interface EventLike {
  user?: unknown;
  request?: {
    url?: string;
    headers?: Record<string, string>;
    cookies?: unknown;
    data?: unknown;
    query_string?: unknown;
  };
  breadcrumbs?: Array<{
    message?: string;
    category?: string;
    data?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Strip the query string (and fragment) from a URL for telemetry. */
export function stripUrlQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

/**
 * The `beforeSend` scrubber. Returns a sanitized copy — the SDK event
 * object is treated as opaque; we only touch fields we own the policy
 * for. Pass the app's redactString (from src/lib/logging.ts when the app
 * derives from next-base) so both observability layers share one policy.
 */
export function scrubSentryEvent<T extends EventLike>(
  event: T,
  redact: Redactor,
): T {
  const scrubbed = { ...event };

  // Identity: never report user objects, IPs, or emails.
  delete scrubbed.user;

  if (scrubbed.request) {
    const req = { ...scrubbed.request };
    if (req.url) req.url = stripUrlQuery(req.url);
    if (req.headers) {
      req.headers = Object.fromEntries(
        Object.entries(req.headers).filter(([name]) =>
          ALLOWED_REQUEST_HEADERS.has(name.toLowerCase()),
        ),
      );
    }
    delete req.cookies;
    delete req.data;
    delete req.query_string;
    scrubbed.request = req;
  }

  if (Array.isArray(scrubbed.breadcrumbs)) {
    scrubbed.breadcrumbs = scrubbed.breadcrumbs.map((crumb) =>
      sanitizeBreadcrumb(crumb, redact),
    );
  }

  if (scrubbed.extra) {
    scrubbed.extra = Object.fromEntries(
      Object.entries(scrubbed.extra).map(([key, value]) => [
        key,
        typeof value === "string" ? redact(value, false) : value,
      ]),
    );
  }

  return scrubbed;
}

/**
 * The `beforeBreadcrumb` scrubber. Breadcrumb messages and data are
 * free-text fields where request payloads and user input love to hide.
 */
export function sanitizeBreadcrumb<
  T extends { message?: string; data?: Record<string, unknown> },
>(crumb: T, redact: Redactor): T {
  const sanitized = { ...crumb };
  if (sanitized.message) {
    sanitized.message = redact(sanitized.message, false);
  }
  if (sanitized.data) {
    sanitized.data = Object.fromEntries(
      Object.entries(sanitized.data).map(([key, value]) => [
        key,
        typeof value === "string"
          ? key.toLowerCase().includes("url")
            ? stripUrlQuery(redact(value, false))
            : redact(value, key.toLowerCase().endsWith("id"))
          : value,
      ]),
    );
  }
  return sanitized;
}
