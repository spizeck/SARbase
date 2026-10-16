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
 */

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

  if (LOOPBACK_HOSTS.has(lower)) return;

  const productionHost = normalizeHost(env.productionHost);
  if (productionHost && lower === productionHost) {
    throw new DestructiveTargetError(
      `${commandDescription} is aimed at the PRODUCTION database ` +
        `(${target}). This is refused unconditionally — production ` +
        `migrations run only through the Vercel build.`,
    );
  }
  const testingHost = normalizeHost(env.testingHost);
  if (testingHost && lower === testingHost) {
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
