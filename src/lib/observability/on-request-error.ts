/**
 * Bridges the base template's onRequestError funnel to Sentry.
 *
 * Usage in the app's src/instrumentation.ts, inside onRequestError,
 * AFTER the structured log line is emitted:
 *
 *   const event = buildRequestErrorEvent(error, request, context);
 *   if (event) {
 *     log(event);
 *     reportRequestError(error, event);   // ← add this
 *   }
 *
 * Only unexpected failures reach Sentry: NEXT_* control flow produces
 * no event upstream, and anything reclassified to expected/operational
 * stays log-only. This is the single reporting point — do not scatter
 * Sentry.captureException through request handlers.
 */
import * as Sentry from "@sentry/nextjs";

import { buildScopeTags } from "./scope";

interface ReportableEvent {
  event: string;
  outcome?: string;
  requestId?: string;
  routePath?: string;
  [key: string]: unknown;
}

export function reportRequestError(
  error: unknown,
  event: ReportableEvent,
): void {
  if (event.outcome !== "unexpected_failure") return;

  Sentry.withScope((scope) => {
    scope.setTags(buildScopeTags(process.env));
    if (event.requestId) scope.setTag("request_id", event.requestId);
    if (event.routePath) scope.setTag("route", event.routePath);
    // Fingerprint by route so distinct handlers don't collapse into one
    // issue while error-message variance stays out of grouping.
    if (event.routePath) {
      scope.setFingerprint(["unhandled_request_error", event.routePath]);
    }
    Sentry.captureException(error);
  });
}
