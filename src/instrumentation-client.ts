/**
 * Copy to the app root as `instrumentation-client.ts` (Next 15+) or keep
 * the legacy sentry.client.config.ts name. Browser Sentry init — runs
 * only when NEXT_PUBLIC_SENTRY_DSN is set. The client bundle stays out
 * of pages entirely when no public DSN is configured.
 *
 * Requires: npm install @sentry/nextjs
 */
import * as Sentry from "@sentry/nextjs";

import { redactString } from "@/lib/logging";
import { resolveSentryConfig } from "@/lib/observability/env";
import {
  scrubSentryEvent,
  sanitizeBreadcrumb,
  type EventLike,
  type Redactor,
} from "@/lib/observability/privacy";

// Logs and Sentry share one redaction policy (src/lib/logging.ts).
const redact: Redactor = redactString;

const config = resolveSentryConfig(process.env, false);

if (config.enabled) {
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,

    sendDefaultPii: false,
    // No replay, no performance tracing, no session tracking by default.
    // Each has privacy and bundle cost; enable deliberately, per app.
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,

    // The SDK's ErrorEvent/Breadcrumb types are not nominally assignable
    // to the scrubber's structural types (Breadcrumb lacks an index
    // signature); they are compatible at runtime, so the boundary casts
    // through unknown deliberately.
    beforeSend(event) {
      return scrubSentryEvent(
        event as unknown as EventLike,
        redact,
      ) as unknown as typeof event;
    },
    beforeBreadcrumb(crumb) {
      return sanitizeBreadcrumb(
        crumb as unknown as {
          message?: string;
          data?: Record<string, unknown>;
        },
        redact,
      ) as unknown as typeof crumb;
    },
  });
}

// Required by the Sentry SDK for navigation instrumentation; a no-op
// when Sentry is not initialized.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
