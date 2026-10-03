import { prisma } from "@/lib/prisma";

/**
 * Best-effort display labels for audit `actorAuthIdentityId` scalars.
 *
 * Actor columns on audit/history tables are deliberately plain scalars
 * (no FK to AuthIdentity), so history survives deletion of the login
 * identity. This helper resolves the ids that still resolve — the
 * member record linked to the identity IN THIS ORGANIZATION first,
 * else the identity's sign-in email — and omits ids that no longer
 * resolve (deleted or unknown identities). Callers apply their own
 * final fallback: the raw actorAuthIdentityId, which stays on the row
 * as the stable forensic reference.
 *
 * Two batched queries regardless of input size — never per-row
 * lookups. The member lookup is organization-scoped, so a label never
 * leaks a member record from another organization. This does not
 * expand authorization: callers are already admin-restricted pages.
 */
export async function resolveActorLabels(
  organizationId: string,
  actorIds: Iterable<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = [
    ...new Set([...actorIds].filter((id): id is string => Boolean(id))),
  ];
  if (ids.length === 0) {
    return new Map();
  }
  const [actorMembers, identities] = await Promise.all([
    prisma.member.findMany({
      where: { organizationId, authIdentityId: { in: ids } },
      select: { authIdentityId: true, displayName: true },
    }),
    prisma.authIdentity.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true },
    }),
  ]);
  const labels = new Map<string, string>();
  for (const member of actorMembers) {
    if (member.authIdentityId) {
      labels.set(member.authIdentityId, member.displayName);
    }
  }
  for (const identity of identities) {
    if (!labels.has(identity.id) && identity.email) {
      labels.set(identity.id, identity.email);
    }
  }
  return labels;
}
