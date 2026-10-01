import type {
  NotificationProvider,
  ProviderSendRequest,
  ProviderSendResult,
} from "./provider";

/**
 * Deterministic in-process provider for tests and credential-free
 * development. It NEVER touches the network — `send` records the
 * request in `calls` and returns a scripted (or default-accepted)
 * result.
 *
 * Scripted results are consumed in order; once the script is exhausted
 * the default outcome applies, so a test can say "first attempt fails
 * retryably, the retry succeeds" deterministically.
 *
 * This provider is also what `resolve.ts` returns for unconfigured
 * non-production environments — the honest local default. It is never
 * selectable in a real production deployment (VERCEL_ENV=production
 * fails closed there).
 */
export class FakeNotificationProvider implements NotificationProvider {
  readonly providerName = "fake";
  readonly channel = "EMAIL" as const;

  /** Every request this instance was asked to send, in order. */
  readonly calls: ProviderSendRequest[] = [];

  private script: ProviderSendResult[];
  private readonly defaultResult: ProviderSendResult;

  constructor(
    options: {
      /** Outcomes consumed in order; exhausted script → defaultResult. */
      results?: ProviderSendResult[];
      /** Outcome once the script is exhausted. Default: accepted. */
      defaultResult?: ProviderSendResult;
    } = {},
  ) {
    this.script = [...(options.results ?? [])];
    this.defaultResult = options.defaultResult ?? {
      status: "accepted",
      providerMessageId: null,
    };
  }

  send(request: ProviderSendRequest): Promise<ProviderSendResult> {
    this.calls.push(request);
    const scripted = this.script.shift();
    if (scripted) {
      return Promise.resolve(scripted);
    }
    // A default acceptance assigns a deterministic per-call message id
    // so tests can assert providerMessageId persistence without network;
    // a scripted defaultResult is returned verbatim (e.g. "always
    // fail retryably").
    if (
      this.defaultResult.status === "accepted" &&
      this.defaultResult.providerMessageId === null
    ) {
      return Promise.resolve({
        status: "accepted",
        providerMessageId: `fake-msg-${this.calls.length}`,
      });
    }
    return Promise.resolve(this.defaultResult);
  }
}

/** Canned failure outcomes for scripting. */
export const fakeFailure = {
  rejected: (summary = "The provider rejected the message.") =>
    ({
      status: "failed",
      errorCode: "provider_rejected",
      errorSummary: summary,
      retryable: false,
    }) satisfies ProviderSendResult,
  unavailable: () =>
    ({
      status: "failed",
      errorCode: "provider_unavailable",
      errorSummary: "The provider could not be reached. Retry may succeed.",
      retryable: true,
    }) satisfies ProviderSendResult,
  error: () =>
    ({
      status: "failed",
      errorCode: "provider_error",
      errorSummary: "The provider reported an internal error.",
      retryable: true,
    }) satisfies ProviderSendResult,
};
