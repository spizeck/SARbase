import { afterAll, describe, expect, it } from "vitest";

/**
 * Database-backed tests for organization access management
 * (issue #74) — run only via `npm run test:db`. Covers the atomic
 * role-change + audit write, the serialized last-administrator
 * invariant, cross-organization targeting, and the opaque not-found
 * denial. Fixture rows are prefixed `acctest-` for cleanup.
 */

import { prisma } from "@/lib/prisma";
import { createOrganization } from "@/lib/domain/organization";
import { AuthorizationError, loadAuthContext } from "@/lib/auth/context";
import { requireOrgAdmin } from "@/lib/auth/authorize";

import {
  setOrganizationAccessRole,
  listOrganizationAccess,
  listOrganizationAccessEvents,
  LastAdministratorError,
  OrganizationAccessNotFoundError,
} from "./access";

const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "acctest-";

let counter = 0;
function uniq(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

async function makeIdentity() {
  return prisma.authIdentity.create({
    data: {
      provider: "test",
      providerUid: uniq("uid"),
      email: `${uniq("id")}@example.test`,
    },
  });
}

async function grantAccess(
  authIdentityId: string,
  organizationId: string,
  role: "ADMIN" | "MEMBER",
) {
  return prisma.organizationAccess.create({
    data: { authIdentityId, organizationId, role },
  });
}

/** Hold an organization's access lock until `release()` is called. */
function holdAccessLock(organizationId: string) {
  let release!: () => void;
  let acquired!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const acquiredGate = new Promise<void>((resolve) => (acquired = resolve));
  const done = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${"sarbase:org-access:" + organizationId}, 0)
      )
    `;
    acquired();
    await gate;
  });
  return { acquired: acquiredGate, release, done };
}

describe.skipIf(!hasDb)("organization access role management", () => {
  afterAll(async () => {
    const orgFilter = { organization: { name: { startsWith: PREFIX } } };
    await prisma.organizationAccessEvent.deleteMany({
      where: orgFilter,
    });
    await prisma.organizationAccess.deleteMany({ where: orgFilter });
    await prisma.member.deleteMany({ where: orgFilter });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
    await prisma.authIdentity.deleteMany({
      where: { provider: "test", providerUid: { startsWith: PREFIX } },
    });
  });

  it("promotes a member to administrator with an atomic audit row", async () => {
    const org = await createOrganization({ name: uniq("org") });
    const admin = await makeIdentity();
    const target = await makeIdentity();
    await grantAccess(admin.id, org.id, "ADMIN");
    await grantAccess(target.id, org.id, "MEMBER");

    const result = await setOrganizationAccessRole(
      org.id,
      target.id,
      "ADMIN",
      admin.id,
    );
    expect(result).toEqual({ changed: true, previousRole: "MEMBER" });

    const row = await prisma.organizationAccess.findUniqueOrThrow({
      where: {
        authIdentityId_organizationId: {
          authIdentityId: target.id,
          organizationId: org.id,
        },
      },
    });
    expect(row.role).toBe("ADMIN");

    const events = await listOrganizationAccessEvents(org.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: org.id,
      targetAuthIdentityId: target.id,
      action: "ROLE_CHANGED",
      previousRole: "MEMBER",
      role: "ADMIN",
      actorAuthIdentityId: admin.id,
    });
  });

  it("demotes an administrator when another active admin remains", async () => {
    const org = await createOrganization({ name: uniq("org") });
    const adminA = await makeIdentity();
    const adminB = await makeIdentity();
    await grantAccess(adminA.id, org.id, "ADMIN");
    await grantAccess(adminB.id, org.id, "ADMIN");

    const result = await setOrganizationAccessRole(
      org.id,
      adminB.id,
      "MEMBER",
      adminA.id,
    );
    expect(result.changed).toBe(true);
    const row = await prisma.organizationAccess.findUniqueOrThrow({
      where: {
        authIdentityId_organizationId: {
          authIdentityId: adminB.id,
          organizationId: org.id,
        },
      },
    });
    expect(row.role).toBe("MEMBER");

    // Demotion is effective on the next request: authorization reloads
    // OrganizationAccess from the database, never a session snapshot.
    const ctx = await loadAuthContext(adminB.id);
    expect(ctx).not.toBeNull();
    expect(() => requireOrgAdmin(ctx!, org.id)).toThrow(AuthorizationError);
  });

  it("refuses to demote the last active administrator", async () => {
    const org = await createOrganization({ name: uniq("org") });
    const admin = await makeIdentity();
    const member = await makeIdentity();
    await grantAccess(admin.id, org.id, "ADMIN");
    await grantAccess(member.id, org.id, "MEMBER");

    // Even a self-demotion with no replacement is refused.
    await expect(
      setOrganizationAccessRole(org.id, admin.id, "MEMBER", admin.id),
    ).rejects.toBeInstanceOf(LastAdministratorError);

    const row = await prisma.organizationAccess.findUniqueOrThrow({
      where: {
        authIdentityId_organizationId: {
          authIdentityId: admin.id,
          organizationId: org.id,
        },
      },
    });
    expect(row.role).toBe("ADMIN");
    // A refused change writes no history.
    expect(await listOrganizationAccessEvents(org.id)).toHaveLength(0);
  });

  it("allows demoting a disabled sole administrator", async () => {
    const org = await createOrganization({ name: uniq("org") });
    const operator = await makeIdentity(); // external actor (e.g. support)
    const disabledAdmin = await makeIdentity();
    await grantAccess(disabledAdmin.id, org.id, "ADMIN");
    await prisma.authIdentity.update({
      where: { id: disabledAdmin.id },
      data: { status: "DISABLED" },
    });

    // A disabled identity cannot exercise the role, so this grant is
    // not an "active administrator" — demoting it cannot strand the
    // organization and must not be refused by the last-admin guard.
    const result = await setOrganizationAccessRole(
      org.id,
      disabledAdmin.id,
      "MEMBER",
      operator.id,
    );
    expect(result.changed).toBe(true);
    const row = await prisma.organizationAccess.findUniqueOrThrow({
      where: {
        authIdentityId_organizationId: {
          authIdentityId: disabledAdmin.id,
          organizationId: org.id,
        },
      },
    });
    expect(row.role).toBe("MEMBER");
  });

  it("is idempotent — re-applying the current role writes no audit row", async () => {
    const org = await createOrganization({ name: uniq("org") });
    const admin = await makeIdentity();
    const target = await makeIdentity();
    await grantAccess(admin.id, org.id, "ADMIN");
    await grantAccess(target.id, org.id, "MEMBER");

    const result = await setOrganizationAccessRole(
      org.id,
      target.id,
      "MEMBER",
      admin.id,
    );
    expect(result).toEqual({ changed: false, previousRole: "MEMBER" });
    expect(await listOrganizationAccessEvents(org.id)).toHaveLength(0);
  });

  it("cannot reach another organization's grant", async () => {
    const orgA = await createOrganization({ name: uniq("org-a") });
    const orgB = await createOrganization({ name: uniq("org-b") });
    const adminA = await makeIdentity();
    const targetB = await makeIdentity();
    await grantAccess(adminA.id, orgA.id, "ADMIN");
    await grantAccess(targetB.id, orgB.id, "MEMBER");

    // orgA's admin aims at orgB's grant — opaque not-found, no change.
    await expect(
      setOrganizationAccessRole(orgA.id, targetB.id, "ADMIN", adminA.id),
    ).rejects.toBeInstanceOf(OrganizationAccessNotFoundError);

    const row = await prisma.organizationAccess.findUniqueOrThrow({
      where: {
        authIdentityId_organizationId: {
          authIdentityId: targetB.id,
          organizationId: orgB.id,
        },
      },
    });
    expect(row.role).toBe("MEMBER");
  });

  it("denies a nonexistent grant opaquely", async () => {
    const org = await createOrganization({ name: uniq("org") });
    const admin = await makeIdentity();
    await grantAccess(admin.id, org.id, "ADMIN");

    await expect(
      setOrganizationAccessRole(org.id, "no-such-identity", "ADMIN", admin.id),
    ).rejects.toBeInstanceOf(OrganizationAccessNotFoundError);
  });

  it(
    "serializes concurrent demotions — the last admin survives",
    { timeout: 30_000 },
    async () => {
      const org = await createOrganization({ name: uniq("org") });
      const adminA = await makeIdentity();
      const adminB = await makeIdentity();
      await grantAccess(adminA.id, org.id, "ADMIN");
      await grantAccess(adminB.id, org.id, "ADMIN");

      const lock = holdAccessLock(org.id);
      await lock.acquired;

      // Both admins demote themselves at once. Only one can win: the
      // second observes zero other active admins under the lock.
      const demoteA = setOrganizationAccessRole(
        org.id,
        adminA.id,
        "MEMBER",
        adminA.id,
      );
      const demoteB = setOrganizationAccessRole(
        org.id,
        adminB.id,
        "MEMBER",
        adminB.id,
      );
      lock.release();
      const [ra, rb] = await Promise.allSettled([demoteA, demoteB]);
      await lock.done;

      const statuses = [ra.status, rb.status].sort();
      expect(statuses).toEqual(["fulfilled", "rejected"]);
      const loser = [ra, rb].find((r) => r.status === "rejected");
      expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(
        LastAdministratorError,
      );

      const survivors = await prisma.organizationAccess.count({
        where: {
          organizationId: org.id,
          role: "ADMIN",
          authIdentity: { status: "ACTIVE" },
        },
      });
      expect(survivors).toBe(1);
      // Exactly one event committed — the refused change wrote none.
      expect(await listOrganizationAccessEvents(org.id)).toHaveLength(1);
    },
  );

  it("lists every grant including identities with no member record", async () => {
    const org = await createOrganization({ name: uniq("org") });
    const withMember = await makeIdentity();
    const withoutMember = await makeIdentity();
    await grantAccess(withMember.id, org.id, "ADMIN");
    await grantAccess(withoutMember.id, org.id, "MEMBER");
    await prisma.member.create({
      data: {
        organizationId: org.id,
        displayName: uniq("member"),
        authIdentityId: withMember.id,
      },
    });

    const rows = await listOrganizationAccess(org.id);
    expect(rows).toHaveLength(2);
    const linked = rows.find((r) => r.authIdentityId === withMember.id);
    const unlinked = rows.find((r) => r.authIdentityId === withoutMember.id);
    expect(linked?.memberDisplayName).toBeTruthy();
    expect(unlinked?.memberDisplayName).toBeNull();
    expect(unlinked?.identityEmail).toContain("@example.test");
  });
});
