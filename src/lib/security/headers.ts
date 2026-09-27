/**
 * Authoritative security-header configuration.
 *
 * One builder produces every security header the application emits;
 * `next.config.ts` applies it to all routes via `headers()`. Keep the
 * policy testable and explicit: each external allowance names the feature
 * that requires it. When a feature is not configured for a deployment
 * (e.g. no `NEXT_PUBLIC_GTM_ID`), its origins are omitted entirely rather
 * than allowed "just in case".
 *
 * Derived from the RISE Saba implementation, which is the canonical
 * feature-gated model across the audited repositories.
 *
 * Content Security Policy notes:
 *
 * - `'unsafe-inline'` in `script-src` is intentional and required without a
 *   nonce architecture: Next.js streams inline `self.__next_f` RSC payload
 *   scripts on every page. The alternative — per-request nonces via proxy —
 *   forces every route into dynamic rendering, disabling static
 *   optimization and CDN caching for a mostly-static site. A documented
 *   `'unsafe-inline'` + host allowlist is the honest trade-off.
 * - `'unsafe-inline'` in `style-src` is required by React `style={{}}`
 *   props.
 * - `frame-ancestors 'none'` is the modern anti-framing control;
 *   `X-Frame-Options: DENY` is kept for pre-CSP2 clients. If the app ever
 *   needs Firebase Auth `signInWithPopup`, keep
 *   `Cross-Origin-Opener-Policy: same-origin-allow-popups` — `same-origin`
 *   would sever the popup's opener relationship and break sign-in.
 * - Cross-Origin-Embedder-Policy is deliberately NOT set: `require-corp`
 *   would force CORP annotations onto third-party scripts that do not send
 *   them.
 */

export interface SecurityHeaderEnv {
  /** `next dev` / NODE_ENV=development — relaxes CSP for HMR + eval debugging. */
  isDevelopment: boolean;
  /** Vercel preview deployment — allows the Vercel toolbar (`vercel.live`). */
  isVercelPreview: boolean;
  /**
   * Deployment is guaranteed HTTPS-capable (Vercel production or preview).
   * Drives HSTS and `upgrade-insecure-requests`. Deliberately NOT inferred
   * from `NODE_ENV=production`: a self-hosted `npm start` or HTTP staging
   * environment must not receive HSTS it cannot honor — a cached HSTS
   * policy on a plain-HTTP host makes the site unreachable until expiry.
   */
  isHttpsDeployment: boolean;
  /** `NEXT_PUBLIC_GTM_ID` — enables GTM/GA4 origins (load post-consent). */
  gtmId?: string;
  /**
   * `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` — enables Firebase Auth origins.
   * Set only when the app actually uses Firebase Authentication.
   */
  firebaseAuthDomain?: string;
  /**
   * `NEXT_PUBLIC_SENTRY_DSN` — enables the single Sentry ingest origin in
   * `connect-src` so browser error reports can be delivered. Omitted
   * entirely when Sentry is not configured.
   */
  sentryDsn?: string;
}

export interface SecurityHeader {
  key: string;
  value: string;
}

function envFromProcess(): SecurityHeaderEnv {
  return {
    isDevelopment: process.env.NODE_ENV === "development",
    isVercelPreview: process.env.VERCEL_ENV === "preview",
    // Vercel serves both production and preview deployments HTTPS-only, so
    // both qualify. Anything else (local `npm start`, self-hosted HTTP
    // staging) is not assumed HTTPS-capable; a future non-Vercel HTTPS
    // deployment can pass `isHttpsDeployment` explicitly.
    isHttpsDeployment:
      process.env.VERCEL_ENV === "production" ||
      process.env.VERCEL_ENV === "preview",
    gtmId: process.env.NEXT_PUBLIC_GTM_ID,
    firebaseAuthDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  };
}

const GTM_SCRIPT_ORIGINS = ["https://www.googletagmanager.com"];

// Scoped host wildcards are intentional: Google's tag-platform CSP guidance
// requires `*.google-analytics.com`/`*.analytics.google.com` (GA4 collection
// endpoints vary by region) and `*.g.doubleclick.net` (GA4 Google-signals).
// Pinning exact hosts breaks silently when Google rotates endpoints.
const GTM_IMAGE_ORIGINS = [
  "https://*.google-analytics.com",
  "https://*.g.doubleclick.net",
  "https://www.googletagmanager.com",
];

const GTM_CONNECT_ORIGINS = [
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
  "https://*.g.doubleclick.net",
  "https://www.googletagmanager.com",
];

// GTM preview/debug tooling frames googletagmanager.com.
const GTM_FRAME_ORIGINS = ["https://www.googletagmanager.com"];

// firebase/auth's signInWithPopup pulls the Google API client loader into
// the page when opening the auth popup.
const FIREBASE_SCRIPT_ORIGINS = ["https://apis.google.com"];

const FIREBASE_CONNECT_ORIGINS = [
  "https://identitytoolkit.googleapis.com",
  "https://securetoken.googleapis.com",
  "https://firebaseinstallations.googleapis.com",
];

const VERCEL_PREVIEW_ORIGIN = "https://vercel.live";

/**
 * Extract the ingest origin ("https://o123.ingest.us.sentry.io") from a DSN
 * for the CSP connect-src allowlist. Returns undefined for a malformed or
 * absent DSN — the caller simply adds no origin.
 */
export function sentryIngestOrigin(
  dsn: string | undefined,
): string | undefined {
  if (!dsn) return undefined;
  try {
    const { origin, protocol } = new URL(dsn);
    return protocol === "https:" ? origin : undefined;
  } catch {
    return undefined;
  }
}

export function buildContentSecurityPolicy(
  env: SecurityHeaderEnv,
): Record<string, string[]> {
  const scriptSrc = ["'self'", "'unsafe-inline'"];
  const styleSrc = ["'self'", "'unsafe-inline'"];
  const imgSrc = ["'self'", "data:"];
  const connectSrc = ["'self'"];
  const frameSrc: string[] = [];

  if (env.gtmId) {
    scriptSrc.push(...GTM_SCRIPT_ORIGINS);
    imgSrc.push(...GTM_IMAGE_ORIGINS);
    connectSrc.push(...GTM_CONNECT_ORIGINS);
    frameSrc.push(...GTM_FRAME_ORIGINS);
  }

  if (env.firebaseAuthDomain) {
    const authOrigin = `https://${env.firebaseAuthDomain}`;
    scriptSrc.push(...FIREBASE_SCRIPT_ORIGINS);
    connectSrc.push(...FIREBASE_CONNECT_ORIGINS, authOrigin);
    frameSrc.push(authOrigin);
  }

  // The browser SDK POSTs error envelopes directly to the ingest host baked
  // into the DSN. Only that exact origin is allowed, and only when Sentry
  // is configured — no wildcard, no tunnel route.
  const sentryOrigin = sentryIngestOrigin(env.sentryDsn);
  if (sentryOrigin) {
    connectSrc.push(sentryOrigin);
  }

  if (env.isVercelPreview) {
    scriptSrc.push(VERCEL_PREVIEW_ORIGIN);
    connectSrc.push(VERCEL_PREVIEW_ORIGIN);
    frameSrc.push(VERCEL_PREVIEW_ORIGIN);
  }

  if (env.isDevelopment) {
    // React uses eval for server-error stack reconstruction in dev; Next
    // HMR also uses a same-origin WebSocket (kept explicit for older
    // engines).
    scriptSrc.push("'unsafe-eval'");
    connectSrc.push("ws:");
  }

  return {
    "default-src": ["'self'"],
    "script-src": scriptSrc,
    "style-src": styleSrc,
    "img-src": imgSrc,
    "font-src": ["'self'"],
    "connect-src": connectSrc,
    "frame-src": frameSrc.length > 0 ? frameSrc : ["'none'"],
    "frame-ancestors": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "worker-src": ["'self'"],
    "manifest-src": ["'self'"],
    "media-src": ["'self'"],
    ...(env.isHttpsDeployment ? { "upgrade-insecure-requests": [] } : {}),
  };
}

export function serializeCsp(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([name, sources]) =>
      sources.length > 0 ? `${name} ${sources.join(" ")}` : name,
    )
    .join("; ");
}

const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "camera=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "payment=()",
  "usb=()",
].join(", ");

/**
 * Build the complete set of security response headers.
 *
 * This is the single source of truth for browser security headers. Next.js
 * applies it through `async headers()` in next.config.ts. API routes and
 * other code must not set duplicate or conflicting headers — extend this
 * builder with a documented exception instead.
 */
export function buildSecurityHeaders(
  env: SecurityHeaderEnv = envFromProcess(),
): SecurityHeader[] {
  const headers: SecurityHeader[] = [
    {
      key: "Content-Security-Policy",
      value: serializeCsp(buildContentSecurityPolicy(env)),
    },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    {
      key: "Cross-Origin-Opener-Policy",
      value: "same-origin-allow-popups",
    },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    { key: "Origin-Agent-Cluster", value: "?1" },
    { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
  ];

  if (env.isHttpsDeployment) {
    // Conservative policy: 1-year max-age, no includeSubDomains (a future
    // non-HTTPS subdomain would otherwise break), no preload opt-in.
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=31536000",
    });
  }

  return headers;
}
