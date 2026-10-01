/**
 * Provider-neutral notification dispatch seam (issue #13).
 *
 * This module is the boundary between SARbase domain code and any
 * delivery provider (Resend today; SMS/WhatsApp/push later). Domain
 * code speaks only in these normalized types — provider SDK objects,
 * HTTP responses, and raw error text never cross it.
 *
 * PRODUCT BOUNDARY: this is communication infrastructure only. A
 * provider result is a fact about a message ("the provider accepted
 * it"), never a conclusion about people ("a responder is available").
 * Nothing here decides who should be contacted, whether a crew is
 * sufficient, or whether a callout should escalate.
 *
 * Adding a channel/provider later: implement `NotificationProvider`
 * for the channel, register it in `resolve.ts`, and extend the channel
 * enum — the domain service (`src/lib/domain/notifications.ts`) does
 * not change.
 */

/** Channels SARbase can dispatch on. Mirrors the Prisma enum. */
export type NotificationChannelName = "EMAIL";

/**
 * Normalized failure classification. `retryable` answers "could a later
 * attempt of THIS UNCHANGED request plausibly succeed":
 * - config_missing — required provider configuration is absent. Not
 *   provider-transient, but an operator can fix configuration and
 *   retry — so eligible for manual retry.
 * - provider_auth — the provider rejected our credentials. Retrying the
 *   unchanged request cannot succeed; a manual retry is still allowed
 *   after the operator fixes credentials (the flag is advisory for the
 *   UI and any future automatic retry, which does not exist yet).
 * - provider_rejected — the provider refused the message itself
 *   (validation, policy). Permanent for this unchanged request.
 * - provider_unavailable — network failure, timeout, or provider
 *   rate-limit/5xx. Transient — retry may succeed.
 * - provider_error — an unclassified provider failure. Treated as
 *   potentially transient.
 */
export type NotificationFailureCode =
  | "config_missing"
  | "provider_auth"
  | "provider_rejected"
  | "provider_unavailable"
  | "provider_error";

/** Everything a provider needs to dispatch one message. */
export interface ProviderSendRequest {
  channel: NotificationChannelName;
  /** Destination snapshot — the exact address being sent to. */
  to: string;
  subject: string | null;
  text: string | null;
  /**
   * Provider-level idempotency key (e.g. Resend's `Idempotency-Key`
   * header). Scoped per attempt — `${notificationId}/attempt-N` — so a
   * retried attempt is a new provider operation while a crashed,
   * re-invoked same attempt can dedupe at the provider when supported.
   */
  idempotencyKey: string;
}

/**
 * The normalized provider outcome. `accepted` means the provider took
 * the message — it is NOT delivery confirmation; providers only
 * confirm acceptance synchronously. `providerMessageId` is the
 * provider's own identifier for later correlation (webhooks,
 * provider dashboards).
 */
export type ProviderSendResult =
  | { status: "accepted"; providerMessageId: string | null }
  | {
      status: "failed";
      errorCode: NotificationFailureCode;
      /**
       * Short operator-facing summary — assembled here, never copied
       * from the provider's raw message (those can echo recipient
       * addresses and request payloads).
       */
      errorSummary: string;
      retryable: boolean;
    };

export interface NotificationProvider {
  /** Stable identifier persisted on attempts ("resend", "fake"). */
  readonly providerName: string;
  readonly channel: NotificationChannelName;
  send(request: ProviderSendRequest): Promise<ProviderSendResult>;
}

/** Thrown when provider configuration is missing or inconsistent. */
export class NotificationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationConfigError";
  }
}
