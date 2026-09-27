import { describe, expect, it } from "vitest";

import {
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  sentryIngestOrigin,
  serializeCsp,
  type SecurityHeaderEnv,
} from "./headers";

const baseEnv: SecurityHeaderEnv = {
  isDevelopment: false,
  isVercelPreview: false,
  isHttpsDeployment: false,
};

function headerMap(env: SecurityHeaderEnv) {
  return new Map(buildSecurityHeaders(env).map((h) => [h.key, h.value]));
}

describe("buildContentSecurityPolicy", () => {
  it("omits feature origins when the feature is not configured", () => {
    const csp = buildContentSecurityPolicy(baseEnv);
    const serialized = serializeCsp(csp);
    expect(serialized).not.toContain("googletagmanager.com");
    expect(serialized).not.toContain("googleapis.com");
    expect(serialized).not.toContain("sentry.io");
    expect(serialized).not.toContain("vercel.live");
  });

  it("denies framing and locks down object/base/form directives", () => {
    const csp = buildContentSecurityPolicy(baseEnv);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["frame-src"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'self'"]);
    expect(csp["form-action"]).toEqual(["'self'"]);
  });

  it("adds GTM origins only when a container id is configured", () => {
    const csp = buildContentSecurityPolicy({ ...baseEnv, gtmId: "GTM-TEST" });
    const serialized = serializeCsp(csp);
    expect(serialized).toContain("https://www.googletagmanager.com");
    expect(serialized).toContain("https://*.google-analytics.com");
  });

  it("adds Firebase Auth origins only when an auth domain is configured", () => {
    const csp = buildContentSecurityPolicy({
      ...baseEnv,
      firebaseAuthDomain: "example.firebaseapp.com",
    });
    const serialized = serializeCsp(csp);
    expect(serialized).toContain("https://example.firebaseapp.com");
    expect(serialized).toContain("https://identitytoolkit.googleapis.com");
  });

  it("adds only the exact Sentry ingest origin from the DSN", () => {
    const csp = buildContentSecurityPolicy({
      ...baseEnv,
      sentryDsn: "https://abc@o123.ingest.us.sentry.io/456",
    });
    expect(csp["connect-src"]).toContain("https://o123.ingest.us.sentry.io");
    expect(serializeCsp(csp)).not.toContain("*.sentry.io");
  });

  it("allows the Vercel toolbar only on preview deployments", () => {
    const preview = buildContentSecurityPolicy({
      ...baseEnv,
      isVercelPreview: true,
    });
    expect(serializeCsp(preview)).toContain("https://vercel.live");
    expect(serializeCsp(buildContentSecurityPolicy(baseEnv))).not.toContain(
      "vercel.live",
    );
  });

  it("relaxes script-src in development for HMR and eval debugging", () => {
    const dev = buildContentSecurityPolicy({ ...baseEnv, isDevelopment: true });
    expect(dev["script-src"]).toContain("'unsafe-eval'");
    expect(dev["connect-src"]).toContain("ws:");
  });

  it("emits upgrade-insecure-requests only on HTTPS deployments", () => {
    const https = buildContentSecurityPolicy({
      ...baseEnv,
      isHttpsDeployment: true,
    });
    expect(https).toHaveProperty("upgrade-insecure-requests");
    expect(buildContentSecurityPolicy(baseEnv)).not.toHaveProperty(
      "upgrade-insecure-requests",
    );
  });
});

describe("serializeCsp", () => {
  it("serializes directives; empty-source directives emit the bare name", () => {
    expect(
      serializeCsp({
        "default-src": ["'self'"],
        "upgrade-insecure-requests": [],
      }),
    ).toBe("default-src 'self'; upgrade-insecure-requests");
  });
});

describe("buildSecurityHeaders", () => {
  it("includes the baseline header set", () => {
    const headers = headerMap(baseEnv);
    for (const key of [
      "Content-Security-Policy",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "X-Frame-Options",
      "Cross-Origin-Opener-Policy",
      "Cross-Origin-Resource-Policy",
      "Origin-Agent-Cluster",
      "X-Permitted-Cross-Domain-Policies",
      "Permissions-Policy",
    ]) {
      expect(headers.has(key), `missing ${key}`).toBe(true);
    }
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Cross-Origin-Opener-Policy")).toBe(
      "same-origin-allow-popups",
    );
  });

  it("emits HSTS only on HTTPS-capable deployments", () => {
    expect(headerMap(baseEnv).has("Strict-Transport-Security")).toBe(false);
    expect(
      headerMap({ ...baseEnv, isHttpsDeployment: true }).get(
        "Strict-Transport-Security",
      ),
    ).toBe("max-age=31536000");
  });
});

describe("sentryIngestOrigin", () => {
  it("extracts the origin from a valid https DSN", () => {
    expect(sentryIngestOrigin("https://key@o123.ingest.us.sentry.io/1")).toBe(
      "https://o123.ingest.us.sentry.io",
    );
  });

  it("returns undefined for absent, malformed, or non-https DSNs", () => {
    expect(sentryIngestOrigin(undefined)).toBeUndefined();
    expect(sentryIngestOrigin("not a url")).toBeUndefined();
    expect(
      sentryIngestOrigin("http://key@o123.ingest.sentry.io/1"),
    ).toBeUndefined();
  });
});
