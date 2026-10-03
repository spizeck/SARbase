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
  listTrainingAttendanceChanges,
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
// The audit actor is a plain stored reference (no FK) — a domain-level
// test needs no real AuthIdentity row. Server actions derive it from
// the authenticated context; see authz.db.test.ts.
const ACTOR = "test-actor-identity";

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
    await prisma.trainingAttendanceChange.deleteMany({
      where: { event: orgFilter },
    });
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
    await prisma.member.updateMany({
      where: orgFilter,
      data: { authIdentityId: null },
    });
    await prisma.authIdentity.deleteMany({
      where: { providerUid: { startsWith: PREFIX } },
    });
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

    await setTrainingAttendance(event.id, [memberA.id], ACTOR);
    let full = await getTrainingEvent(event.id);
    expect(full?.attendances.map((a) => a.memberId)).toEqual([memberA.id]);

    // Re-sync with the same id is idempotent — no duplicate pair.
    await setTrainingAttendance(event.id, [memberA.id], ACTOR);
    full = await getTrainingEvent(event.id);
    expect(full?.attendances).toHaveLength(1);

    // Cross-org member rejected at domain level…
    await expect(
      setTrainingAttendance(event.id, [memberA.id, memberB.id], ACTOR),
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
    await setTrainingAttendance(real.id, [member.id], ACTOR);
    await setTrainingAttendance(cancelled.id, [member.id], ACTOR);

    await setTrainingEventStatus(cancelled.id, "CANCELLED");

    // Attendance rows preserved, but summary counts only completed events.
    const history = await listMemberTraining(member.id);
    expect(history).toHaveLength(2);
    const summary = await getMemberTrainingSummary(member.id);
    expect(summary.attendedCount).toBe(1);
    expect(summary.lastAttendedOn).toEqual(D("2027-01-10"));

    // Attendance cannot be edited while cancelled.
    await expect(
      setTrainingAttendance(cancelled.id, [], ACTOR),
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
    await setTrainingAttendance(older.id, [member.id], ACTOR);
    await setTrainingAttendance(newer.id, [member.id], ACTOR);

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
    await setTrainingAttendance(e1.id, [member.id], ACTOR);
    await setTrainingAttendance(e2.id, [member.id], ACTOR);

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
    await setTrainingAttendance(event.id, [member.id], ACTOR);

    const { setMemberStatus } = await import("@/lib/domain/member");
    await setMemberStatus(member.id, "INACTIVE");
    expect(await listMemberTraining(member.id)).toHaveLength(1);
    expect((await getMemberTrainingSummary(member.id)).attendedCount).toBe(1);
  });

  it("a member who led an event cannot be hard-deleted; deactivation is unaffected", async () => {
    const org = await createTestOrg("lead-restrict");
    const lead = await createMember(org.id, {
      displayName: uniqueName("lead"),
    });
    const event = await createTrainingEvent(org.id, {
      title: "Led drill",
      date: D("2027-03-01"),
      leadMemberId: lead.id,
      topics: [],
    });

    // Issue #29 — Restrict, like every other member reference: the lead
    // pointer is recorded history, so the member row cannot be
    // hard-deleted underneath it. (The previous SetNull could never
    // have applied cleanly anyway — the composite FK includes the
    // required organizationId.)
    await expect(
      prisma.member.delete({ where: { id: lead.id } }),
    ).rejects.toThrow();

    // Deactivation — the supported member lifecycle — is unaffected,
    // and the event keeps its lead pointer.
    const { setMemberStatus } = await import("@/lib/domain/member");
    await setMemberStatus(lead.id, "INACTIVE");
    const full = await getTrainingEvent(event.id);
    expect(full?.leadMember?.id).toBe(lead.id);
  });

  it("filters to organization-wide events with the null unit filter", async () => {
    const org = await createTestOrg("orgwide");
    const unit = await createUnit(org.id, { name: uniqueName("unit") });
    const unitEvent = await createTrainingEvent(org.id, {
      title: "Unit event",
      date: D("2027-05-01"),
      unitId: unit.id,
      topics: [],
    });
    const orgEvent = await createTrainingEvent(org.id, {
      title: "Org-wide event",
      date: D("2027-05-02"),
      topics: [],
    });

    const orgWide = await listTrainingEvents(org.id, { unitId: null });
    expect(orgWide.map((e) => e.id)).toEqual([orgEvent.id]);

    // An unknown or foreign-organization unit id can only ever match
    // zero events — the org filter never widens.
    const orgB = await createTestOrg("orgwide-b");
    const foreignUnit = await createUnit(orgB.id, {
      name: uniqueName("unit-b"),
    });
    for (const bad of [foreignUnit.id, "no-such-unit"]) {
      expect(await listTrainingEvents(org.id, { unitId: bad })).toHaveLength(0);
    }
    // The unit event itself is unaffected in the unfiltered list.
    expect((await listTrainingEvents(org.id)).map((e) => e.id)).toEqual([
      orgEvent.id,
      unitEvent.id,
    ]);
  });

  describe("attendance audit history", () => {
    it("records ADDED and REMOVED as immutable rows, re-add appends", async () => {
      const org = await createTestOrg("audit");
      const memberA = await createMember(org.id, {
        displayName: uniqueName("m-a"),
      });
      const memberB = await createMember(org.id, {
        displayName: uniqueName("m-b"),
      });
      const event = await createTrainingEvent(org.id, {
        title: "Drill",
        date: D("2027-04-01"),
        topics: [],
      });

      // Add A and B — two ADDED audit rows, in one transaction.
      await setTrainingAttendance(event.id, [memberA.id, memberB.id], ACTOR);
      let history = await prisma.trainingAttendanceChange.findMany({
        where: { trainingEventId: event.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      expect(
        history.map((c) => [c.memberId, c.action, c.actorAuthIdentityId]),
      ).toEqual([
        [memberA.id, "ADDED", ACTOR],
        [memberB.id, "ADDED", ACTOR],
      ]);

      // Remove A — a REMOVED row; the earlier ADDED rows are preserved.
      await setTrainingAttendance(event.id, [memberB.id], ACTOR);
      history = await prisma.trainingAttendanceChange.findMany({
        where: { trainingEventId: event.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      expect(history.map((c) => [c.memberId, c.action])).toEqual([
        [memberA.id, "ADDED"],
        [memberB.id, "ADDED"],
        [memberA.id, "REMOVED"],
      ]);
      // The first rows are the same immutable records — no rewrite.
      expect(history[0]?.id).toBeDefined();

      // Re-add A — ANOTHER immutable row, not a rewrite of history.
      await setTrainingAttendance(event.id, [memberA.id, memberB.id], ACTOR);
      history = await prisma.trainingAttendanceChange.findMany({
        where: { trainingEventId: event.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      expect(history.map((c) => [c.memberId, c.action])).toEqual([
        [memberA.id, "ADDED"],
        [memberB.id, "ADDED"],
        [memberA.id, "REMOVED"],
        [memberA.id, "ADDED"],
      ]);
    });

    it("a no-op re-sync writes no audit rows", async () => {
      const org = await createTestOrg("audit-noop");
      const member = await createMember(org.id, {
        displayName: uniqueName("m"),
      });
      const event = await createTrainingEvent(org.id, {
        title: "Drill",
        date: D("2027-04-02"),
        topics: [],
      });
      await setTrainingAttendance(event.id, [member.id], ACTOR);
      await setTrainingAttendance(event.id, [member.id], ACTOR);
      expect(
        await prisma.trainingAttendanceChange.count({
          where: { trainingEventId: event.id },
        }),
      ).toBe(1);
    });

    it("audit history survives member deactivation and attendance removal", async () => {
      const org = await createTestOrg("audit-survive");
      const member = await createMember(org.id, {
        displayName: uniqueName("m"),
      });
      const event = await createTrainingEvent(org.id, {
        title: "Drill",
        date: D("2027-04-03"),
        topics: [],
      });
      await setTrainingAttendance(event.id, [member.id], ACTOR);

      const { setMemberStatus } = await import("@/lib/domain/member");
      await setMemberStatus(member.id, "INACTIVE");

      // Delete the CURRENT attendance row directly — audit rows remain.
      await prisma.trainingAttendance.deleteMany({
        where: { trainingEventId: event.id },
      });

      const history = await prisma.trainingAttendanceChange.findMany({
        where: { trainingEventId: event.id },
      });
      expect(history).toHaveLength(1);
      expect(history[0]?.action).toBe("ADDED");
      expect(history[0]?.memberId).toBe(member.id);
    });

    it("the database rejects a cross-organization audit row", async () => {
      const orgA = await createTestOrg("audit-x-a");
      const orgB = await createTestOrg("audit-x-b");
      const memberB = await createMember(orgB.id, {
        displayName: uniqueName("m-b"),
      });
      const eventA = await createTrainingEvent(orgA.id, {
        title: "A event",
        date: D("2027-04-04"),
        topics: [],
      });
      const eventB = await createTrainingEvent(orgB.id, {
        title: "B event",
        date: D("2027-04-04"),
        topics: [],
      });
      const memberA = await createMember(orgA.id, {
        displayName: uniqueName("m-a"),
      });

      // Org-A event paired with org-B member: composite FK rejects.
      await expect(
        prisma.trainingAttendanceChange.create({
          data: {
            organizationId: orgA.id,
            trainingEventId: eventA.id,
            memberId: memberB.id,
            actorAuthIdentityId: ACTOR,
            action: "ADDED",
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
      // Org-B event with an org-A organizationId claims: rejected too.
      await expect(
        prisma.trainingAttendanceChange.create({
          data: {
            organizationId: orgA.id,
            trainingEventId: eventB.id,
            memberId: memberA.id,
            actorAuthIdentityId: ACTOR,
            action: "ADDED",
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("resolves the actor to a friendly name, with a safe fallback", async () => {
      const org = await createTestOrg("audit-actor");
      const identity = await prisma.authIdentity.create({
        data: {
          provider: "firebase",
          providerUid: uniqueName("uid-actor"),
          email: `${uniqueName("actor")}@example.org`,
        },
      });
      const member = await createMember(org.id, {
        displayName: uniqueName("m"),
      });
      const actorMember = await prisma.member.create({
        data: {
          organizationId: org.id,
          displayName: uniqueName("actor-member"),
          authIdentityId: identity.id,
        },
      });
      const event = await createTrainingEvent(org.id, {
        title: "Drill",
        date: D("2027-04-05"),
        topics: [],
      });

      // Real identity → resolves to the linked member's display name.
      await setTrainingAttendance(event.id, [member.id], identity.id);
      // Unknown actor (identity later deleted) → falls back to null
      // actorDisplayName; the row and raw id remain.
      await setTrainingAttendance(
        event.id,
        [member.id, actorMember.id],
        "deleted-identity-ref",
      );

      const history = await listTrainingAttendanceChanges(event.id);
      expect(history).toHaveLength(2);
      expect(history[0]?.actorDisplayName).toBe(actorMember.displayName);
      expect(history[1]?.actorDisplayName).toBeNull();
      expect(history[1]?.actorAuthIdentityId).toBe("deleted-identity-ref");
    });

    it("cancelled events cannot gain or lose attendance or audit rows", async () => {
      const org = await createTestOrg("audit-cancel");
      const member = await createMember(org.id, {
        displayName: uniqueName("m"),
      });
      const event = await createTrainingEvent(org.id, {
        title: "Was real",
        date: D("2027-04-06"),
        topics: [],
      });
      await setTrainingAttendance(event.id, [member.id], ACTOR);
      await setTrainingEventStatus(event.id, "CANCELLED");

      await expect(
        setTrainingAttendance(event.id, [], ACTOR),
      ).rejects.toBeInstanceOf(CancelledTrainingError);
      expect(
        await prisma.trainingAttendanceChange.count({
          where: { trainingEventId: event.id },
        }),
      ).toBe(1); // only the pre-cancellation ADDED row
      expect(
        await prisma.trainingAttendance.count({
          where: { trainingEventId: event.id },
        }),
      ).toBe(1); // attendance preserved, just not editable
    });
  });
});
