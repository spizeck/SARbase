/**
 * Structured operational logging.
 *
 * Every line is a single JSON object written to stdout/stderr. On Vercel
 * this lands in the per-invocation function logs with deployment and
 * request context attached by the platform — there is intentionally no
 * external telemetry SDK in the base template.
 *
 * Derived from the RISE Saba implementation (canonical event/outcome
 * model + redaction policy across the audited repositories).
 *
 * Conventions:
 *
 * - `event`     — snake_case verb describing what happened.
 * - `level`     — info | warn | error. Controls the console channel.
 * - `outcome`   — success | expected_failure | operational_failure |
 *                 unexpected_failure. Derived from `level` when not given;
 *                 pass it explicitly on warn-level events, which are
 *                 ambiguous. Alerting keys on outcome, not level.
 * - `actorId`   — internal user/admin id. Never an email or external UID.
 * - `entityId`  — internal record id.
 * - `requestId` — platform request id (x-vercel-id / x-request-id).
 * - `errorName`/`errorCode`/`errorDigest` — come from summarizeError();
 *                 error messages, stacks, and provider payloads are never
 *                 logged because they can echo PII and secrets.
 *
 * Fields that could carry message content, personal data, credentials, or
 * raw request/provider payloads are stripped before output (see
 * FORBIDDEN_FIELDS), and string values are scanned for email addresses,
 * tokens, keys, and connection strings that slipped in under a
 * safe-looking key. Dropped fields are reported via `redactedFields` so a
 * maintainer can see that redaction happened.
 *
 * These logs are operational diagnostics, not an audit trail. Durable
 * business/security history belongs in a database-backed audit record —
 * do not replace one with the other.
 */

export type LogLevel = "info" | "warn" | "error";

export type LogOutcome =
  "success" | "expected_failure" | "operational_failure" | "unexpected_failure";

export interface LogEvent {
  event: string;
  level?: LogLevel;
  outcome?: LogOutcome;
  subsystem?: string;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  requestId?: string;
  errorName?: string;
  errorCode?: string;
  errorDigest?: string;
  [key: string]: unknown;
}

/**
 * Field names that are never allowed into a log line. Matching is
 * case-insensitive and applied recursively through nested objects. The
 * list covers three categories:
 *
 * - content bodies (message, body, title, subject, ...),
 * - personal data (email, phone, names, addresses, IPs),
 * - credentials and raw payloads (tokens, cookies, headers, secrets,
 *   connection strings, error objects, whole entity records).
 *
 * The goal is not that this list is complete — unknown data fails safe
 * through the value patterns below — but that obvious mistakes are caught.
 */
const FORBIDDEN_FIELDS = new Set([
  // message/submission content
  "message",
  "body",
  "bodymarkdown",
  "html",
  "text",
  "description",
  "content",
  "subject",
  "title",
  "excerpt",
  "previewtext",
  "comment",
  "notes",
  // personal data
  "email",
  "actoremail",
  "submitteremail",
  "recipientemail",
  "replyto",
  "to",
  "recipients",
  "phone",
  "name",
  "fullname",
  "displayname",
  "firstname",
  "lastname",
  "submittername",
  "address",
  "ip",
  "ipaddress",
  "xforwardedfor",
  "actoruid",
  "firebaseuid",
  // credentials, tokens, request material
  "token",
  "idtoken",
  "accesstoken",
  "refreshtoken",
  "confirmationtoken",
  "session",
  "sessionid",
  "sessioncookie",
  "csrftoken",
  "cookie",
  "cookies",
  "authorization",
  "password",
  "secret",
  "apikey",
  "api_key",
  "privatekey",
  "private_key",
  "credentials",
  "connectionstring",
  "databaseurl",
  "database_url",
  "headers",
  "requestbody",
  "rawbody",
  "payload",
  "input",
  "data",
  // exception objects — must go through summarizeError()
  "error",
  "err",
  "exception",
  "cause",
  "stack",
  "stacktrace",
  // whole entity records
  "entity",
  "record",
  "row",
  "user",
  "profile",
  "result",
]);

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_PATTERN =
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const CONNECTION_URL_PATTERN =
  /(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/[^\s"']+/gi;
// Long unbroken token-like strings. Typical internal ids (cuid/uuid) stay
// below this threshold; API keys, session cookies, and random bearer
// tokens do not.
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_=-]{32,}\b/g;

/**
 * Redact emails, JWTs, private keys, connection URLs, and token-length
 * strings from a free-text value. Shared with the Sentry event scrubber
 * when the observability module is installed so both observability layers
 * apply one redaction policy.
 */
export function redactString(value: string, keyIsIdentifier: boolean): string {
  const redacted = value
    .replace(PRIVATE_KEY_PATTERN, "[redacted-key]")
    .replace(CONNECTION_URL_PATTERN, "[redacted-url]")
    .replace(JWT_PATTERN, "[redacted-token]")
    .replace(EMAIL_PATTERN, "[redacted-email]");
  // Keys ending in "id"/"hash" hold deliberate identifiers — cuids, UUID
  // provider message ids, SHA-256 digests — which the long-token pattern
  // would otherwise eat. The other patterns still run: an email or JWT
  // under an "…Id" key is still redacted.
  return keyIsIdentifier
    ? redacted
    : redacted.replace(LONG_TOKEN_PATTERN, "[redacted-token]");
}

// Error codes are safe to log only when they are machine codes, not prose:
// Prisma "P2002", Firebase "auth/network-request-failed", Next digests. A
// bounded token charset keeps sentences (and anything they might embed) out.
const SAFE_CODE_PATTERN = /^[A-Za-z0-9_./-]{1,48}$/;

// Error names get the same treatment: safe only when they look like a
// class identifier — "TypeError", "PrismaClientKnownRequestError". A
// provider error can carry arbitrary text (occasionally prose echoing
// request data) in .name; the bounded identifier charset keeps that — and
// anything embedded, like an email address — out. Rejected names degrade
// to "Error"; the raw value is never logged.
const SAFE_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/**
 * Reduce an unknown thrown value to the only fields safe to log: the error
 * class name, a Next.js digest, and a machine error code. Messages and
 * stacks are deliberately excluded — provider errors can echo recipient
 * addresses, request bodies, or SQL into the message text.
 */
export function summarizeError(error: unknown): {
  errorName: string;
  errorDigest?: string;
  errorCode?: string;
} {
  if (!(error instanceof Error)) {
    return { errorName: "non_error_throw" };
  }
  const summary: {
    errorName: string;
    errorDigest?: string;
    errorCode?: string;
  } = {
    errorName:
      typeof error.name === "string" && SAFE_NAME_PATTERN.test(error.name)
        ? error.name
        : "Error",
  };
  const candidate = error as { digest?: unknown; code?: unknown };
  if (
    typeof candidate.digest === "string" &&
    SAFE_CODE_PATTERN.test(candidate.digest)
  ) {
    summary.errorDigest = candidate.digest;
  }
  if (
    typeof candidate.code === "string" &&
    SAFE_CODE_PATTERN.test(candidate.code)
  ) {
    summary.errorCode = candidate.code;
  }
  return summary;
}

function deriveOutcome(level: LogLevel): LogOutcome {
  if (level === "error") return "operational_failure";
  if (level === "warn") return "expected_failure";
  return "success";
}

/**
 * Serialize an event to its final single-line JSON form, applying the
 * redaction policy. Pure — exported so tests can assert on the emitted
 * line without touching the console (log() itself is silent under
 * NODE_ENV=test).
 */
export function formatLogEvent(event: LogEvent): string {
  const level = event.level ?? "info";
  const full = {
    ...event,
    level,
    outcome: event.outcome ?? deriveOutcome(level),
    ts: new Date().toISOString(),
  };

  const redactedFields: string[] = [];
  const seen = new Set<string>();
  const replacer = (key: string, value: unknown): unknown => {
    const lowered = key.toLowerCase();
    if (FORBIDDEN_FIELDS.has(lowered)) {
      if (!seen.has(lowered)) {
        seen.add(lowered);
        redactedFields.push(key);
      }
      return undefined;
    }
    if (value instanceof Error) {
      return summarizeError(value);
    }
    if (typeof value === "string") {
      return redactString(
        value,
        lowered.endsWith("id") || lowered.endsWith("hash"),
      );
    }
    return value;
  };

  try {
    // The replacer populates redactedFields while serializing.
    const line = JSON.stringify(full, replacer);
    if (redactedFields.length === 0) {
      return line;
    }
    return JSON.stringify({ ...full, redactedFields }, replacer);
  } catch {
    // Unserializable values (circular refs, BigInt) must not break the
    // code path that is trying to log — emit a minimal line instead.
    return JSON.stringify({
      event: full.event,
      level: full.level,
      outcome: full.outcome,
      serializationFailed: true,
      ts: full.ts,
    });
  }
}

export function log(event: LogEvent) {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  const line = formatLogEvent(event);
  const level = event.level ?? "info";

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * A handled, routine failure: validation, conflicts, denials, rate limits,
 * expired tokens. Visible in logs, never page-worthy. Defaults to warn;
 * pass level:"info" for high-frequency routine cases.
 */
export function logExpected(event: LogEvent) {
  log({ level: "warn", outcome: "expected_failure", ...event });
}

/**
 * A failure in infrastructure or a dependency that needs attention:
 * database, provider API, missing production config.
 */
export function logOperational(event: LogEvent) {
  log({ level: "error", outcome: "operational_failure", ...event });
}

/**
 * An uncaught application failure. In practice these arrive via
 * instrumentation.ts onRequestError rather than being logged by hand.
 */
export function logUnexpected(event: LogEvent) {
  log({ level: "error", outcome: "unexpected_failure", ...event });
}

/**
 * Narrow view of the parameters Next.js passes to onRequestError in
 * instrumentation.ts — kept structural so this module stays free of
 * next types and unit-testable.
 */
export interface RequestErrorRequest {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface RequestErrorContext {
  routerKind?: string;
  routePath?: string;
  routeType?: string;
  renderSource?: string;
}

/**
 * Build the log event for an error captured by Next's onRequestError hook.
 *
 * - NEXT_* digests are control flow (redirect/notFound), not errors.
 * - The query string is stripped — it can carry bearer tokens — and
 *   request headers are never logged except the platform's own
 *   x-vercel-id correlation id.
 * - Applications with an authorization-error class should reclassify
 *   those here as `request_denied` expected failures (see the
 *   observability module for the fuller funnel).
 */
export function buildRequestErrorEvent(
  error: unknown,
  request: RequestErrorRequest,
  context: RequestErrorContext,
): LogEvent | null {
  // NEXT_* digests are control flow (redirect/notFound), not errors. Check
  // the raw digest — its ";"-separated format intentionally exceeds the
  // machine-code charset summarizeError accepts.
  const rawDigest = (error as { digest?: unknown } | null)?.digest;
  if (typeof rawDigest === "string" && rawDigest.startsWith("NEXT_")) {
    return null;
  }
  const summary = summarizeError(error);

  const requestIdHeader = request.headers["x-vercel-id"];
  const requestId =
    typeof requestIdHeader === "string" ? requestIdHeader : undefined;

  return {
    event: "unhandled_request_error",
    level: "error",
    outcome: "unexpected_failure",
    subsystem: "http",
    method: request.method,
    // Query strings can carry tokens — log the pathname only; routePath
    // carries the pattern for grouping.
    path: (request.path ?? "").split("?")[0],
    routePath: context.routePath,
    routeType: context.routeType,
    routerKind: context.routerKind,
    requestId,
    ...summary,
  };
}
