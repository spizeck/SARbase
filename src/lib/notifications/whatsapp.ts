import type {
  NotificationProvider,
  ProviderSendRequest,
  ProviderSendResult,
} from "./provider";

/**
 * Meta WhatsApp Business Platform (Cloud API) provider — issue #100.
 *
 * Business-initiated WhatsApp messages are TEMPLATE-ONLY (the 24-hour
 * customer-service window only applies to member-initiated threads),
 * so this adapter only sends `type: "template"` payloads resolved
 * from the internal registry. Free-form text is never sent.
 *
 * Isolation rules (same contract as the Resend adapter):
 * - the access token arrives via config at construction and never
 *   appears in results, errors, or logs;
 * - Meta's `error.message` / `error.error_data` are NEVER propagated —
 *   they can echo the request payload. Only the numeric `code` and
 *   `error_subcode` drive classification;
 * - `request.to` is the E.164 digit string resolved by the domain —
 *   the adapter sends exactly that, no re-interpretation.
 *
 * Determinism: `fetchImpl` is injectable so tests assert the exact
 * request envelope without the network or `vi.mock`.
 */

export type WhatsAppFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface WhatsAppProviderConfig {
  accessToken: string;
  phoneNumberId: string;
  /** Pinned Graph API version segment, e.g. "v24.0". */
  apiVersion?: string;
  /** Test seam — defaults to a wrapped global fetch. */
  fetchImpl?: WhatsAppFetch;
  /** Base URL override for tests; Meta production is graph.facebook.com. */
  baseUrl?: string;
}

const DEFAULT_API_VERSION = "v24.0";
const DEFAULT_BASE_URL = "https://graph.facebook.com";

/** Meta error codes meaning our credentials/app can't send. */
const AUTH_ERROR_CODES = new Set([190]);
/** Rejections an operator can fix WITHOUT changing the request —
 * retrying after the fix can succeed (template approval etc.). */
const RETRYABLE_REJECTION_CODES = new Set([
  132001, // template name does not exist for this account/language
  132016, // template paused/disabled — may be re-enabled
]);

interface MetaErrorBody {
  error?: {
    code?: number;
    error_subcode?: number;
    type?: string;
  };
}

function normalizeMetaError(
  status: number,
  body: MetaErrorBody | null,
): Extract<ProviderSendResult, { status: "failed" }> {
  const code = body?.error?.code ?? null;
  if (
    status === 401 ||
    status === 403 ||
    (code != null && AUTH_ERROR_CODES.has(code))
  ) {
    return {
      status: "failed",
      errorCode: "provider_auth",
      errorSummary:
        "The WhatsApp provider rejected the configured credentials. Check the access token configuration.",
      retryable: false,
    };
  }
  if (status === 429 || code === 4 || code === 80007) {
    return {
      status: "failed",
      errorCode: "provider_unavailable",
      errorSummary:
        "The WhatsApp provider rate-limited the request. Retrying later may succeed.",
      retryable: true,
    };
  }
  if (code != null && RETRYABLE_REJECTION_CODES.has(code)) {
    return {
      status: "failed",
      errorCode: "provider_rejected",
      errorSummary:
        "The WhatsApp template is not available to this account (missing or unapproved). Retry after the template issue is resolved.",
      retryable: true,
    };
  }
  if (status >= 400 && status < 500) {
    return {
      status: "failed",
      errorCode: "provider_rejected",
      errorSummary:
        "The WhatsApp provider rejected the message. Retrying the unchanged request will not succeed.",
      retryable: false,
    };
  }
  return {
    status: "failed",
    errorCode: "provider_error",
    errorSummary:
      "The WhatsApp provider reported an error. Retrying may succeed.",
    retryable: true,
  };
}

async function defaultFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(15_000),
  });
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json() as Promise<unknown>,
  };
}

export class MetaWhatsAppProvider implements NotificationProvider {
  readonly providerName = "meta-whatsapp";
  readonly channel = "WHATSAPP" as const;

  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: WhatsAppFetch;

  constructor(config: WhatsAppProviderConfig) {
    this.accessToken = config.accessToken;
    this.phoneNumberId = config.phoneNumberId;
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = config.fetchImpl ?? defaultFetch;
  }

  async send(request: ProviderSendRequest): Promise<ProviderSendResult> {
    // Template-only channel: a request without a resolved template is
    // a caller bug — fail locally rather than shipping malformed JSON.
    if (!request.template) {
      return {
        status: "failed",
        errorCode: "provider_rejected",
        errorSummary:
          "No WhatsApp template was resolved for this notification.",
        retryable: false,
      };
    }
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: request.to,
      type: "template",
      template: {
        name: request.template.name,
        language: { code: request.template.language },
        components: [
          {
            type: "body",
            parameters: request.template.parameters.map((text) => ({
              type: "text",
              text,
            })),
          },
        ],
      },
    };

    let response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/${this.apiVersion}/${this.phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );
    } catch {
      return {
        status: "failed",
        errorCode: "provider_unavailable",
        errorSummary:
          "The WhatsApp provider could not be reached. Retrying may succeed.",
        retryable: true,
      };
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      return normalizeMetaError(response.status, body as MetaErrorBody | null);
    }

    const messageId = (body as { messages?: { id?: string }[] } | null)
      ?.messages?.[0]?.id;
    return {
      status: "accepted",
      providerMessageId: messageId ?? null,
    };
  }
}
