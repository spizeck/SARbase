import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { createMember } from "@/lib/domain/member";
import { createOrganization } from "@/lib/domain/organization";
import {
  createQualificationDefinition,
  createMemberQualification,
  listExpiringQualifications,
  listMemberQualifications,
  listQualificationDefinitions,
  setQualificationDefinitionStatus,
  updateMemberQualification,
  CrossOrganizationQualificationError,
  InactiveQualificationError,
} from "@/lib/domain/qualification";

/**
 * Database-backed qualification tests — `npm run test:db` only.
 * Fixture names are prefixed `dbtest-` for cleanup.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
// Distinct prefix from domain.db.test.ts — files may run on parallel
// workers, so cleanup must never delete another file's fixtures.
const PREFIX = "qualtest-";

let counter = 0;
function uniqueName(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

async function createTestOrg(suffix = "org") {
  return createOrganization({ name: uniqueName(suffix) });
}

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe.skipIf(!hasDb)("qualification domain", () => {
  afterAll(async () => {
    await prisma.memberQualification.deleteMany({
      where: { member: { organization: { name: { startsWith: PREFIX } } } },
    });
    await prisma.qualificationDefinition.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.member.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  it("creates a definition scoped to its organization", async () => {
    const org = await createTestOrg("def-scope");
    const def = await createQualificationDefinition(org.id, {
      name: uniqueName("first-aid"),
    });
    expect(def.organizationId).toBe(org.id);
    expect(def.status).toBe("ACTIVE");

    const listed = await listQualificationDefinitions(org.id);
    expect(listed.map((d) => d.id)).toContain(def.id);
  });

  it("enforces per-organization name uniqueness but not global", async () => {
    const orgA = await createTestOrg("uniq-a");
    const orgB = await createTestOrg("uniq-b");
    const name = uniqueName("cpr");

    await createQualificationDefinition(orgA.id, { name });
    // Same name inside the same org → Postgres unique violation.
    await expect(
      createQualificationDefinition(orgA.id, { name }),
    ).rejects.toMatchObject({ code: "P2002" });
    // Same name in a different org → fine.
    await expect(
      createQualificationDefinition(orgB.id, { name }),
    ).resolves.toMatchObject({ name });
  });

  it("records a member qualification with dates, issuer and reference", async () => {
    const org = await createTestOrg("record");
    const member = await createMember(org.id, {
      displayName: uniqueName("member"),
    });
    const def = await createQualificationDefinition(org.id, {
      name: uniqueName("def"),
    });

    const record = await createMemberQualification(member.id, {
      definitionId: def.id,
      issuedOn: D("2025-01-10"),
      expiresOn: D("2027-01-10"),
      issuer: "Synthetic Training Org",
      reference: "CERT-001",
      notes: "demo",
    });
    expect(record.organizationId).toBe(org.id);
    expect(record.issuedOn!.toISOString()).toBe("2025-01-10T00:00:00.000Z");
  });

  it("rejects linking a member to another org's definition (domain check)", async () => {
    const orgA = await createTestOrg("x-a");
    const orgB = await createTestOrg("x-b");
    const memberA = await createMember(orgA.id, {
      displayName: uniqueName("member-a"),
    });
    const defB = await createQualificationDefinition(orgB.id, {
      name: uniqueName("def-b"),
    });

    await expect(
      createMemberQualification(memberA.id, { definitionId: defB.id }),
    ).rejects.toBeInstanceOf(CrossOrganizationQualificationError);
  });

  it("rejects cross-org rows at the DATABASE level (composite FK)", async () => {
    const orgA = await createTestOrg("fk-a");
    const orgB = await createTestOrg("fk-b");
    const memberA = await prisma.member.create({
      data: { organizationId: orgA.id, displayName: uniqueName("fk-member") },
    });
    const defB = await prisma.qualificationDefinition.create({
      data: { organizationId: orgB.id, name: uniqueName("fk-def") },
    });

    // memberId belongs to org A but definitionId belongs to org B while
    // organizationId says A — the (definitionId, organizationId) FK must
    // fail no matter which org id the caller asserts.
    await expect(
      prisma.memberQualification.create({
        data: {
          organizationId: orgA.id,
          memberId: memberA.id,
          definitionId: defB.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });

    await expect(
      prisma.memberQualification.create({
        data: {
          organizationId: orgB.id,
          memberId: memberA.id,
          definitionId: defB.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("keeps renewal history as separate records, ordered latest-first", async () => {
    const org = await createTestOrg("history");
    const member = await createMember(org.id, {
      displayName: uniqueName("member"),
    });
    const def = await createQualificationDefinition(org.id, {
      name: uniqueName("def"),
    });

    const old = await createMemberQualification(member.id, {
      definitionId: def.id,
      issuedOn: D("2023-05-01"),
      expiresOn: D("2025-05-01"),
    });
    const renewed = await createMemberQualification(member.id, {
      definitionId: def.id,
      issuedOn: D("2025-05-15"),
      expiresOn: D("2027-05-15"),
    });

    const records = await listMemberQualifications(member.id);
    expect(records.map((r) => r.id)).toEqual([renewed.id, old.id]);
    // Correcting the old record must not disturb the newer one.
    await updateMemberQualification(old.id, { notes: "corrected" });
    const after = await listMemberQualifications(member.id);
    expect(after.map((r) => r.id)).toEqual([renewed.id, old.id]);
    expect(after[1]?.notes).toBe("corrected");
  });

  it("orders records without issue dates after dated ones (deterministic)", async () => {
    const org = await createTestOrg("order");
    const member = await createMember(org.id, {
      displayName: uniqueName("member"),
    });
    const def = await createQualificationDefinition(org.id, {
      name: uniqueName("def"),
    });

    const undated = await createMemberQualification(member.id, {
      definitionId: def.id,
    });
    const dated = await createMemberQualification(member.id, {
      definitionId: def.id,
      issuedOn: D("2020-01-01"),
    });

    const records = await listMemberQualifications(member.id);
    expect(records.map((r) => r.id)).toEqual([dated.id, undated.id]);
  });

  it("inactive definition blocks new records but preserves existing ones", async () => {
    const org = await createTestOrg("inactive-def");
    const member = await createMember(org.id, {
      displayName: uniqueName("member"),
    });
    const def = await createQualificationDefinition(org.id, {
      name: uniqueName("def"),
    });
    const record = await createMemberQualification(member.id, {
      definitionId: def.id,
      issuedOn: D("2024-01-01"),
    });

    await setQualificationDefinitionStatus(def.id, "INACTIVE");
    await expect(
      createMemberQualification(member.id, { definitionId: def.id }),
    ).rejects.toBeInstanceOf(InactiveQualificationError);

    // History intact; corrections still allowed; listing still shows it.
    const records = await listMemberQualifications(member.id);
    expect(records.map((r) => r.id)).toEqual([record.id]);
    await expect(
      updateMemberQualification(record.id, { notes: "still editable" }),
    ).resolves.toMatchObject({ notes: "still editable" });

    // Inactive definitions are excluded from the default listing…
    expect(
      (await listQualificationDefinitions(org.id)).map((d) => d.id),
    ).not.toContain(def.id);
    // …but retained for the admin view.
    expect(
      (
        await listQualificationDefinitions(org.id, { includeInactive: true })
      ).map((d) => d.id),
    ).toContain(def.id);
  });

  it("inactive member retains qualification history", async () => {
    const org = await createTestOrg("inactive-member");
    const member = await createMember(org.id, {
      displayName: uniqueName("member"),
    });
    const def = await createQualificationDefinition(org.id, {
      name: uniqueName("def"),
    });
    await createMemberQualification(member.id, { definitionId: def.id });

    const { setMemberStatus } = await import("@/lib/domain/member");
    await setMemberStatus(member.id, "INACTIVE");
    expect(await listMemberQualifications(member.id)).toHaveLength(1);
  });

  it("listExpiringQualifications scopes by org and respects the window", async () => {
    const orgA = await createTestOrg("exp-a");
    const orgB = await createTestOrg("exp-b");
    const memberA = await createMember(orgA.id, {
      displayName: uniqueName("member-a"),
    });
    const memberB = await createMember(orgB.id, {
      displayName: uniqueName("member-b"),
    });
    const defA = await createQualificationDefinition(orgA.id, {
      name: uniqueName("def-a"),
    });
    const defB = await createQualificationDefinition(orgB.id, {
      name: uniqueName("def-b"),
    });

    const today = D("2027-11-14");
    const soon = await createMemberQualification(memberA.id, {
      definitionId: defA.id,
      expiresOn: D("2027-11-20"), // +6 days
    });
    const later = await createMemberQualification(memberA.id, {
      definitionId: defA.id,
      expiresOn: D("2028-01-10"), // +57 days
    });
    const past = await createMemberQualification(memberA.id, {
      definitionId: defA.id,
      expiresOn: D("2027-11-01"), // already expired
    });
    const noExpiry = await createMemberQualification(memberA.id, {
      definitionId: defA.id, // never expires — must never appear
    });
    await createMemberQualification(memberB.id, {
      definitionId: defB.id,
      expiresOn: D("2027-11-15"), // org B — must not leak into A's list
    });

    const within30 = await listExpiringQualifications(orgA.id, {
      withinDays: 30,
      today,
    });
    expect(within30.map((r) => r.id)).toEqual([soon.id]);
    expect(within30.map((r) => r.id)).not.toContain(noExpiry.id);

    const within90 = await listExpiringQualifications(orgA.id, {
      withinDays: 90,
      today,
    });
    expect(within90.map((r) => r.id)).toEqual([soon.id, later.id]);

    const withExpired = await listExpiringQualifications(orgA.id, {
      withinDays: 30,
      today,
      includeExpired: true,
    });
    expect(withExpired.map((r) => r.id)).toEqual([past.id, soon.id]);
  });
});
