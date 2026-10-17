import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { calendarDateInZone } from "@/lib/dates";
import { createOrganization } from "@/lib/domain/organization";
import { createUnit } from "@/lib/domain/unit";
import { createMember } from "@/lib/domain/member";
import { createAsset, createStorageLocation } from "@/lib/domain/assets";
import {
  createQualificationDefinition,
  createMemberQualification,
} from "@/lib/domain/qualification";
import { createTrainingEvent } from "@/lib/domain/training";
import {
  getAdminDashboard,
  getDashboardAttention,
} from "@/lib/domain/dashboard";

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
    await prisma.memberAvailabilityUpdate.deleteMany({ where: byOrg });
    await prisma.notificationDeliveryEvent.deleteMany({ where: byOrg });
    await prisma.notificationAttempt.deleteMany({ where: byOrg });
    await prisma.notification.deleteMany({ where: byOrg });
    await prisma.defect.deleteMany({ where: byOrg });
    await prisma.memberSubmissionAttachment.deleteMany({ where: byOrg });
    await prisma.memberSubmission.deleteMany({ where: byOrg });
    await prisma.memberInvitationEvent.deleteMany({ where: byOrg });
    await prisma.memberInvitation.deleteMany({ where: byOrg });
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

  it("attention sections appear only for the caller's capabilities", async () => {
    const org = await createOrganization({ name: uniqueName("e") });
    const today = calendarDateInZone("UTC");

    const nothing = await getDashboardAttention(org.id, [], false, today);
    expect(nothing).toEqual({});

    const opsOnly = await getDashboardAttention(
      org.id,
      ["OPERATIONS_MANAGE"],
      false,
      today,
    );
    expect(opsOnly.availability).toBeDefined();
    expect(opsOnly.activeCallouts).toBeDefined();
    expect(opsOnly.failedNotifications).toBeDefined();
    // No equipment, verify, or admin data for an ops-only manager.
    expect(opsOnly.equipment).toBeUndefined();
    expect(opsOnly.pendingSubmissions).toBeUndefined();
    expect(opsOnly.pendingInvitations).toBeUndefined();

    const admin = await getDashboardAttention(
      org.id,
      ["EQUIPMENT_MANAGE", "QUALIFICATIONS_VERIFY"],
      true,
      today,
    );
    expect(admin.availability).toBeUndefined();
    expect(admin.activeCallouts).toBeUndefined();
    expect(admin.equipment).toBeDefined();
    expect(admin.pendingSubmissions).toBe(0);
    expect(admin.pendingInvitations).toBe(0);
  });

  it("availability rollup separates never-recorded from expired", async () => {
    const org = await createOrganization({ name: uniqueName("f") });
    const today = calendarDateInZone("UTC");
    const memberIds: string[] = [];
    for (const suffix of ["a", "b", "c", "d", "e"]) {
      memberIds.push(
        (
          await createMember(org.id, {
            displayName: uniqueName(`m-${suffix}`),
          })
        ).id,
      );
    }
    const [avail, unavail, offIsland, expired] = memberIds as [
      string,
      string,
      string,
      string,
    ];
    // memberIds[4] records nothing — never-recorded UNKNOWN.
    const mk = (memberId: string, status: string, until?: Date) =>
      prisma.memberAvailabilityUpdate.create({
        data: {
          organizationId: org.id,
          memberId,
          status: status as "AVAILABLE" | "UNAVAILABLE" | "OFF_ISLAND",
          until: until ?? null,
          actorAuthIdentityId: "dashtest-actor",
        },
      });
    await mk(avail, "AVAILABLE");
    await mk(unavail, "UNAVAILABLE");
    await mk(offIsland, "OFF_ISLAND", today);
    // Expired statement — until yesterday bypasses write validation via
    // direct insert; the read-side expiry rule is what's under test.
    await mk(expired, "AVAILABLE", new Date(Date.now() - 24 * 60 * 60 * 1000));

    const attention = await getDashboardAttention(
      org.id,
      ["MEMBERS_MANAGE"],
      false,
      today,
    );
    expect(attention.availability).toEqual({
      totalActive: 5,
      available: 1,
      unavailable: 1,
      offIsland: 1,
      unknownNoStatement: 1,
      unknownExpired: 1,
    });
  });

  it("attention items reflect only this organization's records", async () => {
    const orgA = await createOrganization({ name: uniqueName("g") });
    const orgB = await createOrganization({ name: uniqueName("h") });
    const today = calendarDateInZone("UTC");
    const memberA = await createMember(orgA.id, {
      displayName: uniqueName("member-a"),
      email: "a@example.test",
    });

    const callout = await prisma.callout.create({
      data: {
        organizationId: orgA.id,
        createdByAuthIdentityId: "dashtest-actor",
        audience: "MEMBERS",
        title: uniqueName("callout"),
        activationKey: uniqueName("key"),
        intentHash: uniqueName("hash"),
      },
    });
    await prisma.calloutInvitation.create({
      data: {
        organizationId: orgA.id,
        calloutId: callout.id,
        memberId: memberA.id,
        responseTokenHash: uniqueName("token"),
        response: "COMING",
      },
    });
    await prisma.notification.create({
      data: {
        organizationId: orgA.id,
        channel: "EMAIL",
        template: "callout_invite",
        idempotencyKey: uniqueName("idem"),
        intentHash: uniqueName("intent"),
        status: "FAILED",
      },
    });
    const asset = await createAsset(orgA.id, {
      name: uniqueName("asset"),
      status: "ACTIVE",
      condition: "UNKNOWN",
    });
    await prisma.defect.create({
      data: {
        organizationId: orgA.id,
        assetId: asset.id,
        reportedOn: today,
        title: uniqueName("defect"),
      },
    });
    await prisma.memberSubmission.create({
      data: {
        organizationId: orgA.id,
        memberId: memberA.id,
        kind: "RECORD_CORRECTION",
        details: "test",
        submittedByAuthIdentityId: "dashtest-actor",
      },
    });
    await prisma.memberInvitation.create({
      data: {
        organizationId: orgA.id,
        memberId: memberA.id,
        email: "a@example.test",
        tokenHash: uniqueName("tokenhash"),
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      },
    });

    const a = await getDashboardAttention(
      orgA.id,
      [
        "OPERATIONS_MANAGE",
        "NOTIFICATIONS_MANAGE",
        "EQUIPMENT_MANAGE",
        "QUALIFICATIONS_VERIFY",
      ],
      true,
      today,
    );
    expect(a.activeCallouts).toHaveLength(1);
    expect(a.activeCallouts?.[0]?.counts).toEqual({
      total: 1,
      coming: 1,
      unavailable: 0,
      noResponse: 0,
    });
    expect(a.failedNotifications).toBe(1);
    expect(a.equipment?.openDefects).toBe(1);
    expect(a.pendingSubmissions).toBe(1);
    expect(a.pendingInvitations).toBe(1);

    const b = await getDashboardAttention(
      orgB.id,
      [
        "OPERATIONS_MANAGE",
        "NOTIFICATIONS_MANAGE",
        "EQUIPMENT_MANAGE",
        "QUALIFICATIONS_VERIFY",
      ],
      true,
      today,
    );
    expect(b.activeCallouts).toHaveLength(0);
    expect(b.failedNotifications).toBe(0);
    expect(b.equipment?.openDefects).toBe(0);
    expect(b.pendingSubmissions).toBe(0);
    expect(b.pendingInvitations).toBe(0);
  });
});
