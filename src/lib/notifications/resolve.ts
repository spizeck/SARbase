import { parseAppEnvironment, parseNotificationEnvironment } from "@/lib/env";

import { FakeNotificationProvider } from "./fake";
import {
  NotificationConfigError,
  type NotificationChannelName,
  type NotificationProvider,
} from "./provider";
import { ResendEmailProvider } from "./resend";

/**
 * Resolve the configured provider for a channel from the environment.
 *
 * Selection rules (deliberately fail closed):
 * - `NOTIFICATION_PROVIDER=resend`, or unset with RESEND_API_KEY
 *   present → Resend; requires RESEND_API_KEY and
 *   NOTIFICATION_EMAIL_FROM — missing pieces throw
 *   NotificationConfigError at send time, not a cryptic provider error.
 * - `NOTIFICATION_PROVIDER=fake`, or unset without RESEND_API_KEY → the
 *   deterministic in-process fake…
 * - …UNLESS this is a real production deployment (VERCEL_ENV=production
 *   or NODE_ENV=production): production must never silently fall back
 *   to a fake provider, so unconfigured production throws instead.
 *   A VERCEL_ENV=production deployment cannot select `fake` even
 *   explicitly.
 *
 * Resolution is lazy — called at dispatch time so `next build` with
 * zero env vars never touches provider config.
 */
export function resolveNotificationProvider(
  channel: NotificationChannelName,
  values: Record<string, string | undefined> = process.env,
): NotificationProvider {
  if (channel !== "EMAIL") {
    throw new NotificationConfigError(
      `No notification provider is implemented for channel ${channel}.`,
    );
  }

  const env = parseNotificationEnvironment(values);
  const app = parseAppEnvironment(values);
  const isProduction =
    app.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";

  const selection =
    env.NOTIFICATION_PROVIDER ?? (env.RESEND_API_KEY ? "resend" : "fake");

  if (selection === "resend") {
    if (!env.RESEND_API_KEY || !env.NOTIFICATION_EMAIL_FROM) {
      throw new NotificationConfigError(
        "Notification provider 'resend' requires RESEND_API_KEY and NOTIFICATION_EMAIL_FROM.",
      );
    }
    return new ResendEmailProvider({
      apiKey: env.RESEND_API_KEY,
      from: env.NOTIFICATION_EMAIL_FROM,
    });
  }

  // selection === "fake"
  if (isProduction) {
    throw new NotificationConfigError(
      "Notification provider 'fake' is not permitted in production. Configure RESEND_API_KEY and NOTIFICATION_EMAIL_FROM.",
    );
  }
  return new FakeNotificationProvider();
}
