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
  setOrganizationAccessCapabilities,
  listOrganizationAccess,
  listOrganizationAccessEvents,
  LastAdministratorError,
  NotManagerError,
  OrganizationAccessNotFoundError,
} from "./access";
import { STANDARD_MANAGER_CAPABILITIES } from "@/lib/auth/capabilities";
import type { OrgCapability, OrgRole } from "@prisma/client";

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
  role: OrgRole,
  capabilities: OrgCapability[] = [],
) {
  return prisma.organizationAccess.create({
    data: { authIdentityId, organizationId, role, capabilities },
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

describe.skipIf(!hasDb)("manager capabilities (issue #84)", () => {
  afterAll(async () => {
    const orgFilter = { organization: { name: { startsWith: PREFIX } } };
    await prisma.organizationAccessEvent.deleteMany({ where: orgFilter });
    await prisma.organizationAccess.deleteMany({ where: orgFilter });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
    await prisma.authIdentity.deleteMany({
      where: { provider: "test", providerUid: { startsWith: PREFIX } },
    });
  });

  it("promotion to MANAGER applies the standard capability set", async () => {
    const org = await createOrganization({ name: uniq("org") });
    const admin = await makeIdentity();
    const target = await makeIdentity();
    await grantAccess(admin.id, org.id, "ADMIN");
    await grantAccess(target.id, org.id, "MEMBER");

    const result = await setOrganizationAccessRole(
      org.id,
      target.id,
      "MANAGER",
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
    expect(row.role).toBe("MANAGER");
    expect([...row.capabilities].sort()).toEqual(
      [...STANDARD_MANAGER_CAPABILITIES].sort(),
    );

    const events = await listOrganizationAccessEvents(org.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "ROLE_CHANGED",
      previousRole: "MEMBER",
      role: "MANAGER",
    });
    expect(events[0]!.capabilities.sort()).toEqual(
      [...STANDARD_MANAGER_CAPABILITIES].sort(),
    );
  });

  it("leaving MANAGER clears every grant — no stale privileges", async () => {
    const org = await createOrganization({ name: uniq("org") });
    const admin = await makeIdentity();
    const target = await makeIdentity();
    await grantAccess(admin.id, org.id, "ADMIN");
    await grantAccess(target.id, org.id, "MANAGER", ["EQUIPMENT_MANAGE"]);

    await setOrganizationAccessRole(org.id, target.id, "MEMBER", admin.id);
    const row = await prisma.organizationAccess.findUniqueOrThrow({
      where: {
        authIdentityId_organizationId: {
          authIdentityId: target.id,
          organizationId: org.id,
        },
      },
    });
    expect(row.role).toBe("MEMBER");
    expect(row.capabilities).toEqual([]);

    const events = await listOrganizationAccessEvents(org.id);
    expect(events[0]).toMatchObject({
      action: "ROLE_CHANGED",
      previousCapabilities: ["EQUIPMENT_MANAGE"],
      capabilities: [],
    });
  });

  it("re-promotion starts from the standard set, not the old grants", async () => {
    const org = await createOrganization({ name: uniq("org") });
    const admin = await makeIdentity();
    const target = await makeIdentity();
    await grantAccess(admin.id, org.id, "ADMIN");
    await grantAccess(target.id, org.id, "MEMBER");

    await setOrganizationAccessRole(org.id, target.id, "MANAGER", admin.id);
    await setOrganizationAccessCapabilities(
      org.id,
      target.id,
      ["FINANCE_APPROVE"],
      admin.id,
    );
    await setOrganizationAccessRole(org.id, target.id, "MEMBER", admin.id);
    await setOrganizationAccessRole(org.id, target.id, "MANAGER", admin.id);

    const row = await prisma.organizationAccess.findUniqueOrThrow({
      where: {
        authIdentityId_organizationId: {
          authIdentityId: target.id,
          organizationId: org.id,
        },
      },
    });
    expect(row.capabilities.sort()).toEqual(
      [...STANDARD_MANAGER_CAPABILITIES].sort(),
    );
    expect(row.capabilities).not.toContain("FINANCE_APPROVE");
  });

  it("demoting the last ADMIN to MANAGER is refused", async () => {
    const org = await createOrganization({ name: uniq("org") });
    const admin = await makeIdentity();
    await grantAccess(admin.id, org.id, "ADMIN");

    await expect(
      setOrganizationAccessRole(org.id, admin.id, "MANAGER", admin.id),
    ).rejects.toBeInstanceOf(LastAdministratorError);
  });

  it("a MANAGER does not count as an active administrator", async () => {
    const org = await createOrganization({ name: uniq("org") });
    const admin = await makeIdentity();
    const manager = await makeIdentity();
    await grantAccess(admin.id, org.id, "ADMIN");
    await grantAccess(manager.id, org.id, "MANAGER", ["MEMBERS_MANAGE"]);

    // The only admin demoting themselves with just a manager beside
    // them would strand the organization — refused.
    await expect(
      setOrganizationAccessRole(org.id, admin.id, "MEMBER", admin.id),
    ).rejects.toBeInstanceOf(LastAdministratorError);
  });

  it("setOrganizationAccessCapabilities replaces grants with an audit row", async () => {
    const org = await createOrganization({ name: uniq("org") });
    const admin = await makeIdentity();
    const target = await makeIdentity();
    await grantAccess(admin.id, org.id, "ADMIN");
    await grantAccess(target.id, org.id, "MANAGER", [
      "EQUIPMENT_MANAGE",
      "TRAINING_MANAGE",
    ]);

    const result = await setOrganizationAccessCapabilities(
      org.id,
      target.id,
      ["TRAINING_MANAGE", "QUALIFICATIONS_MANAGE"],
      admin.id,
      "Training coordinator",
    );
    expect(result.changed).toBe(true);
    expect(result.previousCapabilities).toEqual([
      "EQUIPMENT_MANAGE",
      "TRAINING_MANAGE",
    ]);

    const row = await prisma.organizationAccess.findUniqueOrThrow({
      where: {
        authIdentityId_organizationId: {
          authIdentityId: target.id,
          organizationId: org.id,
        },
      },
    });
    expect(row.capabilities).toEqual([
      "QUALIFICATIONS_MANAGE",
      "TRAINING_MANAGE",
    ]);

    const events = await listOrganizationAccessEvents(org.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "CAPABILITIES_CHANGED",
      previousRole: "MANAGER",
      role: "MANAGER",
      reason: "Training coordinator",
      actorAuthIdentityId: admin.id,
    });
    expect(events[0]!.previousCapabilities.sort()).toEqual([
      "EQUIPMENT_MANAGE",
      "TRAINING_MANAGE",
    ]);
    expect(events[0]!.capabilities.sort()).toEqual([
      "QUALIFICATIONS_MANAGE",
      "TRAINING_MANAGE",
    ]);
  });

  it("refuses capability edits on non-MANAGER rows", async () => {
    const org = await createOrganization({ name: uniq("org") });
    const admin = await makeIdentity();
    const member = await makeIdentity();
    await grantAccess(admin.id, org.id, "ADMIN");
    await grantAccess(member.id, org.id, "MEMBER");

    await expect(
      setOrganizationAccessCapabilities(
        org.id,
        member.id,
        ["EQUIPMENT_MANAGE"],
        admin.id,
      ),
    ).rejects.toBeInstanceOf(NotManagerError);
    // Granting capabilities to an ADMIN would be dead state too.
    await expect(
      setOrganizationAccessCapabilities(
        org.id,
        admin.id,
        ["EQUIPMENT_MANAGE"],
        admin.id,
      ),
    ).rejects.toBeInstanceOf(NotManagerError);
    expect(await listOrganizationAccessEvents(org.id)).toHaveLength(0);
  });

  it("capability edits are idempotent and deduplicated", async () => {
    const org = await createOrganization({ name: uniq("org") });
    const admin = await makeIdentity();
    const target = await makeIdentity();
    await grantAccess(admin.id, org.id, "ADMIN");
    await grantAccess(target.id, org.id, "MANAGER", ["TRAINING_MANAGE"]);

    const same = await setOrganizationAccessCapabilities(
      org.id,
      target.id,
      ["TRAINING_MANAGE"],
      admin.id,
    );
    expect(same.changed).toBe(false);
    expect(await listOrganizationAccessEvents(org.id)).toHaveLength(0);

    const dupes = await setOrganizationAccessCapabilities(
      org.id,
      target.id,
      ["EQUIPMENT_MANAGE", "EQUIPMENT_MANAGE"],
      admin.id,
    );
    expect(dupes.changed).toBe(true);
    const row = await prisma.organizationAccess.findUniqueOrThrow({
      where: {
        authIdentityId_organizationId: {
          authIdentityId: target.id,
          organizationId: org.id,
        },
      },
    });
    expect(row.capabilities).toEqual(["EQUIPMENT_MANAGE"]);
  });

  it("cannot edit capabilities on another organization's grant", async () => {
    const orgA = await createOrganization({ name: uniq("org-a") });
    const orgB = await createOrganization({ name: uniq("org-b") });
    const adminA = await makeIdentity();
    const targetB = await makeIdentity();
    await grantAccess(adminA.id, orgA.id, "ADMIN");
    await grantAccess(targetB.id, orgB.id, "MANAGER", ["TRAINING_MANAGE"]);

    await expect(
      setOrganizationAccessCapabilities(
        orgA.id,
        targetB.id,
        ["FINANCE_APPROVE"],
        adminA.id,
      ),
    ).rejects.toBeInstanceOf(OrganizationAccessNotFoundError);

    const row = await prisma.organizationAccess.findUniqueOrThrow({
      where: {
        authIdentityId_organizationId: {
          authIdentityId: targetB.id,
          organizationId: orgB.id,
        },
      },
    });
    expect(row.capabilities).toEqual(["TRAINING_MANAGE"]);
  });

  it(
    "a capability edit racing a role change cannot resurrect grants",
    { timeout: 30_000 },
    async () => {
      const org = await createOrganization({ name: uniq("org") });
      const admin = await makeIdentity();
      const target = await makeIdentity();
      await grantAccess(admin.id, org.id, "ADMIN");
      await grantAccess(target.id, org.id, "MANAGER", ["EQUIPMENT_MANAGE"]);

      const lock = holdAccessLock(org.id);
      await lock.acquired;

      // Capability edit and demotion both queue behind the lock.
      // Whichever lands first, the final row must never hold grants
      // on a non-MANAGER role.
      const settle = (p: Promise<unknown>) =>
        p.then(
          () => ({ ok: true as const }),
          (reason: unknown) => ({ ok: false as const, reason }),
        );
      const edit = settle(
        setOrganizationAccessCapabilities(
          org.id,
          target.id,
          ["FINANCE_APPROVE"],
          admin.id,
        ),
      );
      const demote = settle(
        setOrganizationAccessRole(org.id, target.id, "MEMBER", admin.id),
      );
      lock.release();
      const [editResult, demoteResult] = await Promise.all([edit, demote]);
      await lock.done;

      const row = await prisma.organizationAccess.findUniqueOrThrow({
        where: {
          authIdentityId_organizationId: {
            authIdentityId: target.id,
            organizationId: org.id,
          },
        },
      });
      expect(row.role).toBe("MEMBER");
      expect(row.capabilities).toEqual([]);

      // If the edit landed first, the demote succeeded and cleared it;
      // if the demote landed first, the edit must have failed with
      // NotManagerError � never a post-demotion grant.
      if (editResult.ok) {
        expect(demoteResult.ok).toBe(true);
      } else {
        expect(editResult.reason).toBeInstanceOf(NotManagerError);
      }
    },
  );
});
