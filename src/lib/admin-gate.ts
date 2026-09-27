/**
 * TEMPORARY bootstrap gate for the entire `/admin` surface.
 *
 * The admin UI and its server actions are intentionally unauthenticated
 * until issue #6 lands real authentication and centralized
 * authorization. Until then the surface must never be reachable in a
 * deployed environment: every deployment (production AND previews) runs
 * a production build (`NODE_ENV=production`), so the surface is enabled
 * only under `next dev` and the test runner.
 *
 * Issue #6 replaces this module with real authz checks. It is one
 * import + one call per page/action precisely so the removal is
 * mechanical.
 *
 * Two enforcement points, deliberately:
 * - Pages call `adminSurfaceEnabled()` → `notFound()` (404 hides the
 *   surface entirely).
 * - Every server action calls `assertAdminEnabled()` — the hard gate.
 *   A crafted POST to an action endpoint cannot rely on the page-level
 *   notFound; the mutation itself fails closed.
 */
export function adminSurfaceEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

export class AdminDisabledError extends Error {
  constructor() {
    super(
      "Administration is disabled in this deployment until authentication lands.",
    );
    this.name = "AdminDisabledError";
  }
}

export function assertAdminEnabled(): void {
  if (!adminSurfaceEnabled()) {
    throw new AdminDisabledError();
  }
}
