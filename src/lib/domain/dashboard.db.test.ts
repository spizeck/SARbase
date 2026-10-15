import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { createOrganization } from "@/lib/domain/organization";
import { createUnit } from "@/lib/domain/unit";
import { createMember } from "@/lib/domain/member";
import { createAsset, createStorageLocation } from "@/lib/domain/assets";
import {
  createQualificationDefinition,
  createMemberQualification,
} from "@/lib/domain/qualification";
import { createTrainingEvent } from "@/lib/domain/training";
import { getAdminDashboard } from "@/lib/domain/dashboard";

/**
 * Database-backed dashboard tests — `npm run test:db` only.
 * Proves the dashboard assembly is strictly organization-scoped: counts
 * and lists reflect only the queried organization's records, and a
 * second organization sees none of them.
 *
 * Distinct prefix: files may run on parallel workers, so cleanup must
 * never touch another suite's fixtures.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "dashtest-";

let counter = 0;
function uniqueName(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

describe.skipIf(!hasDb)("organization dashboard", () => {
  afterAll(async () => {
    const orgFilter = { organization: { name: { startsWith: PREFIX } } };
    const byOrg = {
      organization: { name: { startsWith: PREFIX } },
    };
    await prisma.memberQualification.deleteMany({
      where: { member: { organization: { name: { startsWith: PREFIX } } } },
    });
    await prisma.trainingEvent.deleteMany({ where: orgFilter });
    await prisma.incident.deleteMany({ where: orgFilter });
    await prisma.calloutInvitation.deleteMany({ where: orgFilter });
    await prisma.callout.deleteMany({ where: orgFilter });
    await prisma.inventoryItem.deleteMany({ where: byOrg });
    await prisma.asset.deleteMany({ where: orgFilter });
    await prisma.storageLocation.deleteMany({ where: orgFilter });
    await prisma.qualificationDefinition.deleteMany({ where: orgFilter });
    await prisma.member.deleteMany({ where: orgFilter });
    await prisma.unit.deleteMany({ where: orgFilter });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  it("assembles real counts and lists for the organization", async () => {
    const org = await createOrganization({ name: uniqueName("a") });
    const unit = await createUnit(org.id, { name: uniqueName("unit") });
    const member = await createMember(org.id, {
      displayName: uniqueName("member"),
    });
    await createAsset(org.id, {
      name: uniqueName("asset"),
      status: "ACTIVE",
      condition: "UNKNOWN",
    });
    await createStorageLocation(org.id, {
      name: uniqueName("loc"),
      status: "ACTIVE",
    });
    const def = await createQualificationDefinition(org.id, {
      name: uniqueName("qual"),
    });

    // An expiring record: 10 days out falls inside the 30-day window.
    const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    await createMemberQualification(member.id, {
      definitionId: def.id,
      expiresOn: soon,
    });

    const upcoming = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    await createTrainingEvent(org.id, {
      title: uniqueName("future"),
      date: upcoming,
      topics: [],
    });
    await createTrainingEvent(org.id, {
      title: uniqueName("past"),
      date: past,
      topics: [],
    });

    await prisma.callout.create({
      data: {
        organizationId: org.id,
        createdByAuthIdentityId: "dashtest-actor",
        audience: "ORGANIZATION",
        title: uniqueName("callout"),
        activationKey: uniqueName("key"),
        intentHash: uniqueName("hash"),
      },
    });
    await prisma.incident.create({
      data: {
        organizationId: org.id,
        createdByAuthIdentityId: "dashtest-actor",
        sequence: 1,
        reference: "2026-001",
        title: uniqueName("incident"),
      },
    });

    const data = await getAdminDashboard(org.id, "UTC");

    expect(data.counts).toEqual({
      members: 1,
      units: 1,
      assets: 1,
      storageLocations: 1,
      inventoryItems: 0,
      qualificationDefinitions: 1,
    });
    expect(data.recentCallouts.map((c) => c.id)).toHaveLength(1);
    expect(data.recentIncidents.map((i) => i.reference)).toEqual(["2026-001"]);
    // Only the upcoming, non-cancelled event surfaces.
    expect(data.upcomingTraining.map((e) => e.title)).toEqual([
      expect.stringContaining("future"),
    ]);
    expect(data.expiringQualifications.map((q) => q.memberId)).toContain(
      member.id,
    );
    expect(unit.organizationId).toBe(org.id);
  });

  it("a second organization sees none of the first org's records", async () => {
    const orgA = await createOrganization({ name: uniqueName("b") });
    const orgB = await createOrganization({ name: uniqueName("c") });

    await createMember(orgA.id, { displayName: uniqueName("member") });
    await createAsset(orgA.id, {
      name: uniqueName("asset"),
      status: "ACTIVE",
      condition: "UNKNOWN",
    });
    await prisma.incident.create({
      data: {
        organizationId: orgA.id,
        createdByAuthIdentityId: "dashtest-actor",
        sequence: 1,
        reference: "2026-101",
        title: uniqueName("incident"),
      },
    });

    const b = await getAdminDashboard(orgB.id, "UTC");
    expect(b.counts).toEqual({
      members: 0,
      units: 0,
      assets: 0,
      storageLocations: 0,
      inventoryItems: 0,
      qualificationDefinitions: 0,
    });
    expect(b.recentCallouts).toHaveLength(0);
    expect(b.recentIncidents).toHaveLength(0);
    expect(b.upcomingTraining).toHaveLength(0);
    expect(b.expiringQualifications).toHaveLength(0);
  });

  it("cancelled or past training never appears as upcoming", async () => {
    const org = await createOrganization({ name: uniqueName("d") });
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const cancelled = await createTrainingEvent(org.id, {
      title: uniqueName("cancelled"),
      date: future,
      topics: [],
    });
    await prisma.trainingEvent.update({
      where: { id: cancelled.id },
      data: { status: "CANCELLED" },
    });
    await createTrainingEvent(org.id, {
      title: uniqueName("yesterday"),
      date: new Date(Date.now() - 24 * 60 * 60 * 1000),
      topics: [],
    });

    const data = await getAdminDashboard(org.id, "UTC");
    expect(data.upcomingTraining).toHaveLength(0);
  });
});
