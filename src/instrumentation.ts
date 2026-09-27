import type { Instrumentation } from "next";

import { buildRequestErrorEvent, log } from "@/lib/logging";
import { reportRequestError } from "@/lib/observability/on-request-error";

/**
 * Boots once per server runtime. Loads the Sentry server configuration,
 * which stays fully disabled when SENTRY_DSN is absent.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }
}

/**
 * Next.js calls this once per server-side error captured anywhere in the
 * request lifecycle — Server Component renders, route handlers, server
 * actions, and the proxy. It is the single funnel through which every
 * *unexpected* application failure becomes a structured
 * `unhandled_request_error` log line and a Sentry event.
 *
 * Expected outcomes (NEXT_* control flow, authorization denials) never
 * reach Sentry by design — `reportRequestError` forwards only events
 * classified as `unexpected_failure`.
 *
 * Deliberately synchronous-safe: nothing here must throw, or it would
 * mask the original failure.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  try {
    const event = buildRequestErrorEvent(error, request, context);
    if (event) {
      log(event);
      reportRequestError(error, event);
    }
  } catch {
    // Never let observability break the request path.
  }
};
