import { describe, expect, it } from "vitest";

import {
  ALLOWED_REQUEST_HEADERS,
  sanitizeBreadcrumb,
  scrubSentryEvent,
  stripUrlQuery,
  type Redactor,
} from "./privacy";

// Test redactor mirroring the base template's behavior: mark any string
// containing an @ or looking token-ish.
const redact: Redactor = (value) =>
  value
    .replace(/\S+@\S+\.\S+/g, "[redacted-email]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted-token]");

describe("stripUrlQuery", () => {
  it("removes query and fragment, keeps origin+path", () => {
    expect(stripUrlQuery("https://x.com/a?token=t#f")).toBe("https://x.com/a");
  });
  it("handles non-URL input without throwing", () => {
    expect(stripUrlQuery("notaurl?x=1")).toBe("notaurl");
  });
});

describe("scrubSentryEvent", () => {
  it("drops user identity entirely", () => {
    const event = scrubSentryEvent(
      { user: { id: "u1", email: "a@b.c", ip_address: "1.2.3.4" } },
      redact,
    );
    expect(event.user).toBeUndefined();
  });

  it("filters request headers to the allowlist and drops cookies/data/query", () => {
    const event = scrubSentryEvent(
      {
        request: {
          url: "https://app.example/checkout?token=secret",
          headers: {
            host: "app.example",
            "user-agent": "test",
            cookie: "session=abc",
            authorization: "Bearer xyz",
            "x-forwarded-for": "1.2.3.4",
          },
          cookies: { session: "abc" },
          data: { body: "sensitive" },
          query_string: "token=secret",
        },
      },
      redact,
    );
    const req = event.request!;
    expect(req.url).toBe("https://app.example/checkout");
    expect(Object.keys(req.headers!).sort()).toEqual(["host", "user-agent"]);
    expect(req.cookies).toBeUndefined();
    expect(req.data).toBeUndefined();
    expect(req.query_string).toBeUndefined();
  });

  it("redacts breadcrumb messages and extras", () => {
    const event = scrubSentryEvent(
      {
        breadcrumbs: [
          { message: "sent to user@example.com", category: "http" },
        ],
        extra: { note: "contact admin@example.com", count: 3 },
      },
      redact,
    );
    expect(event.breadcrumbs![0]!.message).toBe("sent to [redacted-email]");
    expect(event.extra!.note).toBe("contact [redacted-email]");
    expect(event.extra!.count).toBe(3);
  });
});

describe("sanitizeBreadcrumb", () => {
  it("strips query strings from url-ish data keys", () => {
    const crumb = sanitizeBreadcrumb(
      { data: { url: "https://x.com/p?tok=1", method: "GET" } },
      redact,
    );
    expect(crumb.data!.url).toBe("https://x.com/p");
    expect(crumb.data!.method).toBe("GET");
  });
});

describe("ALLOWED_REQUEST_HEADERS", () => {
  it("excludes credential-bearing headers", () => {
    for (const h of [
      "cookie",
      "authorization",
      "x-forwarded-for",
      "set-cookie",
    ]) {
      expect(ALLOWED_REQUEST_HEADERS.has(h)).toBe(false);
    }
  });
});
