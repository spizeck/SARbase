import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  createMember,
  listMembers,
  setMemberStatus,
  setMemberUnits,
  CrossOrganizationAssignmentError,
} from "@/lib/domain/member";
import { createOrganization } from "@/lib/domain/organization";
import { createUnit } from "@/lib/domain/unit";

/**
 * Database-backed domain tests — run only via `npm run test:db`, which
 * maps TEST_DATABASE_URL onto DATABASE_URL. Skips loudly when the test
 * database is absent.
 *
 * Every fixture name is prefixed `dbtest-` so cleanup can remove test
 * rows without touching seeded or dev data.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "dbtest-";

let counter = 0;
function uniqueName(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

async function createTestOrg(suffix = "org") {
  return createOrganization({ name: uniqueName(suffix) });
}

describe.skipIf(!hasDb)("organization/unit/member domain", () => {
  afterAll(async () => {
    await prisma.memberUnit.deleteMany({
      where: { member: { organization: { name: { startsWith: PREFIX } } } },
    });
    await prisma.member.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.unit.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  it("creates an organization and lists it", async () => {
    const org = await createTestOrg();
    expect(org.id).toBeTruthy();
    expect(org.name.startsWith(PREFIX)).toBe(true);
    expect(org.createdAt).toBeInstanceOf(Date);
    expect(org.updatedAt).toBeInstanceOf(Date);
  });

  it("scopes units to their owning organization", async () => {
    const orgA = await createTestOrg("orgA");
    const orgB = await createTestOrg("orgB");

    const unitA = await createUnit(orgA.id, { name: uniqueName("unit-a") });
    expect(unitA.organizationId).toBe(orgA.id);

    const orgAUnits = await prisma.unit.findMany({
      where: { organizationId: orgA.id },
    });
    expect(orgAUnits.map((u) => u.id)).toEqual([unitA.id]);

    const orgBUnits = await prisma.unit.findMany({
      where: { organizationId: orgB.id },
    });
    expect(orgBUnits).toHaveLength(0);
  });

  it("enforces unit name uniqueness within an organization but not across", async () => {
    const orgA = await createTestOrg("orgA");
    const orgB = await createTestOrg("orgB");
    const name = uniqueName("shared");

    await createUnit(orgA.id, { name });
    await createUnit(orgB.id, { name }); // same name, different org — allowed

    await expect(createUnit(orgA.id, { name })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("scopes members to their owning organization", async () => {
    const org = await createTestOrg();
    const member = await createMember(org.id, {
      displayName: uniqueName("member"),
      email: undefined,
      phone: undefined,
    });

    expect(member.organizationId).toBe(org.id);
    expect(member.status).toBe("ACTIVE");

    const listed = await listMembers(org.id);
    expect(listed.map((m) => m.id)).toEqual([member.id]);
  });

  it("assigns members to units through MemberUnit", async () => {
    const org = await createTestOrg();
    const unit = await createUnit(org.id, { name: uniqueName("unit") });
    const member = await createMember(org.id, {
      displayName: uniqueName("member"),
      email: undefined,
      phone: undefined,
    });

    await setMemberUnits(member.id, [unit.id]);

    const rows = await prisma.memberUnit.findMany({
      where: { memberId: member.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unitId).toBe(unit.id);
    expect(rows[0]!.organizationId).toBe(org.id);

    const filtered = await listMembers(org.id, { unitId: unit.id });
    expect(filtered.map((m) => m.id)).toEqual([member.id]);
    const unfiltered = await listMembers(org.id, {
      unitId: "nonexistent-unit",
    });
    expect(unfiltered).toHaveLength(0);
  });

  it("rejects cross-organization member-unit assignment in the domain layer", async () => {
    const orgA = await createTestOrg("orgA");
    const orgB = await createTestOrg("orgB");
    const unitB = await createUnit(orgB.id, { name: uniqueName("unit-b") });
    const memberA = await createMember(orgA.id, {
      displayName: uniqueName("member-a"),
      email: undefined,
      phone: undefined,
    });

    await expect(setMemberUnits(memberA.id, [unitB.id])).rejects.toBeInstanceOf(
      CrossOrganizationAssignmentError,
    );

    const rows = await prisma.memberUnit.findMany({
      where: { memberId: memberA.id },
    });
    expect(rows).toHaveLength(0);
  });

  it("rejects cross-organization MemberUnit rows at the database level", async () => {
    const orgA = await createTestOrg("orgA");
    const orgB = await createTestOrg("orgB");
    const unitB = await createUnit(orgB.id, { name: uniqueName("unit-b") });
    const memberA = await createMember(orgA.id, {
      displayName: uniqueName("member-a"),
      email: undefined,
      phone: undefined,
    });

    // Claiming the member belongs to orgB fails the Member composite FK.
    await expect(
      prisma.memberUnit.create({
        data: {
          organizationId: orgB.id,
          memberId: memberA.id,
          unitId: unitB.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });

    // Claiming the unit belongs to orgA fails the Unit composite FK.
    await expect(
      prisma.memberUnit.create({
        data: {
          organizationId: orgA.id,
          memberId: memberA.id,
          unitId: unitB.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("prevents duplicate member-unit pairs", async () => {
    const org = await createTestOrg();
    const unit = await createUnit(org.id, { name: uniqueName("unit") });
    const member = await createMember(org.id, {
      displayName: uniqueName("member"),
      email: undefined,
      phone: undefined,
    });
    await setMemberUnits(member.id, [unit.id]);

    await expect(
      prisma.memberUnit.create({
        data: {
          organizationId: org.id,
          memberId: member.id,
          unitId: unit.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("deactivates and reactivates a member without destroying identity", async () => {
    const org = await createTestOrg();
    const member = await createMember(org.id, {
      displayName: uniqueName("member"),
      email: "member@dbtest.example",
      phone: undefined,
    });
    const memberId = member.id;

    const inactive = await setMemberStatus(memberId, "INACTIVE");
    expect(inactive.id).toBe(memberId);
    expect(inactive.status).toBe("INACTIVE");
    expect(inactive.displayName).toBe(member.displayName);
    expect(inactive.email).toBe(member.email);

    const reactivated = await setMemberStatus(memberId, "ACTIVE");
    expect(reactivated.id).toBe(memberId);
    expect(reactivated.status).toBe("ACTIVE");

    const stillExists = await prisma.member.findUnique({
      where: { id: memberId },
    });
    expect(stillExists).not.toBeNull();
  });

  it("blocks deleting an organization that owns units or members", async () => {
    const org = await createTestOrg();
    await createUnit(org.id, { name: uniqueName("unit") });

    await expect(
      prisma.organization.delete({ where: { id: org.id } }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^P20/) });
  });

  it("removes MemberUnit join rows when a member row is deleted at DB level", async () => {
    const org = await createTestOrg();
    const unit = await createUnit(org.id, { name: uniqueName("unit") });
    const member = await createMember(org.id, {
      displayName: uniqueName("member"),
      email: undefined,
      phone: undefined,
    });
    await setMemberUnits(member.id, [unit.id]);

    // Not an application operation — members are deactivated, never
    // deleted. This verifies the join-table cascade keeps referential
    // integrity if a row is ever removed administratively.
    await prisma.member.delete({ where: { id: member.id } });
    const rows = await prisma.memberUnit.findMany({
      where: { memberId: member.id },
    });
    expect(rows).toHaveLength(0);
  });

  it("dropped the bootstrap placeholder table in this migration", async () => {
    const rows = await prisma.$queryRaw<
      { reg: string | null }[]
    >`SELECT to_regclass('public."BootstrapItem"')::text AS reg`;
    expect(rows[0]?.reg).toBeNull();

    const domain = await prisma.$queryRaw<
      { reg: string | null }[]
    >`SELECT to_regclass('public."Organization"')::text AS reg`;
    expect(domain[0]?.reg).not.toBeNull();
  });
});
