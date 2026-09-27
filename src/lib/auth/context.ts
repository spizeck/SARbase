import { cookies } from "next/headers";
import type { AuthIdentity, Member, OrganizationAccess } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import {
  AUTH_PROVIDER,
  SESSION_COOKIE_NAME,
  verifySessionCookie,
} from "./session";

/**
 * The authenticated request's access context — the ONLY legitimate
 * source of "who may touch what". Everything in it is derived
 * server-side: the session cookie is verified against Firebase (with
 * revocation), the AuthIdentity is looked up by (provider, providerUid)
 * and must be ACTIVE, and organization scope comes from explicit
 * OrganizationAccess rows — never from a client-supplied id, an email
 * match, or MemberUnit membership.
 *
 * Authorization evaluates the CURRENT database rows on every request:
 * roles are not embedded in the token, so access changes take effect
 * immediately.
 */
export interface AuthContext {
  identity: AuthIdentity;
  /** Member records linked to this identity (possibly across orgs). */
  members: Member[];
  /** Explicit organization grants; the role column carries MEMBER|ADMIN. */
  access: OrganizationAccess[];
}

/**
 * Resolve an AuthIdentity + its access rows into an AuthContext.
 * Returns null for unknown or non-ACTIVE identities — fail closed.
 */
export async function loadAuthContext(
  authIdentityId: string,
): Promise<AuthContext | null> {
  const identity = await prisma.authIdentity.findUnique({
    where: { id: authIdentityId },
    include: { members: true, organizationAccesses: true },
  });
  if (!identity || identity.status !== "ACTIVE") {
    return null;
  }
  return {
    identity,
    members: identity.members,
    access: identity.organizationAccesses,
  };
}

/**
 * Resolve the current request's auth context from the session cookie.
 * `null` means unauthenticated — no session, invalid/revoked cookie,
 * or a disabled identity all land here.
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!sessionCookie) {
    return null;
  }

  const decoded = await verifySessionCookie(sessionCookie);
  if (!decoded) {
    return null;
  }

  const identity = await prisma.authIdentity.findUnique({
    where: {
      provider_providerUid: {
        provider: AUTH_PROVIDER,
        providerUid: decoded.sub,
      },
    },
  });
  if (!identity) {
    return null;
  }

  return loadAuthContext(identity.id);
}

export type AuthDenialReason =
  | "unauthenticated"
  | "identity_disabled"
  | "no_org_access"
  | "insufficient_role"
  | "target_out_of_scope";

export class AuthenticationError extends Error {
  constructor(public readonly reason: "unauthenticated" | "identity_disabled") {
    super(`Authentication required: ${reason}`);
    this.name = "AuthenticationError";
  }
}

/**
 * Authorization failure. Deliberately one opaque error — the response
 * must not reveal whether the target record exists.
 */
export class AuthorizationError extends Error {
  constructor() {
    super("Not found or not permitted.");
    this.name = "AuthorizationError";
  }
}

export function isAuthorizationError(
  error: unknown,
): error is AuthorizationError {
  return error instanceof AuthorizationError;
}
