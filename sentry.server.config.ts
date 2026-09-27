/**
 * Copy to the app root (or import it from src/instrumentation.ts via
 * `register()`). Server-side Sentry init — runs only when SENTRY_DSN is
 * set and NODE_ENV is not test.
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
import { buildScopeTags } from "@/lib/observability/scope";

// Logs and Sentry share one redaction policy (src/lib/logging.ts).
const redact: Redactor = redactString;

const config = resolveSentryConfig(process.env, true);

if (config.enabled) {
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,

    // Privacy posture: no PII, no performance data, no session tracking.
    sendDefaultPii: false,
    tracesSampleRate: 0,
    profilesSampleRate: 0,
    enableLogs: false,

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

    initialScope: {
      tags: buildScopeTags(process.env),
    },
  });
}
