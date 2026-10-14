/** Storage-state file the hosted global setup writes and the authenticated project loads. */
export const SMOKE_AUTH_STATE = ".auth/smoke-user.json";

/**
 * Storage-state file carrying only the deployment-scoped bypass cookie
 * (`_vercel_jwt`). Loaded by every hosted project so both browser pages
 * and API request contexts pass Deployment Protection — without ever
 * attaching the bypass secret as a context-wide header, which would
 * also be sent to third-party origins (e.g. the Firebase API).
 */
export const SMOKE_BYPASS_STATE = ".auth/bypass.json";
