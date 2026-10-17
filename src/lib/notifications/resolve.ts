import {
  parseAppEnvironment,
  parseNotificationEnvironment,
  parseWhatsAppEnvironment,
} from "@/lib/env";

import { FakeNotificationProvider } from "./fake";
import {
  NotificationConfigError,
  type NotificationChannelName,
  type NotificationProvider,
} from "./provider";
import { ResendEmailProvider } from "./resend";
import { MetaWhatsAppProvider } from "./whatsapp";

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
 * - Preview deployments (VERCEL_ENV=preview) get an additional
 *   isolation rule: a present RESEND_API_KEY alone does NOT select
 *   real delivery — previews must not send real email merely because
 *   their environment inherited production-shaped values. Selecting
 *   `resend` on a preview requires BOTH the explicit
 *   `NOTIFICATION_PROVIDER=resend` and a preview-scoped
 *   `ALLOW_RESEND_IN_PREVIEW=true` (intended for a dedicated preview
 *   Resend key/domain, never the production one).
 *
 * Resolution is lazy — called at dispatch time so `next build` with
 * zero env vars never touches provider config.
 */
export function resolveNotificationProvider(
  channel: NotificationChannelName,
  values: Record<string, string | undefined> = process.env,
): NotificationProvider {
  if (channel === "WHATSAPP") {
    return resolveWhatsAppProvider(values);
  }
  if (channel !== "EMAIL") {
    throw new NotificationConfigError(
      `No notification provider is implemented for channel ${channel}.`,
    );
  }

  const env = parseNotificationEnvironment(values);
  const app = parseAppEnvironment(values);
  const isProduction =
    app.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
  const isPreview = app.VERCEL_ENV === "preview";

  const selection =
    env.NOTIFICATION_PROVIDER ??
    (env.RESEND_API_KEY && !isPreview ? "resend" : "fake");

  if (selection === "resend") {
    if (!env.RESEND_API_KEY || !env.NOTIFICATION_EMAIL_FROM) {
      throw new NotificationConfigError(
        "Notification provider 'resend' requires RESEND_API_KEY and NOTIFICATION_EMAIL_FROM.",
      );
    }
    if (isPreview && app.ALLOW_RESEND_IN_PREVIEW !== "true") {
      throw new NotificationConfigError(
        "Notification provider 'resend' is not permitted on preview deployments by default. To send real email from a preview deliberately (e.g. a dedicated preview Resend key and domain), set ALLOW_RESEND_IN_PREVIEW=true as a preview-scoped variable.",
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

/**
 * WhatsApp provider resolution — the same fail-closed contract as the
 * email resolver (issue #100):
 * - WHATSAPP_PROVIDER=meta, or unset with WHATSAPP_ACCESS_TOKEN
 *   present → Meta Cloud API; requires the token AND
 *   WHATSAPP_PHONE_NUMBER_ID.
 * - Preview deployments cannot send real WhatsApp traffic merely
 *   because envs exist — meta on preview also requires
 *   ALLOW_WHATSAPP_IN_PREVIEW=true (a dedicated sandbox sender).
 * - Production must never silently use the fake — unconfigured or
 *   explicitly-fake production throws, so a missing credential fails
 *   the send loudly instead of pretending delivery.
 */
function resolveWhatsAppProvider(
  values: Record<string, string | undefined>,
): NotificationProvider {
  const env = parseWhatsAppEnvironment(values);
  const app = parseAppEnvironment(values);
  const isProduction =
    app.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
  const isPreview = app.VERCEL_ENV === "preview";

  const selection =
    env.WHATSAPP_PROVIDER ??
    (env.WHATSAPP_ACCESS_TOKEN && !isPreview ? "meta" : "fake");

  if (selection === "meta") {
    if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
      throw new NotificationConfigError(
        "Notification provider 'meta' requires WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.",
      );
    }
    if (isPreview && app.ALLOW_WHATSAPP_IN_PREVIEW !== "true") {
      throw new NotificationConfigError(
        "Notification provider 'meta' is not permitted on preview deployments by default. To send real WhatsApp traffic from a preview deliberately (a dedicated sandbox sender), set ALLOW_WHATSAPP_IN_PREVIEW=true as a preview-scoped variable.",
      );
    }
    return new MetaWhatsAppProvider({
      accessToken: env.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      apiVersion: env.WHATSAPP_API_VERSION,
    });
  }

  // selection === "fake"
  if (isProduction) {
    throw new NotificationConfigError(
      "Notification provider 'fake' is not permitted in production. Configure WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.",
    );
  }
  return new FakeNotificationProvider({ channel: "WHATSAPP" });
}
