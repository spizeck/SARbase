import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  buildErrorEnvelope,
  isApiError,
  normalizeError,
  REQUEST_ID_HEADER,
  resolveRequestId,
  sanitizeRequestId,
  withApiObservability,
} from "./api";
import { log, logExpected, logOperational } from "./logging";

vi.mock("./logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./logging")>();
  return {
    ...actual,
    log: vi.fn(),
    logExpected: vi.fn(),
    logOperational: vi.fn(),
  };
});

const mockLog = vi.mocked(log);
const mockLogExpected = vi.mocked(logExpected);
const mockLogOperational = vi.mocked(logOperational);

beforeEach(() => {
  mockLog.mockClear();
  mockLogExpected.mockClear();
  mockLogOperational.mockClear();
});

function requestWithId(id: string): Request {
  return new Request("https://app.example.com/api/things?token=secret", {
    headers: { [REQUEST_ID_HEADER]: id },
  });
}

function okHandler() {
  return vi.fn(async () =>
    Response.json(
      { ok: true },
      { status: 200, headers: { "x-custom": "yes" } },
    ),
  );
}

function emitted(mock: typeof mockLog, event: string) {
  return mock.mock.calls.map((c) => c[0]).filter((e) => e.event === event);
}

describe("sanitizeRequestId", () => {
  it("preserves valid incoming ids", () => {
    expect(sanitizeRequestId("abc-123_DEF")).toBe("abc-123_DEF");
    expect(sanitizeRequestId("a".repeat(64))).toBe("a".repeat(64));
  });

  it("rejects ids with unsafe characters", () => {
    for (const bad of [
      "id with spaces",
      "id;DROP TABLE",
      "id\ninjection",
      'id"quoted',
      "id\x00null",
      "email@example.com",
      "https://evil.example.com/?a=b",
    ]) {
      expect(sanitizeRequestId(bad)).toBeUndefined();
    }
  });

  it("rejects overlong ids", () => {
    expect(sanitizeRequestId("a".repeat(65))).toBeUndefined();
  });

  it("rejects missing and empty ids", () => {
    expect(sanitizeRequestId(undefined)).toBeUndefined();
    expect(sanitizeRequestId(null)).toBeUndefined();
    expect(sanitizeRequestId("")).toBeUndefined();
  });
});

describe("resolveRequestId", () => {
  it("uses a sanitized inbound header when present", () => {
    expect(resolveRequestId(requestWithId("req_abc-1"))).toBe("req_abc-1");
  });

  it("generates a UUID when the header is missing or invalid", () => {
    for (const req of [
      new Request("https://app.example.com/api"),
      requestWithId("bad id!"),
      requestWithId("x".repeat(100)),
    ]) {
      const id = resolveRequestId(req);
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });
});

describe("ApiError", () => {
  it("stores code, status, message, and cause", () => {
    const cause = new Error("db exploded with connection string");
    const err = new ApiError("CONFLICT", 409, "Already exists.", { cause });
    expect(err.code).toBe("CONFLICT");
    expect(err.status).toBe(409);
    expect(err.message).toBe("Already exists.");
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
    expect(isApiError(err)).toBe(true);
  });

  it("rejects non-error HTTP statuses", () => {
    expect(() => new ApiError("X", 200, "ok")).toThrow(RangeError);
    expect(() => new ApiError("X", 600, "nope")).toThrow(RangeError);
    expect(() => new ApiError("X", 404.5, "nope")).toThrow(RangeError);
  });

  it("clamps retryAfterSeconds to a non-negative integer", () => {
    expect(
      new ApiError("RATE_LIMITED", 429, "Slow down.", {
        retryAfterSeconds: 12.9,
      }).retryAfterSeconds,
    ).toBe(12);
    expect(
      new ApiError("RATE_LIMITED", 429, "Slow down.", {
        retryAfterSeconds: -5,
      }).retryAfterSeconds,
    ).toBe(0);
  });
});

describe("normalizeError", () => {
  it("passes a known ApiError through unchanged", () => {
    const err = new ApiError("VALIDATION", 400, "Bad input.");
    expect(normalizeError(err)).toBe(err);
  });

  it("converts an unknown Error to a safe internal error", () => {
    const raw = new Error("SELECT * FROM users WHERE email='a@b.c'");
    const normalized = normalizeError(raw);
    expect(isApiError(normalized)).toBe(true);
    expect(normalized.status).toBe(500);
    expect(normalized.code).toBe("INTERNAL_ERROR");
    expect(normalized.message).not.toContain("SELECT");
    expect(normalized.message).toBe("An unexpected error occurred.");
    expect(normalized.cause).toBe(raw);
  });

  it("converts non-Error throws to the same safe internal error", () => {
    for (const thrown of ["string failure", 42, { weird: true }, null]) {
      const normalized = normalizeError(thrown);
      expect(normalized.status).toBe(500);
      expect(normalized.code).toBe("INTERNAL_ERROR");
      expect(normalized.cause).toBe(thrown);
    }
  });
});

describe("buildErrorEnvelope", () => {
  it("produces the stable { error: { code, message, referenceId } } shape", () => {
    const env = buildErrorEnvelope(
      new ApiError("NOT_FOUND", 404, "Not found."),
      "req-1",
    );
    expect(env).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Not found.",
        referenceId: "req-1",
      },
    });
  });
});

describe("withApiObservability", () => {
  it("emits request.start and request.end with status and duration", async () => {
    const handler = withApiObservability("things.list", okHandler());
    await handler(requestWithId("req-42"), undefined);

    const starts = emitted(mockLog, "request.start");
    const ends = emitted(mockLog, "request.end");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      subsystem: "api",
      route: "things.list",
      method: "GET",
      path: "/api/things",
      requestId: "req-42",
    });
    expect(ends[0]).toMatchObject({
      status: 200,
      requestId: "req-42",
    });
    expect(typeof ends[0]!.durationMs).toBe("number");
    // Query strings can carry tokens — never logged.
    expect(JSON.stringify(starts[0])).not.toContain("token=secret");
  });

  it("echoes the request id and preserves body, status, and headers", async () => {
    const handler = withApiObservability("things.list", okHandler());
    const res = await handler(requestWithId("req-echo"), undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("req-echo");
    expect(res.headers.get("x-custom")).toBe("yes");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("echoes a generated id when the inbound header is absent or unsafe", async () => {
    const handler = withApiObservability("things.list", okHandler());
    const res = await handler(requestWithId("bad id;"), undefined);
    const echoed = res.headers.get(REQUEST_ID_HEADER);
    expect(echoed).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(echoed).not.toBe("bad id;");
    // The generated id is the one carried through the log events too.
    expect(emitted(mockLog, "request.end")[0]!.requestId).toBe(echoed);
  });

  it("returns the safe envelope for a known ApiError and logs expected_failure", async () => {
    const handler = withApiObservability("things.get", async () => {
      throw new ApiError("NOT_FOUND", 404, "Thing not found.");
    });
    const res = await handler(requestWithId("req-404"), undefined);

    expect(res.status).toBe(404);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("req-404");
    expect(await res.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Thing not found.",
        referenceId: "req-404",
      },
    });

    // logExpected adds level:"warn"/outcome:"expected_failure" internally —
    // the mock being called (rather than logOperational) is the classification.
    expect(mockLogExpected).toHaveBeenCalledTimes(1);
    expect(mockLogOperational).not.toHaveBeenCalled();
    expect(mockLogExpected.mock.calls[0]![0]).toMatchObject({
      event: "request.error",
      status: 404,
      apiErrorCode: "NOT_FOUND",
      requestId: "req-404",
    });
  });

  it("normalizes unknown errors to a generic 500 envelope without leaking internals", async () => {
    const handler = withApiObservability("things.create", async () => {
      throw new Error("PG password=hunter2 rejected for user admin");
    });
    const res = await handler(
      new Request("https://app.example.com/api"),
      undefined,
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("An unexpected error occurred.");
    expect(typeof body.error.referenceId).toBe("string");
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(JSON.stringify(body)).not.toContain("PG password");

    expect(mockLogOperational).toHaveBeenCalledTimes(1);
    expect(mockLogExpected).not.toHaveBeenCalled();
    const event = mockLogOperational.mock.calls[0]![0]!;
    expect(event).toMatchObject({
      event: "request.error",
      status: 500,
      apiErrorCode: "INTERNAL_ERROR",
      errorName: "Error",
    });
    // The log path never receives raw message/stack either.
    expect(JSON.stringify(event)).not.toContain("hunter2");
  });

  it("normalizes non-Error throws identically", async () => {
    const handler = withApiObservability("things.create", async () => {
      throw { totally: "unexpected" };
    });
    const res = await handler(
      new Request("https://app.example.com/api"),
      undefined,
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL_ERROR");
  });

  it("sets Retry-After when the error carries retryAfterSeconds", async () => {
    const handler = withApiObservability("things.list", async () => {
      throw new ApiError("RATE_LIMITED", 429, "Too many requests.", {
        retryAfterSeconds: 30,
      });
    });
    const res = await handler(
      new Request("https://app.example.com/api"),
      undefined,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect((await res.json()).error.code).toBe("RATE_LIMITED");
  });

  it("omits Retry-After for errors without retry metadata", async () => {
    const handler = withApiObservability("things.list", async () => {
      throw new ApiError("NOT_FOUND", 404, "Nope.");
    });
    const res = await handler(
      new Request("https://app.example.com/api"),
      undefined,
    );
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("rethrows NEXT_* control-flow digests untouched and unlogged", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    const handler = withApiObservability("things.get", async () => {
      throw redirect;
    });
    await expect(
      handler(new Request("https://app.example.com/api"), undefined),
    ).rejects.toBe(redirect);
    expect(mockLogExpected).not.toHaveBeenCalled();
    expect(mockLogOperational).not.toHaveBeenCalled();
  });

  it("never surfaces request headers, cookies, or bodies in logs", async () => {
    const req = new Request("https://app.example.com/api/things", {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token-value",
        cookie: "session=secret-cookie",
        "content-type": "application/json",
      },
      body: JSON.stringify({ secret: "body-content-marker" }),
    });
    const handler = withApiObservability("things.create", async () => {
      throw new ApiError("FORBIDDEN", 403, "Denied.");
    });
    await handler(req, undefined);

    const allLogged = JSON.stringify([
      ...mockLog.mock.calls,
      ...mockLogExpected.mock.calls,
      ...mockLogOperational.mock.calls,
    ]);
    expect(allLogged).not.toContain("secret-token-value");
    expect(allLogged).not.toContain("secret-cookie");
    expect(allLogged).not.toContain("body-content-marker");
  });

  it("client responses never contain stack traces or raw exception text", async () => {
    const handler = withApiObservability("things.create", async () => {
      throw new TypeError(
        "Cannot read properties of undefined (reading 'ssn')",
      );
    });
    const res = await handler(
      new Request("https://app.example.com/api"),
      undefined,
    );
    const text = await res.text();
    expect(text).not.toContain("TypeError");
    expect(text).not.toContain("ssn");
    expect(text).not.toContain("at ");
  });
});
