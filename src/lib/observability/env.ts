/**
 * Sentry environment resolution — pure, so the enable/disable contract
 * is unit-testable without the SDK.
 *
 * Provenance: RISE Saba (the most mature of the audited Sentry setups).
 * The contract it encodes:
 *
 * - No DSN → completely disabled. No init calls, no client bundle, no
 *   CSP origin. "Off" is the default, not a misconfiguration.
 * - Tests are always disabled regardless of DSN.
 * - `environment` prefers the deployment environment (VERCEL_ENV:
 *   production | preview | development) over NODE_ENV so preview
 *   events never contaminate the production project view.
 * - `release` is the git SHA when the platform provides one.
 */

export interface SentryEnvInput {
  SENTRY_DSN?: string | undefined;
  NEXT_PUBLIC_SENTRY_DSN?: string | undefined;
  VERCEL_ENV?: string | undefined;
  VERCEL_GIT_COMMIT_SHA?: string | undefined;
  NODE_ENV?: string | undefined;
}

export interface ResolvedSentryConfig {
  enabled: boolean;
  dsn?: string;
  environment: string;
  release?: string;
}

/**
 * @param serverSide — the server reads SENTRY_DSN; the browser can only
 *   see NEXT_PUBLIC_SENTRY_DSN. Keeping them separate means server-only
 *   error reporting works without shipping the DSN in the client bundle.
 */
export function resolveSentryConfig(
  env: SentryEnvInput,
  serverSide: boolean,
): ResolvedSentryConfig {
  const dsn = serverSide ? env.SENTRY_DSN : env.NEXT_PUBLIC_SENTRY_DSN;
  const environment = env.VERCEL_ENV ?? env.NODE_ENV ?? "development";
  const release = env.VERCEL_GIT_COMMIT_SHA || undefined;

  if (env.NODE_ENV === "test" || !dsn) {
    return { enabled: false, environment, release };
  }
  return { enabled: true, dsn, environment, release };
}
