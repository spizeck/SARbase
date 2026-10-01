import { describe, expect, it } from "vitest";

import { NotificationConfigError } from "./provider";
import { normalizeResendError, ResendEmailProvider } from "./resend";
import type { ResendClientLike } from "./resend";
import { resolveNotificationProvider } from "./resolve";

/**
 * Resend adapter tests — the SDK client is injected (ResendClientLike),
 * so no network and no `vi.mock` on the package are involved.
 */

function clientReturning(response: {
  data: { id: string } | null;
  error: { message: string; statusCode: number | null; name: string } | null;
}): ResendClientLike & { calls: { payload: unknown; options: unknown }[] } {
  const calls: { payload: unknown; options: unknown }[] = [];
  return {
    calls,
    emails: {
      async send(payload, options) {
        calls.push({ payload, options });
        return response;
      },
    },
  };
}

describe("ResendEmailProvider", () => {
  const request = {
    channel: "EMAIL" as const,
    to: "member@example.org",
    subject: "Radio check",
    text: "Reminder.",
    idempotencyKey: "notif_1/attempt-1",
  };

  it("maps an accepted send to the normalized outcome with the provider id", async () => {
    const client = clientReturning({
      data: { id: "re_abc123" },
      error: null,
    });
    const provider = new ResendEmailProvider({
      apiKey: "re_test",
      from: "SARbase <notify@example.org>",
      client,
    });
    const result = await provider.send(request);
    expect(result).toEqual({
      status: "accepted",
      providerMessageId: "re_abc123",
    });
    // Request mapping: correct shape + the SARbase attempt key flows to
    // the provider's idempotency header.
    expect(client.calls[0]!.payload).toEqual({
      from: "SARbase <notify@example.org>",
      to: ["member@example.org"],
      subject: "Radio check",
      text: "Reminder.",
    });
    expect(client.calls[0]!.options).toEqual({
      idempotencyKey: "notif_1/attempt-1",
    });
  });

  it("normalizes a 422 validation rejection as non-retryable without leaking the message", async () => {
    const client = clientReturning({
      data: null,
      error: {
        message: "The recipient member@example.org is invalid",
        statusCode: 422,
        name: "validation_error",
      },
    });
    const provider = new ResendEmailProvider({
      apiKey: "re_test",
      from: "from@example.org",
      client,
    });
    const result = await provider.send(request);
    expect(result).toEqual({
      status: "failed",
      errorCode: "provider_rejected",
      errorSummary:
        "The email provider rejected the message as invalid. Retrying the unchanged request will not succeed.",
      retryable: false,
    });
    // The provider's raw message (which echoes the recipient) is not
    // propagated anywhere in the normalized result.
    expect(JSON.stringify(result)).not.toContain("member@example.org");
  });

  it("classifies credential failures as provider_auth (non-retryable)", async () => {
    const client = clientReturning({
      data: null,
      error: {
        message: "API key is invalid",
        statusCode: 401,
        name: "invalid_api_key",
      },
    });
    const provider = new ResendEmailProvider({
      apiKey: "re_bad",
      from: "from@example.org",
      client,
    });
    const result = await provider.send(request);
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "provider_auth",
      retryable: false,
    });
  });

  it("classifies rate limiting as retryable provider_unavailable", async () => {
    const client = clientReturning({
      data: null,
      error: {
        message: "Too many requests",
        statusCode: 429,
        name: "rate_limit_exceeded",
      },
    });
    const provider = new ResendEmailProvider({
      apiKey: "re_test",
      from: "from@example.org",
      client,
    });
    const result = await provider.send(request);
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "provider_unavailable",
      retryable: true,
    });
  });

  it("normalizes a thrown transport error as provider_unavailable", async () => {
    const client: ResendClientLike = {
      emails: {
        async send() {
          throw new Error("socket hangup to member@example.org");
        },
      },
    };
    const provider = new ResendEmailProvider({
      apiKey: "re_test",
      from: "from@example.org",
      client,
    });
    const result = await provider.send(request);
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "provider_unavailable",
      retryable: true,
    });
    expect(JSON.stringify(result)).not.toContain("member@example.org");
  });
});

describe("normalizeResendError ordering", () => {
  it("a named rejection wins over a 403 status (unverified domain case)", () => {
    // Resend returns validation_error with HTTP 403 for an unverified
    // sending domain or test-mode recipient restriction — the message is
    // wrong, not the credentials. The name check must run first.
    expect(
      normalizeResendError({ name: "validation_error", statusCode: 403 }),
    ).toMatchObject({ errorCode: "provider_rejected", retryable: false });
  });
});

describe("normalizeResendError", () => {
  it("treats 5xx and unknown names as retryable provider errors", () => {
    expect(
      normalizeResendError({ name: "internal_server_error", statusCode: 500 }),
    ).toMatchObject({ errorCode: "provider_error", retryable: true });
    expect(
      normalizeResendError({ name: "application_error", statusCode: null }),
    ).toMatchObject({ errorCode: "provider_error", retryable: true });
  });

  it("treats other 4xx as non-retryable rejections", () => {
    expect(
      normalizeResendError({ name: "not_found", statusCode: 404 }),
    ).toMatchObject({ errorCode: "provider_rejected", retryable: false });
  });
});

describe("resolveNotificationProvider", () => {
  const origNodeEnv = process.env.NODE_ENV;

  it("returns a real provider when resend is fully configured", () => {
    const provider = resolveNotificationProvider("EMAIL", {
      NOTIFICATION_PROVIDER: "resend",
      RESEND_API_KEY: "re_x",
      NOTIFICATION_EMAIL_FROM: "SARbase <notify@example.org>",
    });
    expect(provider.providerName).toBe("resend");
  });

  it("requires both resend variables", () => {
    expect(() =>
      resolveNotificationProvider("EMAIL", {
        NOTIFICATION_PROVIDER: "resend",
        RESEND_API_KEY: "re_x",
      }),
    ).toThrow(NotificationConfigError);
    expect(() =>
      resolveNotificationProvider("EMAIL", {
        RESEND_API_KEY: "re_x",
      }),
    ).toThrow(NotificationConfigError);
  });

  it("falls back to the fake provider when unconfigured outside production", () => {
    expect(origNodeEnv).not.toBe("production");
    const provider = resolveNotificationProvider("EMAIL", {});
    expect(provider.providerName).toBe("fake");
  });

  it("explicit fake selection works outside production", () => {
    const provider = resolveNotificationProvider("EMAIL", {
      NOTIFICATION_PROVIDER: "fake",
    });
    expect(provider.providerName).toBe("fake");
  });

  it("never selects fake in a production deployment — even explicitly", () => {
    expect(() =>
      resolveNotificationProvider("EMAIL", {
        NOTIFICATION_PROVIDER: "fake",
        VERCEL_ENV: "production",
      }),
    ).toThrow(NotificationConfigError);
    expect(() =>
      resolveNotificationProvider("EMAIL", { VERCEL_ENV: "production" }),
    ).toThrow(NotificationConfigError);
  });

  it("rejects channels with no provider", () => {
    expect(() => resolveNotificationProvider("SMS" as never, {})).toThrow(
      NotificationConfigError,
    );
  });
});
