import type { OrgCapability, OrgRole } from "@prisma/client";

import { STANDARD_MANAGER_CAPABILITIES } from "@/lib/auth/capabilities";
import { log } from "@/lib/logging";
import { prisma } from "@/lib/prisma";

/**
 * Organization access grants — the administrator-facing management of
 * OrganizationAccess rows (issue #74).
 *
 * OrganizationAccess is the sole source of org-scoped access and role
 * (see docs/authentication.md). Grants are CREATED elsewhere —
 * invitation acceptance, identity linking, and `admin:provision` — and
 * are never deleted from the application surface. This module owns the
 * one supported mutation: changing a grant's role.
 *
 * Invariants enforced here:
 * - Role changes are atomic with their OrganizationAccessEvent audit
 *   row — a change cannot commit without its history.
 * - An organization can never be left without an ACTIVE administrator:
 *   demoting (or implicitly demoting) the last ADMIN whose identity is
 *   still ACTIVE is refused, enforced under a per-organization advisory
 *   lock so two concurrent admins cannot both demote past the check.
 * - Authorization is the CALLER's job — every caller must already hold
 *   ADMIN on `organizationId`.
 */

/** The target identity has no access row in this organization. */
export class OrganizationAccessNotFoundError extends Error {
  constructor() {
    super("Not found or not permitted.");
    this.name = "OrganizationAccessNotFoundError";
  }
}

/** The change would leave the organization without an active admin. */
export class LastAdministratorError extends Error {
  constructor() {
    super(
      "This is the organization's last active administrator. Grant administrator access to another account first.",
    );
    this.name = "LastAdministratorError";
  }
}

/**
 * Capability grants can only be edited while the target is a MANAGER —
 * granting capabilities to a MEMBER or ADMIN would be dead state that a
 * later role change could silently activate.
 */
export class NotManagerError extends Error {
  constructor() {
    super(
      "Capabilities can only be assigned to a manager. Change the account's role to Manager first.",
    );
    this.name = "NotManagerError";
  }
}

export interface OrganizationAccessRow {
  authIdentityId: string;
  role: OrgRole;
  /** Granted capabilities — meaningful only while role is MANAGER. */
  capabilities: OrgCapability[];
  identityEmail: string | null;
  identityStatus: "ACTIVE" | "DISABLED";
  /** Display name of the member record linked to this identity, if any. */
  memberDisplayName: string | null;
  memberId: string | null;
  updatedAt: Date;
}

/**
 * Every access grant for an organization — including rows whose identity
 * has no linked member record (a grant is not a membership). The admin
 * screen needs the complete picture: an administrator with no member
 * row still holds real access.
 */
export async function listOrganizationAccess(
  organizationId: string,
): Promise<OrganizationAccessRow[]> {
  const rows = await prisma.organizationAccess.findMany({
    where: { organizationId },
    include: {
      authIdentity: { select: { email: true, status: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const members = await prisma.member.findMany({
    where: {
      organizationId,
      authIdentityId: { in: rows.map((r) => r.authIdentityId) },
    },
    select: { id: true, authIdentityId: true, displayName: true },
  });
  const memberByIdentity = new Map(
    members.map((m) => [m.authIdentityId, m] as const),
  );
  return rows.map((row) => {
    const member = memberByIdentity.get(row.authIdentityId);
    return {
      authIdentityId: row.authIdentityId,
      role: row.role,
      capabilities: row.capabilities,
      identityEmail: row.authIdentity.email,
      identityStatus: row.authIdentity.status,
      memberDisplayName: member?.displayName ?? null,
      memberId: member?.id ?? null,
      updatedAt: row.updatedAt,
    };
  });
}

/**
 * One identity's current role in one organization — used to label the
 * sign-in account on a member record.
 */
export async function getOrganizationAccessRole(
  organizationId: string,
  authIdentityId: string,
): Promise<OrgRole | null> {
  const row = await prisma.organizationAccess.findUnique({
    where: {
      authIdentityId_organizationId: { authIdentityId, organizationId },
    },
    select: { role: true },
  });
  return row?.role ?? null;
}

/** Access-change audit rows for the admin screen, newest first. */
export function listOrganizationAccessEvents(
  organizationId: string,
  limit = 50,
) {
  return prisma.organizationAccessEvent.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/**
 * Change one identity's role in one organization.
 *
 * Serialized on a per-organization advisory lock — the same mechanism
 * as the containment-graph writes (see assets.ts). The last-admin check
 * is a read-then-write: without the lock, two concurrent demotions
 * could each observe "another admin exists" and both commit, leaving
 * the organization with none. hashtextextended collisions merely
 * over-serialize, never under-serialize.
 *
 * Idempotent by role: re-applying the current role writes no audit row.
 * Returns the applied change so the caller can report accurately.
 */
export async function setOrganizationAccessRole(
  organizationId: string,
  targetAuthIdentityId: string,
  role: OrgRole,
  actorAuthIdentityId: string,
): Promise<{ changed: boolean; previousRole: OrgRole }> {
  const result = await prisma.$transaction(async (tx) => {
    // pg_advisory_xact_lock returns void — $executeRaw avoids the
    // $queryRaw deserialization that void would break.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${"sarbase:org-access:" + organizationId}, 0)
      )
    `;

    const access = await tx.organizationAccess.findUnique({
      where: {
        authIdentityId_organizationId: {
          authIdentityId: targetAuthIdentityId,
          organizationId,
        },
      },
      include: { authIdentity: { select: { status: true } } },
    });
    // An access row outside the caller's org — or none at all — is the
    // same opaque denial as every other scope check.
    if (!access) throw new OrganizationAccessNotFoundError();
    if (access.role === role) {
      return { changed: false, previousRole: access.role };
    }

    if (
      access.role === "ADMIN" &&
      role !== "ADMIN" &&
      access.authIdentity.status === "ACTIVE"
    ) {
      // "Active administrator" means the grant exists AND the identity
      // can still sign in — a disabled account cannot exercise the
      // role, so it does not count as a surviving admin (and demoting
      // one is never the change that strands the organization).
      // MANAGER never counts — it cannot administer access.
      const otherActiveAdmins = await tx.organizationAccess.count({
        where: {
          organizationId,
          role: "ADMIN",
          authIdentityId: { not: targetAuthIdentityId },
          authIdentity: { status: "ACTIVE" },
        },
      });
      if (otherActiveAdmins === 0) throw new LastAdministratorError();
    }

    // Capability bookkeeping on role change (issue #84): entering
    // MANAGER applies the documented standard set; leaving it clears
    // every grant — a later re-promotion starts from the standard set
    // again rather than silently restoring stale privileges.
    const capabilities =
      role === "MANAGER" ? [...STANDARD_MANAGER_CAPABILITIES] : [];

    await tx.organizationAccess.update({
      where: { id: access.id },
      data: { role, capabilities },
    });
    await tx.organizationAccessEvent.create({
      data: {
        organizationId,
        targetAuthIdentityId,
        action: "ROLE_CHANGED",
        previousRole: access.role,
        role,
        previousCapabilities: access.capabilities,
        capabilities,
        actorAuthIdentityId,
      },
    });
    return { changed: true, previousRole: access.role };
  });

  if (result.changed) {
    log({
      event: "auth.org_access_role_changed",
      subsystem: "auth",
      actorId: actorAuthIdentityId,
      entityType: "OrganizationAccess",
      entityId: targetAuthIdentityId,
      organizationId,
      organizationRole: role,
    });
  }
  return result;
}

/**
 * Replace a MANAGER's capability grants (issue #84).
 *
 * Runs under the same per-organization advisory lock as role changes —
 * a capability edit racing a role change cannot resurrect grants the
 * role change just cleared (or grant capabilities onto a row that is
 * no longer MANAGER). Idempotent by set equality: re-saving the
 * current grants writes no audit row.
 *
 * Every grant is validated by the caller (typed OrgCapability values
 * only — the action layer rejects unknown strings before this runs).
 * Authorization is the CALLER's job: every caller must already hold
 * ADMIN on `organizationId`.
 */
export async function setOrganizationAccessCapabilities(
  organizationId: string,
  targetAuthIdentityId: string,
  capabilities: OrgCapability[],
  actorAuthIdentityId: string,
  reason?: string,
): Promise<{ changed: boolean; previousCapabilities: OrgCapability[] }> {
  const next = [...new Set(capabilities)].sort();
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${"sarbase:org-access:" + organizationId}, 0)
      )
    `;

    const access = await tx.organizationAccess.findUnique({
      where: {
        authIdentityId_organizationId: {
          authIdentityId: targetAuthIdentityId,
          organizationId,
        },
      },
    });
    if (!access) throw new OrganizationAccessNotFoundError();
    if (access.role !== "MANAGER") throw new NotManagerError();

    const previous = [...access.capabilities].sort();
    if (
      previous.length === next.length &&
      previous.every((c, i) => c === next[i])
    ) {
      return { changed: false, previousCapabilities: access.capabilities };
    }

    await tx.organizationAccess.update({
      where: { id: access.id },
      data: { capabilities: next },
    });
    await tx.organizationAccessEvent.create({
      data: {
        organizationId,
        targetAuthIdentityId,
        action: "CAPABILITIES_CHANGED",
        previousRole: access.role,
        role: access.role,
        previousCapabilities: access.capabilities,
        capabilities: next,
        reason: reason?.trim() || null,
        actorAuthIdentityId,
      },
    });
    return { changed: true, previousCapabilities: access.capabilities };
  });

  if (result.changed) {
    log({
      event: "auth.org_access_capabilities_changed",
      subsystem: "auth",
      actorId: actorAuthIdentityId,
      entityType: "OrganizationAccess",
      entityId: targetAuthIdentityId,
      organizationId,
      detail: { capabilities: next },
    });
  }
  return result;
}
