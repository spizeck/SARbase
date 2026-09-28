import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { createMember } from "@/lib/domain/member";
import { createOrganization } from "@/lib/domain/organization";
import { createUnit } from "@/lib/domain/unit";
import {
  createTrainingEvent,
  getMemberTrainingSummary,
  getTrainingEvent,
  listMemberTraining,
  listTrainingEvents,
  setTrainingAttendance,
  setTrainingEventStatus,
  updateTrainingEvent,
  CrossOrganizationTrainingError,
  CancelledTrainingError,
} from "@/lib/domain/training";

/**
 * Database-backed training tests — `npm run test:db` only.
 * Distinct prefix: files may run on parallel workers, so cleanup must
 * never touch another suite's fixtures.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "traintest-";

let counter = 0;
function uniqueName(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

async function createTestOrg(suffix = "org") {
  return createOrganization({ name: uniqueName(suffix) });
}

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe.skipIf(!hasDb)("training domain", () => {
  afterAll(async () => {
    const orgFilter = { organization: { name: { startsWith: PREFIX } } };
    await prisma.trainingAttendance.deleteMany({
      where: { member: orgFilter },
    });
    await prisma.trainingTopic.deleteMany({
      where: { event: orgFilter },
    });
    await prisma.trainingEvent.updateMany({
      where: orgFilter,
      data: { leadMemberId: null },
    });
    await prisma.trainingEvent.deleteMany({ where: orgFilter });
    await prisma.member.deleteMany({ where: orgFilter });
    await prisma.unit.deleteMany({ where: orgFilter });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  it("creates an event scoped to its org, with topics as rows", async () => {
    const org = await createTestOrg("ev");
    const unit = await createUnit(org.id, { name: uniqueName("unit") });
    const lead = await createMember(org.id, {
      displayName: uniqueName("lead"),
    });

    const event = await createTrainingEvent(org.id, {
      title: "Anchor handling",
      date: D("2027-03-10"),
      unitId: unit.id,
      durationMinutes: 120,
      location: "Harbor",
      instructorName: "External trainer",
      leadMemberId: lead.id,
      topics: ["anchors", "Radio", "anchors"],
    });

    expect(event.organizationId).toBe(org.id);
    const full = await getTrainingEvent(event.id);
    expect(full?.unit?.id).toBe(unit.id);
    expect(full?.leadMember?.id).toBe(lead.id);
    // case-insensitive dedupe: "anchors" once
    expect(full?.topics.map((t) => t.label).sort()).toEqual([
      "Radio",
      "anchors",
    ]);
  });

  it("rejects cross-org unit and lead references (domain + DB)", async () => {
    const orgA = await createTestOrg("x-a");
    const orgB = await createTestOrg("x-b");
    const unitB = await createUnit(orgB.id, { name: uniqueName("unit-b") });
    const memberB = await createMember(orgB.id, {
      displayName: uniqueName("member-b"),
    });

    await expect(
      createTrainingEvent(orgA.id, {
        title: "T",
        date: D("2027-01-01"),
        unitId: unitB.id,
        topics: [],
      }),
    ).rejects.toBeInstanceOf(CrossOrganizationTrainingError);
    await expect(
      createTrainingEvent(orgA.id, {
        title: "T",
        date: D("2027-01-01"),
        leadMemberId: memberB.id,
        topics: [],
      }),
    ).rejects.toBeInstanceOf(CrossOrganizationTrainingError);

    // And at the database level even if the app check were bypassed.
    await expect(
      prisma.trainingEvent.create({
        data: {
          organizationId: orgA.id,
          title: "T",
          date: D("2027-01-01"),
          unitId: unitB.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("records attendance and rejects duplicates and cross-org rows", async () => {
    const orgA = await createTestOrg("att-a");
    const orgB = await createTestOrg("att-b");
    const memberA = await createMember(orgA.id, {
      displayName: uniqueName("m-a"),
    });
    const memberB = await createMember(orgB.id, {
      displayName: uniqueName("m-b"),
    });
    const event = await createTrainingEvent(orgA.id, {
      title: "Drill",
      date: D("2027-04-01"),
      topics: [],
    });

    await setTrainingAttendance(event.id, [memberA.id]);
    let full = await getTrainingEvent(event.id);
    expect(full?.attendances.map((a) => a.memberId)).toEqual([memberA.id]);

    // Re-sync with the same id is idempotent — no duplicate pair.
    await setTrainingAttendance(event.id, [memberA.id]);
    full = await getTrainingEvent(event.id);
    expect(full?.attendances).toHaveLength(1);

    // Cross-org member rejected at domain level…
    await expect(
      setTrainingAttendance(event.id, [memberA.id, memberB.id]),
    ).rejects.toBeInstanceOf(CrossOrganizationTrainingError);
    // …and at the database level (composite FK).
    await expect(
      prisma.trainingAttendance.create({
        data: {
          organizationId: orgA.id,
          trainingEventId: event.id,
          memberId: memberB.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });

    // Direct duplicate pair insert rejected.
    await expect(
      prisma.trainingAttendance.create({
        data: {
          organizationId: orgA.id,
          trainingEventId: event.id,
          memberId: memberA.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("edits preserve row identity and sync topics", async () => {
    const org = await createTestOrg("edit");
    const event = await createTrainingEvent(org.id, {
      title: "Old title",
      date: D("2027-02-01"),
      topics: ["a", "b"],
    });

    const updated = await updateTrainingEvent(event.id, {
      title: "New title",
      date: D("2027-02-02"),
      durationMinutes: 60,
      topics: ["b", "c"],
    });
    expect(updated.id).toBe(event.id);

    const full = await getTrainingEvent(event.id);
    expect(full?.title).toBe("New title");
    expect(full?.topics.map((t) => t.label).sort()).toEqual(["b", "c"]);
  });

  it("cancelled events keep attendance history but count as not attended", async () => {
    const org = await createTestOrg("cancel");
    const member = await createMember(org.id, {
      displayName: uniqueName("m"),
    });
    const real = await createTrainingEvent(org.id, {
      title: "Happened",
      date: D("2027-01-10"),
      topics: [],
    });
    const cancelled = await createTrainingEvent(org.id, {
      title: "Did not happen",
      date: D("2027-02-10"),
      topics: [],
    });
    await setTrainingAttendance(real.id, [member.id]);
    await setTrainingAttendance(cancelled.id, [member.id]);

    await setTrainingEventStatus(cancelled.id, "CANCELLED");

    // Attendance rows preserved, but summary counts only completed events.
    const history = await listMemberTraining(member.id);
    expect(history).toHaveLength(2);
    const summary = await getMemberTrainingSummary(member.id);
    expect(summary.attendedCount).toBe(1);
    expect(summary.lastAttendedOn).toEqual(D("2027-01-10"));

    // Attendance cannot be edited while cancelled.
    await expect(
      setTrainingAttendance(cancelled.id, []),
    ).rejects.toBeInstanceOf(CancelledTrainingError);

    // Listing defaults exclude cancelled events unless asked for.
    expect((await listTrainingEvents(org.id)).map((e) => e.id)).toEqual([
      real.id,
    ]);
    expect(
      (await listTrainingEvents(org.id, { includeCancelled: true })).length,
    ).toBe(2);
  });

  it("orders events by date desc and member history likewise", async () => {
    const org = await createTestOrg("order");
    const member = await createMember(org.id, {
      displayName: uniqueName("m"),
    });
    const older = await createTrainingEvent(org.id, {
      title: "Older",
      date: D("2026-06-01"),
      topics: [],
    });
    const newer = await createTrainingEvent(org.id, {
      title: "Newer",
      date: D("2027-06-01"),
      topics: [],
    });
    await setTrainingAttendance(older.id, [member.id]);
    await setTrainingAttendance(newer.id, [member.id]);

    const events = await listTrainingEvents(org.id);
    expect(events.map((e) => e.id)).toEqual([newer.id, older.id]);

    const history = await listMemberTraining(member.id);
    expect(history.map((h) => h.event.id)).toEqual([newer.id, older.id]);
  });

  it("date-window filtering and per-period counts are factual", async () => {
    const org = await createTestOrg("window");
    const member = await createMember(org.id, {
      displayName: uniqueName("m"),
    });
    const e1 = await createTrainingEvent(org.id, {
      title: "Jan",
      date: D("2027-01-15"),
      topics: [],
    });
    const e2 = await createTrainingEvent(org.id, {
      title: "Jun",
      date: D("2027-06-15"),
      topics: [],
    });
    await setTrainingAttendance(e1.id, [member.id]);
    await setTrainingAttendance(e2.id, [member.id]);

    const inWindow = await listTrainingEvents(org.id, {
      from: D("2027-06-01"),
      to: D("2027-06-30"),
    });
    expect(inWindow.map((e) => e.id)).toEqual([e2.id]);

    const summary = await getMemberTrainingSummary(member.id, {
      from: D("2027-06-01"),
      to: D("2027-06-30"),
    });
    expect(summary.attendedCount).toBe(1);
    const all = await getMemberTrainingSummary(member.id);
    expect(all.attendedCount).toBe(2);
    expect(all.lastAttendedOn).toEqual(D("2027-06-15"));
  });

  it("unit filter narrows org event lists", async () => {
    const org = await createTestOrg("ufilter");
    const unit = await createUnit(org.id, { name: uniqueName("unit") });
    const unitEvent = await createTrainingEvent(org.id, {
      title: "Unit event",
      date: D("2027-05-01"),
      unitId: unit.id,
      topics: [],
    });
    await createTrainingEvent(org.id, {
      title: "Org event",
      date: D("2027-05-02"),
      topics: [],
    });

    const unitEvents = await listTrainingEvents(org.id, { unitId: unit.id });
    expect(unitEvents.map((e) => e.id)).toEqual([unitEvent.id]);
  });

  it("inactive member retains training history", async () => {
    const org = await createTestOrg("inactive");
    const member = await createMember(org.id, {
      displayName: uniqueName("m"),
    });
    const event = await createTrainingEvent(org.id, {
      title: "Kept",
      date: D("2027-03-01"),
      topics: [],
    });
    await setTrainingAttendance(event.id, [member.id]);

    const { setMemberStatus } = await import("@/lib/domain/member");
    await setMemberStatus(member.id, "INACTIVE");
    expect(await listMemberTraining(member.id)).toHaveLength(1);
    expect((await getMemberTrainingSummary(member.id)).attendedCount).toBe(1);
  });
});
