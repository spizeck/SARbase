import { describe, expect, it } from "vitest";

import { resolveSentryConfig } from "./env";

describe("resolveSentryConfig", () => {
  it("is disabled with no DSN — off is the default", () => {
    expect(resolveSentryConfig({}, true).enabled).toBe(false);
    expect(resolveSentryConfig({}, false).enabled).toBe(false);
  });

  it("is disabled under tests even with a DSN", () => {
    const env = {
      SENTRY_DSN: "https://k@o1.ingest.sentry.io/2",
      NODE_ENV: "test",
    };
    expect(resolveSentryConfig(env, true).enabled).toBe(false);
  });

  it("server reads SENTRY_DSN; client reads NEXT_PUBLIC_SENTRY_DSN", () => {
    const env = {
      SENTRY_DSN: "https://k@o1.ingest.sentry.io/server",
      NEXT_PUBLIC_SENTRY_DSN: "https://k@o1.ingest.sentry.io/client",
      NODE_ENV: "production",
    };
    expect(resolveSentryConfig(env, true).dsn).toContain("/server");
    expect(resolveSentryConfig(env, false).dsn).toContain("/client");
  });

  it("a server-only DSN does not enable the client", () => {
    const env = {
      SENTRY_DSN: "https://k@o1.ingest.sentry.io/2",
      NODE_ENV: "production",
    };
    expect(resolveSentryConfig(env, false).enabled).toBe(false);
  });

  it("VERCEL_ENV wins over NODE_ENV for the environment tag", () => {
    const env = {
      NEXT_PUBLIC_SENTRY_DSN: "https://k@o1.ingest.sentry.io/2",
      VERCEL_ENV: "preview",
      NODE_ENV: "production",
    };
    expect(resolveSentryConfig(env, false).environment).toBe("preview");
  });

  it("uses the git SHA as release when present", () => {
    const env = {
      SENTRY_DSN: "https://k@o1.ingest.sentry.io/2",
      NODE_ENV: "production",
      VERCEL_GIT_COMMIT_SHA: "abc123",
    };
    expect(resolveSentryConfig(env, true).release).toBe("abc123");
  });
});
