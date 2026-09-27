/**
 * Scope/tag construction for Sentry events — pure.
 *
 * Tags are the queryable surface in Sentry; keep them to deployment
 * facts. Runtime identifiers (request ids, entity ids) go in `contexts`,
 * never `user`.
 */

export interface ScopeEnv {
  VERCEL_ENV?: string | undefined;
  VERCEL_GIT_COMMIT_SHA?: string | undefined;
  VERCEL_REGION?: string | undefined;
  NODE_ENV?: string | undefined;
}

export function buildScopeTags(env: ScopeEnv): Record<string, string> {
  const tags: Record<string, string> = {
    environment: env.VERCEL_ENV ?? env.NODE_ENV ?? "development",
  };
  if (env.VERCEL_GIT_COMMIT_SHA) {
    tags.commit = env.VERCEL_GIT_COMMIT_SHA.slice(0, 12);
  }
  if (env.VERCEL_REGION) {
    tags.region = env.VERCEL_REGION;
  }
  return tags;
}
