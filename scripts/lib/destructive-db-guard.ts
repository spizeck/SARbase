/**
 * Destructive-command database target guard (issue #88).
 *
 * `prisma migrate dev`, `prisma migrate reset`, and `prisma db push`
 * auto-load `.env` and will happily wipe whatever `DATABASE_URL` /
 * `DATABASE_URL_UNPOOLED` points at — a remote dev branch, the shared
 * `testing` baseline, or worse. Scripts (seed, verify) already bind
 * targets positively via db-target.ts; this module applies the same
 * policy to the Prisma CLI path so a raw command can never be aimed at
 * a non-disposable database by accident.
 *
 * Policy:
 * - Loopback hosts proceed freely — local docker postgres is
 *   definitionally disposable.
 * - `APP_PRODUCTION_DB_HOST` and `APP_TESTING_DB_HOST` are refused under
 *   EVERY invocation — destructive commands have no legitimate business
 *   on either, confirmation or not.
 * - Any other remote host requires an explicit positive-identity
 *   confirmation whose value must equal the resolved hostname exactly —
 *   never a name, a glob, or "yes".
 *
 * Known limitation: a loopback target that tunnels to a remote
 * database (SSH port-forward, cloud proxy socket) is indistinguishable
 * from a disposable local instance at the URL level. Operators
 * running tunnels are responsible for what the tunnel reaches.
 */

import { normalizeDatabaseEndpoint } from "../../src/lib/env";
import {
  describeDatabaseTarget,
  LOOPBACK_HOSTS,
  parseDatabaseTargetUrl,
} from "./db-target";

export class DestructiveTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestructiveTargetError";
  }
}

export interface DestructiveGuardEnv {
  /** Non-secret production hostname — refused unconditionally. */
  productionHost?: string;
  /** Non-secret testing-baseline hostname — refused unconditionally. */
  testingHost?: string;
  /** Positive-identity confirmation for other remote targets. */
  confirmHost?: string;
}

function normalizeHost(host: string | undefined): string | null {
  const trimmed = host?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * Protected-host markers may be configured as bare hostnames,
 * host:port pairs, or full connection URLs, and a Neon marker can name
 * either the pooled or the unpooled endpoint of the same branch.
 * Resolve every accepted marker form to the canonical hostname the
 * target is normalized to — otherwise `-pooler` aliases, trailing DNS
 * dots, or decoration silently bypass the unconditional refusal.
 */
function normalizeProtectedHost(marker: string | undefined): string | null {
  const trimmed = marker?.trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  try {
    const parsed = new URL(
      trimmed.includes("://") ? trimmed : `postgres://${trimmed}`,
    );
    if (parsed.hostname) candidate = parsed.hostname;
  } catch {
    // Unparseable marker — compare it as written; it simply never
    // matches a real hostname, which fails closed.
  }
  return normalizeDatabaseEndpoint(candidate);
}

/**
 * Assert a destructive database command may run against `url`.
 * Throws DestructiveTargetError with an actionable message on refusal.
 */
export function assertDestructiveTarget(
  url: string,
  env: DestructiveGuardEnv = {},
  commandDescription = "a destructive database command",
): void {
  const { hostname } = parseDatabaseTargetUrl(url);
  const target = describeDatabaseTarget(url);
  const lower = hostname.toLowerCase();
  // Pooled/unpooled endpoint spelling and trailing DNS dots are the
  // same host — canonicalize before the protected comparisons.
  const resolved = normalizeDatabaseEndpoint(hostname);

  if (LOOPBACK_HOSTS.has(resolved)) return;

  const productionHost = normalizeProtectedHost(env.productionHost);
  if (productionHost && resolved === productionHost) {
    throw new DestructiveTargetError(
      `${commandDescription} is aimed at the PRODUCTION database ` +
        `(${target}). This is refused unconditionally — production ` +
        `migrations run only through the Vercel build.`,
    );
  }
  const testingHost = normalizeProtectedHost(env.testingHost);
  if (testingHost && resolved === testingHost) {
    throw new DestructiveTargetError(
      `${commandDescription} is aimed at the permanent testing baseline ` +
        `(${target}). Testing data is rebuilt by migration replay and ` +
        `reseed — never by destructive commands.`,
    );
  }

  const confirmHost = normalizeHost(env.confirmHost);
  if (!confirmHost) {
    throw new DestructiveTargetError(
      `${commandDescription} is aimed at a remote database (${target}). ` +
        `Refusing without positive identity confirmation — re-run with ` +
        `the confirmation input set to exactly "${hostname}" if this ` +
        `disposable target is intended.`,
    );
  }
  if (confirmHost !== lower) {
    throw new DestructiveTargetError(
      `${commandDescription} is aimed at ${target}, but the confirmation ` +
        `value names "${confirmHost}". The confirmation must equal the ` +
        `resolved hostname exactly.`,
    );
  }
}
