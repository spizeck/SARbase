import { describe, expect, it } from "vitest";

import { MetaWhatsAppProvider, type WhatsAppFetch } from "./whatsapp";
import { normalizePhoneToE164Digits } from "./phone";
import {
  resolveWhatsAppTemplate,
  WHATSAPP_TEMPLATE_IDS,
} from "./whatsapp-templates";

/**
 * Adapter unit tests — the injectable fetch records the exact request
 * envelope, and every Meta failure shape is asserted against the
 * normalized failure taxonomy. No network, no vi.mock.
 */

function recordingFetch(responses: { status: number; body?: unknown }[]): {
  fetchImpl: WhatsAppFetch;
  calls: {
    url: string;
    init: { method: string; headers: Record<string, string>; body: string };
  }[];
} {
  const calls: {
    url: string;
    init: { method: string; headers: Record<string, string>; body: string };
  }[] = [];
  let i = 0;
  const fetchImpl: WhatsAppFetch = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () => Promise.resolve(r.body ?? null),
    };
  };
  return { fetchImpl, calls };
}

function providerWith(fetchImpl: WhatsAppFetch) {
  return new MetaWhatsAppProvider({
    accessToken: "test-token",
    phoneNumberId: "123456789",
    apiVersion: "v24.0",
    fetchImpl,
  });
}

const sendRequest = {
  channel: "WHATSAPP" as const,
  to: "5994161234",
  subject: null,
  text: null,
  idempotencyKey: "n1/attempt-1",
  template: {
    name: "sarbase_callout_alert",
    language: "en",
    parameters: ["Saba SAR", "Missing hiker", "https://x/respond?t=tok"],
  },
};

describe("MetaWhatsAppProvider", () => {
  it("sends a template message to the phone-number-id endpoint", async () => {
    const { fetchImpl, calls } = recordingFetch([
      { status: 200, body: { messages: [{ id: "wamid.abc123" }] } },
    ]);
    const result = await providerWith(fetchImpl).send(sendRequest);

    expect(result).toEqual({
      status: "accepted",
      providerMessageId: "wamid.abc123",
    });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://graph.facebook.com/v24.0/123456789/messages");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer test-token");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      messaging_product: "whatsapp",
      to: "5994161234",
      type: "template",
      template: {
        name: "sarbase_callout_alert",
        language: { code: "en" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Saba SAR" },
              { type: "text", text: "Missing hiker" },
              { type: "text", text: "https://x/respond?t=tok" },
            ],
          },
        ],
      },
    });
  });

  it("classifies 401/403 as provider_auth (non-retryable)", async () => {
    const { fetchImpl } = recordingFetch([
      { status: 401, body: { error: { code: 190, message: "bad token" } } },
    ]);
    const result = await providerWith(fetchImpl).send(sendRequest);
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "provider_auth",
      retryable: false,
    });
    // The provider's message text must never surface.
    if (result.status === "failed") {
      expect(result.errorSummary).not.toContain("bad token");
    }
  });

  it("classifies 429 as provider_unavailable (retryable)", async () => {
    const { fetchImpl } = recordingFetch([{ status: 429, body: {} }]);
    const result = await providerWith(fetchImpl).send(sendRequest);
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "provider_unavailable",
      retryable: true,
    });
  });

  it("classifies an unapproved template (132001) as rejected but retryable after approval", async () => {
    const { fetchImpl } = recordingFetch([
      {
        status: 400,
        body: {
          error: {
            code: 132001,
            message: "Template name does not exist in the translation",
          },
        },
      },
    ]);
    const result = await providerWith(fetchImpl).send(sendRequest);
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "provider_rejected",
      retryable: true,
    });
    if (result.status === "failed") {
      expect(result.errorSummary).not.toContain(
        "does not exist in the translation",
      );
    }
  });

  it("classifies other 4xx as rejected and non-retryable", async () => {
    const { fetchImpl } = recordingFetch([
      { status: 400, body: { error: { code: 131026, message: "no wa" } } },
    ]);
    const result = await providerWith(fetchImpl).send(sendRequest);
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "provider_rejected",
      retryable: false,
    });
  });

  it("classifies a network failure as provider_unavailable", async () => {
    const fetchImpl: WhatsAppFetch = () =>
      Promise.reject(new Error("socket hang up"));
    const result = await providerWith(fetchImpl).send(sendRequest);
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "provider_unavailable",
      retryable: true,
    });
  });

  it("fails locally when no template was resolved", async () => {
    const { fetchImpl, calls } = recordingFetch([{ status: 200, body: {} }]);
    const result = await providerWith(fetchImpl).send({
      ...sendRequest,
      template: null,
    });
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "provider_rejected",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("normalizePhoneToE164Digits", () => {
  it("keeps a stored E.164 value as digits", () => {
    expect(normalizePhoneToE164Digits("+5994161234")).toBe("5994161234");
    expect(normalizePhoneToE164Digits("+1 246 555 0199")).toBe("12465550199");
  });
  it("returns null for national-format or invalid values", () => {
    // No guessing a country code — a wrong-number alert is worse.
    expect(normalizePhoneToE164Digits("4161234")).toBeNull();
    expect(normalizePhoneToE164Digits("not a phone")).toBeNull();
    expect(normalizePhoneToE164Digits("")).toBeNull();
    expect(normalizePhoneToE164Digits(null)).toBeNull();
  });
});

describe("whatsapp template registry", () => {
  it("resolves the callout alert with the secure link as a parameter", () => {
    const spec = resolveWhatsAppTemplate("callout_invitation");
    expect(spec).not.toBeNull();
    const params = spec!.parameters({
      organizationName: "Saba SAR",
      subject: "Missing hiker",
      secureLink: "https://x/respond?t=tok",
    });
    expect(params).toEqual([
      "Saba SAR",
      "Missing hiker",
      "https://x/respond?t=tok",
    ]);
    expect(spec!.metaName).toBe("sarbase_callout_alert");
  });

  it("flattens newlines and caps parameter length", () => {
    const spec = resolveWhatsAppTemplate(WHATSAPP_TEMPLATE_IDS.ADMIN_NOTICE)!;
    const params = spec.parameters({
      organizationName: "Org",
      subject: "line1\nline2\t" + "x".repeat(300),
      secureLink: null,
    });
    expect(params[1]).not.toMatch(/[\n\t]/);
    expect(params[1]!.length).toBeLessThanOrEqual(240);
  });

  it("returns null for unregistered template ids", () => {
    expect(resolveWhatsAppTemplate("no_such_template")).toBeNull();
  });
});
