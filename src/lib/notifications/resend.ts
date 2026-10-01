import type {
  NotificationProvider,
  ProviderSendRequest,
  ProviderSendResult,
} from "./provider";

/**
 * Resend email provider — the real baseline channel for issue #13.
 *
 * Chosen by repository audit: SARbase and app-foundations have no
 * established email provider, and Resend's official SDK is small,
 * maintained, returns typed `{ data, error }` results instead of
 * throwing, and supports an `Idempotency-Key` header — a second
 * dedupe layer underneath SARbase's own database-level guarantee.
 *
 * Isolation rules:
 * - the `resend` package is imported ONLY here — no other module may
 *   reference Resend SDK types;
 * - `error.message` from the SDK is NEVER propagated or logged — it can
 *   echo the recipient address or request payload. We map the machine
 *   `error.name`/`error.statusCode` to SARbase codes and summaries;
 * - the API key is read from env at construction and never appears in
 *   results, logs, or thrown values.
 */

/**
 * The slice of the Resend SDK this adapter uses — declared structurally
 * so tests inject a fake client without `vi.mock` and without the SDK
 * in the test's module graph.
 */
export interface ResendClientLike {
  emails: {
    send(
      payload: {
        from: string;
        to: string[];
        subject: string;
        text: string;
      },
      options?: { idempotencyKey?: string },
    ): Promise<{
      data: { id: string } | null;
      error: {
        message: string;
        statusCode: number | null;
        name: string;
      } | null;
    }>;
  };
}

export interface ResendProviderConfig {
  apiKey: string;
  /** Verified sender, e.g. "SARbase Notifications <notify@example.org>". */
  from: string;
  /** Test seam — a ResendClientLike. Defaults to the real SDK. */
  client?: ResendClientLike;
}

/** Error names Resend returns for credential/permission failures. */
const AUTH_ERROR_NAMES = new Set([
  "missing_api_key",
  "invalid_api_key",
  "restricted_api_key",
  "security_error",
]);

/** Error names that mean "the provider never accepted this message". */
const REJECTION_ERROR_NAMES = new Set([
  "validation_error",
  "missing_required_field",
  "invalid_parameter",
  "invalid_from_address",
  "invalid_idempotent_request",
  "invalid_idempotency_key",
]);

/**
 * Map a Resend `{ name, statusCode }` error to a normalized SARbase
 * failure. The provider's `message` is deliberately unread — it may
 * contain the recipient address or payload text.
 */
export function normalizeResendError(error: {
  name: string;
  statusCode: number | null;
}): Extract<ProviderSendResult, { status: "failed" }> {
  if (
    AUTH_ERROR_NAMES.has(error.name) ||
    error.statusCode === 401 ||
    error.statusCode === 403
  ) {
    return {
      status: "failed",
      errorCode: "provider_auth",
      errorSummary:
        "The email provider rejected the configured credentials. Check the provider API key configuration.",
      retryable: false,
    };
  }
  if (error.name === "rate_limit_exceeded" || error.statusCode === 429) {
    return {
      status: "failed",
      errorCode: "provider_unavailable",
      errorSummary:
        "The email provider rate-limited the request. Retrying later may succeed.",
      retryable: true,
    };
  }
  if (REJECTION_ERROR_NAMES.has(error.name)) {
    return {
      status: "failed",
      errorCode: "provider_rejected",
      errorSummary:
        "The email provider rejected the message as invalid. Retrying the unchanged request will not succeed.",
      retryable: false,
    };
  }
  if (
    error.statusCode !== null &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  ) {
    return {
      status: "failed",
      errorCode: "provider_rejected",
      errorSummary:
        "The email provider rejected the message. Retrying the unchanged request will not succeed.",
      retryable: false,
    };
  }
  // 5xx, unknown names, missing status — treat as provider-side/transient.
  return {
    status: "failed",
    errorCode: "provider_error",
    errorSummary: "The email provider reported an error. Retrying may succeed.",
    retryable: true,
  };
}

export class ResendEmailProvider implements NotificationProvider {
  readonly providerName = "resend";
  readonly channel = "EMAIL" as const;

  private readonly from: string;
  private client: ResendClientLike | undefined;
  private readonly apiKey: string;

  constructor(config: ResendProviderConfig) {
    this.apiKey = config.apiKey;
    this.from = config.from;
    this.client = config.client;
  }

  /** Lazy SDK construction — importing this module never builds a client. */
  private async getClient(): Promise<ResendClientLike> {
    if (!this.client) {
      const { Resend } = await import("resend");
      this.client = new Resend(this.apiKey);
    }
    return this.client;
  }

  async send(request: ProviderSendRequest): Promise<ProviderSendResult> {
    const client = await this.getClient();
    let response;
    try {
      response = await client.emails.send(
        {
          from: this.from,
          to: [request.to],
          subject: request.subject ?? "",
          // Plain text only for v1 — no HTML templating yet.
          text: request.text ?? "",
        },
        { idempotencyKey: request.idempotencyKey },
      );
    } catch {
      // A thrown SDK/network error carries no trusted structure at all —
      // classify it as transient provider unavailability without reading
      // the message (it can embed the request payload).
      return {
        status: "failed",
        errorCode: "provider_unavailable",
        errorSummary:
          "The email provider could not be reached. Retrying may succeed.",
        retryable: true,
      };
    }

    if (response.error) {
      return normalizeResendError(response.error);
    }
    return {
      status: "accepted",
      providerMessageId: response.data?.id ?? null,
    };
  }
}
