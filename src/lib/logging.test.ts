import { describe, expect, it } from "vitest";

import {
  buildRequestErrorEvent,
  formatLogEvent,
  redactString,
  summarizeError,
} from "./logging";

describe("formatLogEvent", () => {
  it("emits a single-line JSON event with level, outcome, and timestamp", () => {
    const parsed = JSON.parse(
      formatLogEvent({ event: "thing_happened", entityId: "abc" }),
    );
    expect(parsed.event).toBe("thing_happened");
    expect(parsed.level).toBe("info");
    expect(parsed.outcome).toBe("success");
    expect(parsed.entityId).toBe("abc");
    expect(typeof parsed.ts).toBe("string");
  });

  it("derives outcomes from level when not given", () => {
    expect(
      JSON.parse(formatLogEvent({ event: "x", level: "warn" })).outcome,
    ).toBe("expected_failure");
    expect(
      JSON.parse(formatLogEvent({ event: "x", level: "error" })).outcome,
    ).toBe("operational_failure");
  });

  it("drops forbidden fields and reports them in redactedFields", () => {
    const parsed = JSON.parse(
      formatLogEvent({
        event: "x",
        email: "someone@example.com",
        token: "abc",
      }),
    );
    expect(parsed.email).toBeUndefined();
    expect(parsed.token).toBeUndefined();
    expect(parsed.redactedFields).toContain("email");
    expect(parsed.redactedFields).toContain("token");
  });

  it("redacts sensitive values even under safe-looking keys", () => {
    const parsed = JSON.parse(
      formatLogEvent({
        event: "x",
        note1: "contact me at user@example.com",
        note2: "postgresql://u:p@host.example.com/db",
        note3: "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----",
      }),
    );
    expect(parsed.note1).toBe("contact me at [redacted-email]");
    expect(parsed.note2).toBe("[redacted-url]");
    expect(parsed.note3).toBe("[redacted-key]");
  });

  it("keeps deliberate identifiers under *id keys but still redacts emails", () => {
    const parsed = JSON.parse(
      formatLogEvent({
        event: "x",
        providerMessageId: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
        actorId: "user@example.com",
      }),
    );
    expect(parsed.providerMessageId).toBe("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4");
    expect(parsed.actorId).toBe("[redacted-email]");
  });

  it("summarizes Error objects instead of logging messages or stacks", () => {
    const parsed = JSON.parse(
      formatLogEvent({ event: "x", detail: new TypeError("secret details") }),
    );
    expect(parsed.detail.errorName).toBe("TypeError");
    expect(JSON.stringify(parsed)).not.toContain("secret details");
  });
});

describe("summarizeError", () => {
  it("returns the error class name and machine code/digest only", () => {
    const err = new Error("do not log this message");
    err.name = "ProviderError";
    (err as { code?: string }).code = "auth/invalid-credential";
    expect(summarizeError(err)).toEqual({
      errorName: "ProviderError",
      errorCode: "auth/invalid-credential",
    });
  });

  it("rejects non-identifier names and non-machine codes", () => {
    const err = new Error("x");
    err.name = "user@example.com broke";
    (err as { code?: string }).code = "something happened to user@example.com";
    expect(summarizeError(err).errorName).toBe("Error");
    expect(summarizeError(err).errorCode).toBeUndefined();
  });

  it("handles non-Error throws", () => {
    expect(summarizeError("nope")).toEqual({ errorName: "non_error_throw" });
  });
});

describe("buildRequestErrorEvent", () => {
  const request = {
    path: "/api/thing?token=secret123",
    method: "GET",
    headers: { "x-vercel-id": "req-1", authorization: "Bearer x" },
  };

  it("builds an unexpected_failure event with query stripped", () => {
    const event = buildRequestErrorEvent(new Error("boom"), request, {});
    expect(event?.event).toBe("unhandled_request_error");
    expect(event?.outcome).toBe("unexpected_failure");
    expect(event?.path).toBe("/api/thing");
    expect(event?.requestId).toBe("req-1");
  });

  it("returns null for NEXT_* control-flow digests", () => {
    const err = new Error("x") as Error & { digest?: string };
    err.digest = "NEXT_REDIRECT;/login";
    expect(buildRequestErrorEvent(err, request, {})).toBeNull();
  });
});

describe("redactString", () => {
  it("redacts JWTs", () => {
    expect(
      redactString(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        false,
      ),
    ).toBe("[redacted-token]");
  });
});
