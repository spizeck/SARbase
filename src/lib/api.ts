/**
 * API route observability + safe error handling.
 *
 * Provenance: generalized from Sea Saba's `lib/logging/api-observability.ts`
 * and `lib/errors/errors.ts` — the "thin `ApiError`/`normalizeError` pair +
 * `x-request-id` sanitize-and-echo convention" recorded as the canonical
 * decision in `docs/extraction-report.md` §6. Adapted to this template's
 * event-model logger: no getLogger/AsyncLocalStorage context — `requestId`
 * is carried as an explicit field on each event, so the existing redaction
 * policy in `logging.ts` applies unchanged.
 *
 * Contract:
 *
 * - Wrap every App Router route handler in `withApiObservability(name, fn)`.
 *   `name` is the route's logical name (`"health"`, `"auth.session"`) — it
 *   lands in the `route` log field for grouping.
 * - Throw `ApiError` for expected failures. Its `message` is sent to the
 *   client verbatim — never put internals, secrets, or raw provider text
 *   in it. Unknown throws are normalized to a generic 500 envelope; raw
 *   exception text never reaches the client.
 * - Responses always carry `x-request-id` (the incoming value when it
 *   passes sanitization, otherwise a generated UUID). The same id is the
 *   error envelope's `referenceId` and the `requestId` log field, so a
 *   client-reported failure can be correlated to one log stream.
 */

import { log, logExpected, logOperational, summarizeError } from "./logging";

export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Client-supplied request ids are untrusted input: they are echoed back on
 * the response and written to every log line for the request, so anything
 * outside a bounded token charset (or overlong) is dropped rather than
 * reflected. Invalid/missing ids are replaced with a generated UUID.
 */
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function sanitizeRequestId(
  value: string | null | undefined,
): string | undefined {
  if (!value || !REQUEST_ID_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

/** The request id for this request: sanitized inbound header or a new UUID. */
export function resolveRequestId(request: Request): string {
  return (
    sanitizeRequestId(request.headers.get(REQUEST_ID_HEADER)) ??
    crypto.randomUUID()
  );
}

export interface ApiErrorOptions {
  /** Underlying cause — logged only through summarizeError(), never returned. */
  cause?: unknown;
  /**
   * Seconds the client should wait before retrying. When set, the wrapper
   * emits a `Retry-After` header. Clamped to a non-negative integer.
   */
  retryAfterSeconds?: number;
}

/**
 * A thin error type for expected API failures — deliberately not a domain
 * hierarchy. `code` is the stable machine-readable identifier clients can
 * branch on; `message` is public by contract; `status` is the HTTP status.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(
    code: string,
    status: number,
    message: string,
    options: ApiErrorOptions = {},
  ) {
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(
        `ApiError status must be an HTTP error status, got ${status}`,
      );
    }
    super(message, { cause: options.cause });
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = Math.max(
        0,
        Math.floor(options.retryAfterSeconds),
      );
    }
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

const INTERNAL_ERROR_MESSAGE = "An unexpected error occurred.";

/**
 * Convert any thrown value into an ApiError. Known ApiErrors pass through
 * untouched; everything else — raw Errors, non-Error throws — collapses to a
 * generic 500 whose message cannot leak internals. The original value is kept
 * as `cause` for server-side summarization only.
 */
export function normalizeError(error: unknown): ApiError {
  if (isApiError(error)) {
    return error;
  }
  return new ApiError("INTERNAL_ERROR", 500, INTERNAL_ERROR_MESSAGE, {
    cause: error,
  });
}

/** Stable client-facing error shape. `referenceId` correlates to logs. */
export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    referenceId: string;
  };
}

export function buildErrorEnvelope(
  error: ApiError,
  referenceId: string,
): ApiErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: error.message,
      referenceId,
    },
  };
}

/**
 * NEXT_* digests are framework control flow (redirect(), notFound(), thrown
 * Responses) — rethrown untouched, never treated as request errors. Matches
 * the convention in `buildRequestErrorEvent` in logging.ts.
 */
function isFrameworkControlFlow(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_");
}

/**
 * Rebuild the response with `x-request-id` set. Some Response objects
 * (redirects, immutable-header responses) cannot be mutated in place, so we
 * copy rather than `response.headers.set(...)`.
 */
function withRequestIdHeader(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Pathname only — the query string can carry bearer tokens and is never
 * logged (same rule as `buildRequestErrorEvent`). Request bodies, cookies,
 * and headers other than the request-id are never read here at all.
 */
function safePathname(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "";
  }
}

/**
 * Wrap an App Router route handler with request-id propagation, lifecycle
 * logging, and safe error normalization.
 *
 *   export const GET = withApiObservability("items.list", async (request) => {
 *     ...
 *     throw new ApiError("NOT_FOUND", 404, "Item not found.");
 *   });
 *
 * Emits `request.start`, `request.end` (status + durationMs), and
 * `request.error` on failure — `expected_failure`/warn for 4xx ApiErrors,
 * `operational_failure`/error for 5xx and unknown throws. The generic
 * `Request`/`Response` types keep this module free of `next` imports;
 * handlers typed for `NextRequest` still compose via the generic parameter.
 */
export function withApiObservability<R extends Request = Request, C = unknown>(
  name: string,
  handler: (request: R, context: C) => Response | Promise<Response>,
): (request: R, context: C) => Promise<Response> {
  return async (request, context) => {
    const requestId = resolveRequestId(request);
    const method = request.method;
    const path = safePathname(request);
    const startTime = Date.now();

    log({
      event: "request.start",
      subsystem: "api",
      route: name,
      method,
      path,
      requestId,
    });

    try {
      const response = await handler(request, context);
      log({
        event: "request.end",
        subsystem: "api",
        route: name,
        method,
        path,
        requestId,
        status: response.status,
        durationMs: Date.now() - startTime,
      });
      return withRequestIdHeader(response, requestId);
    } catch (error) {
      if (isFrameworkControlFlow(error)) {
        throw error;
      }

      const apiError = normalizeError(error);
      const event = {
        event: "request.error",
        subsystem: "api",
        route: name,
        method,
        path,
        requestId,
        status: apiError.status,
        durationMs: Date.now() - startTime,
        apiErrorCode: apiError.code,
        // Summarize the underlying cause, not the ApiError wrapper — the
        // summary yields only errorName/errorDigest/errorCode, never
        // message or stack (those can echo PII/secrets).
        ...summarizeError(apiError.cause ?? error),
      };
      if (apiError.status >= 500) {
        logOperational(event);
      } else {
        logExpected(event);
      }

      const headers = new Headers({
        "content-type": "application/json",
        [REQUEST_ID_HEADER]: requestId,
      });
      if (apiError.retryAfterSeconds !== undefined) {
        headers.set("Retry-After", String(apiError.retryAfterSeconds));
      }
      return new Response(
        JSON.stringify(buildErrorEnvelope(apiError, requestId)),
        { status: apiError.status, headers },
      );
    }
  };
}
