import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Database-backed tests for the issue #15 incident record domain. They
 * run only via `npm run test:db` (DATABASE_URL present) — fixtures are
 * prefixed `inctest-` and cleaned up in afterAll.
 */

import { prisma } from "@/lib/prisma";
import { FakeNotificationProvider } from "@/lib/notifications/fake";
import {
  addIncidentAsset,
  addIncidentMember,
  addIncidentNote,
  correctIncidentNote,
  createIncident,
  getIncidentForAdmin,
  linkIncidentCallout,
  listOrganizationIncidents,
  removeIncidentAsset,
  removeIncidentMember,
  transitionIncidentStatus,
  updateIncident,
  CrossOrganizationIncidentError,
  IncidentCorrectionReasonError,
  IncidentDuplicateParticipantError,
  IncidentLinkedError,
} from "./incidents";
import { activateCallout } from "./callouts";
import { localDateTimeString } from "@/lib/dates";

const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "inctest-";

let counter = 0;
function uniq(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

let orgA: { id: string };
let orgB: { id: string };
let unitA: { id: string };
let unitB: { id: string };
let actorA: { id: string };
let memberA: { id: string; displayName: string };
let memberB: { id: string };
let assetA: { id: string; name: string };
let assetB: { id: string };

function makeDraft(
  input: Omit<Parameters<typeof createIncident>[1], "title"> = {},
) {
  return createIncident(
    orgA.id,
    { title: uniq("incident"), ...input },
    actorA.id,
  );
}

async function makeCallout(orgId: string, unitId: string) {
  return prisma.callout.create({
    data: {
      organizationId: orgId,
      unitId,
      title: uniq("callout"),
      audience: "ORGANIZATION",
      activationKey: uniq("key"),
      intentHash: uniq("intent"),
      createdByAuthIdentityId: actorA.id,
    },
  });
}

async function eventTypes(incidentId: string) {
  const events = await prisma.incidentTimelineEvent.findMany({
    where: { incidentId },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
  return events.map((e) => e.type);
}

describe.skipIf(!hasDb)("incidents (issue #15)", () => {
  beforeAll(async () => {
    // Pacific/Auckland exercises the wall-time parsing helpers against a
    // real non-UTC zone (and DST edge handling).
    orgA = await prisma.organization.create({
      data: { name: uniq("org-a"), timezone: "Pacific/Auckland" },
    });
    orgB = await prisma.organization.create({ data: { name: uniq("org-b") } });
    unitA = await prisma.unit.create({
      data: { organizationId: orgA.id, name: uniq("unit-a") },
    });
    unitB = await prisma.unit.create({
      data: { organizationId: orgB.id, name: uniq("unit-b") },
    });
    actorA = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("actor"),
        email: `${uniq("actor")}@example.test`,
      },
    });
    memberA = await prisma.member.create({
      data: { organizationId: orgA.id, displayName: uniq("member-a") },
    });
    memberB = await prisma.member.create({
      data: { organizationId: orgB.id, displayName: uniq("member-b") },
    });
    assetA = await prisma.asset.create({
      data: { organizationId: orgA.id, name: uniq("asset-a") },
    });
    assetB = await prisma.asset.create({
      data: { organizationId: orgB.id, name: uniq("asset-b") },
    });
  });

  afterAll(async () => {
    const orgFilter = { organization: { name: { startsWith: PREFIX } } };
    // Append-only children first (Restrict edges), then incidents, then
    // callouts/notifications, then members/assets/units/orgs.
    await prisma.incidentNoteCorrection.deleteMany({ where: orgFilter });
    await prisma.incidentNote.deleteMany({ where: orgFilter });
    await prisma.incidentTimelineEvent.deleteMany({ where: orgFilter });
    await prisma.incidentChange.deleteMany({ where: orgFilter });
    await prisma.incidentMember.deleteMany({ where: orgFilter });
    await prisma.incidentAsset.deleteMany({ where: orgFilter });
    await prisma.incidentSequence.deleteMany({ where: orgFilter });
    await prisma.incident.deleteMany({ where: orgFilter });
    await prisma.calloutResponseChange.deleteMany({ where: orgFilter });
    await prisma.calloutInvitation.deleteMany({ where: orgFilter });
    await prisma.callout.deleteMany({ where: orgFilter });
    await prisma.notificationAttempt.deleteMany({ where: orgFilter });
    await prisma.notification.deleteMany({ where: orgFilter });
    await prisma.memberNotificationPreference.deleteMany({ where: orgFilter });
    await prisma.member.deleteMany({ where: orgFilter });
    await prisma.asset.deleteMany({ where: orgFilter });
    await prisma.unit.deleteMany({ where: orgFilter });
    await prisma.authIdentity.deleteMany({
      where: { providerUid: { startsWith: PREFIX } },
    });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  /* ---------------- creation ---------------- */

  it("creates a manual incident in DRAFT with an org-scoped reference", async () => {
    const a = await makeDraft({ summary: "Initial report text" });
    const b = await makeDraft();
    expect(a.status).toBe("DRAFT");
    expect(a.openedAt).toBeNull();
    expect(a.closedAt).toBeNull();
    expect(a.summary).toBe("Initial report text");
    expect(a.createdByAuthIdentityId).toBe(actorA.id);
    // References allocate monotonically per organization.
    const n = (r: string) => Number(r.split("-").at(-1));
    expect(a.reference).toMatch(/^INC-\d+$/);
    expect(n(b.reference)).toBe(n(a.reference) + 1);

    expect(await eventTypes(a.id)).toEqual(["INCIDENT_CREATED"]);
  });

  it("creates an incident linked to a callout without altering the callout", async () => {
    const callout = await makeCallout(orgA.id, unitA.id);
    const before = await prisma.callout.findUniqueOrThrow({
      where: { id: callout.id },
    });

    const incident = await makeDraft({ calloutId: callout.id });
    expect(incident.calloutId).toBe(callout.id);
    expect(await eventTypes(incident.id)).toEqual([
      "INCIDENT_CREATED",
      "CALLOUT_LINKED",
    ]);

    // The callout's own history is untouched by the incident record.
    const after = await prisma.callout.findUniqueOrThrow({
      where: { id: callout.id },
    });
    expect(after).toEqual(before);
  });

  it("rejects foreign or fabricated callout ids opaquely", async () => {
    const foreign = await makeCallout(orgB.id, unitB.id);
    await expect(
      createIncident(orgA.id, { title: "x", calloutId: foreign.id }, actorA.id),
    ).rejects.toBeInstanceOf(CrossOrganizationIncidentError);
    await expect(
      createIncident(
        orgA.id,
        { title: "x", calloutId: "nonexistent" },
        actorA.id,
      ),
    ).rejects.toBeInstanceOf(CrossOrganizationIncidentError);
  });

  it("allows at most one incident per callout", async () => {
    const callout = await makeCallout(orgA.id, unitA.id);
    await makeDraft({ calloutId: callout.id });
    await expect(makeDraft({ calloutId: callout.id })).rejects.toBeInstanceOf(
      IncidentLinkedError,
    );
  });

  /* ---------------- lifecycle ---------------- */

  it("walks DRAFT → OPEN → CLOSED → OPEN recording each transition", async () => {
    const incident = await makeDraft();

    const opened = await transitionIncidentStatus(
      incident.id,
      "OPEN",
      actorA.id,
    );
    expect(opened.status).toBe("OPEN");
    expect(opened.openedAt).not.toBeNull();
    expect(opened.closedAt).toBeNull();

    const closed = await transitionIncidentStatus(
      incident.id,
      "CLOSED",
      actorA.id,
    );
    expect(closed.status).toBe("CLOSED");
    expect(closed.closedAt).not.toBeNull();
    expect(closed.closedByAuthIdentityId).toBe(actorA.id);

    const reopened = await transitionIncidentStatus(
      incident.id,
      "OPEN",
      actorA.id,
    );
    expect(reopened.status).toBe("OPEN");
    expect(reopened.closedAt).toBeNull();
    expect(reopened.closedByAuthIdentityId).toBeNull();

    const events = await prisma.incidentTimelineEvent.findMany({
      where: { incidentId: incident.id, type: "STATUS_CHANGED" },
      orderBy: { createdAt: "asc" },
    });
    expect(
      events.map((e) => (e.metadata as { from: string; to: string }).to),
    ).toEqual(["OPEN", "CLOSED", "OPEN"]);
    expect((events[0]!.metadata as { from: string }).from).toBe("DRAFT");
  });

  it("treats a transition to the current status as a quiet no-op", async () => {
    const incident = await makeDraft();
    await transitionIncidentStatus(incident.id, "OPEN", actorA.id);
    await transitionIncidentStatus(incident.id, "OPEN", actorA.id);
    expect(
      await prisma.incidentTimelineEvent.count({
        where: { incidentId: incident.id, type: "STATUS_CHANGED" },
      }),
    ).toBe(1);
  });

  it("records exactly one close event under concurrent closes", async () => {
    const incident = await makeDraft();
    await transitionIncidentStatus(incident.id, "OPEN", actorA.id);
    await Promise.all([
      transitionIncidentStatus(incident.id, "CLOSED", actorA.id),
      transitionIncidentStatus(incident.id, "CLOSED", actorA.id),
    ]);
    expect(
      await prisma.incidentTimelineEvent.count({
        where: { incidentId: incident.id, type: "STATUS_CHANGED" },
      }),
    ).toBe(2); // the open + exactly one close
  });

  /* ---------------- participants ---------------- */

  it("records members and assets explicitly, denying foreign ids", async () => {
    const incident = await makeDraft();

    const pm = await addIncidentMember(
      incident.id,
      { memberId: memberA.id, roleNote: "Crew" },
      actorA.id,
    );
    expect(pm.organizationId).toBe(orgA.id);
    expect(pm.roleNote).toBe("Crew");
    expect(pm.recordedByAuthIdentityId).toBe(actorA.id);

    const pa = await addIncidentAsset(
      incident.id,
      { assetId: assetA.id, note: "Tow" },
      actorA.id,
    );
    expect(pa.organizationId).toBe(orgA.id);

    await expect(
      addIncidentMember(incident.id, { memberId: memberB.id }, actorA.id),
    ).rejects.toBeInstanceOf(CrossOrganizationIncidentError);
    await expect(
      addIncidentAsset(incident.id, { assetId: assetB.id }, actorA.id),
    ).rejects.toBeInstanceOf(CrossOrganizationIncidentError);
    await expect(
      addIncidentMember(incident.id, { memberId: memberA.id }, actorA.id),
    ).rejects.toBeInstanceOf(IncidentDuplicateParticipantError);

    expect(await eventTypes(incident.id)).toEqual([
      "INCIDENT_CREATED",
      "MEMBER_ADDED",
      "ASSET_ADDED",
    ]);
  });

  it("removes a participant row while preserving the timeline facts", async () => {
    const incident = await makeDraft();
    const pm = await addIncidentMember(
      incident.id,
      { memberId: memberA.id },
      actorA.id,
    );
    const pa = await addIncidentAsset(
      incident.id,
      { assetId: assetA.id },
      actorA.id,
    );

    await removeIncidentMember(pm.id, actorA.id);
    await removeIncidentAsset(pa.id, actorA.id);

    expect(
      await prisma.incidentMember.findUnique({ where: { id: pm.id } }),
    ).toBeNull();
    expect(
      await prisma.incidentAsset.findUnique({ where: { id: pa.id } }),
    ).toBeNull();
    expect(await eventTypes(incident.id)).toEqual([
      "INCIDENT_CREATED",
      "MEMBER_ADDED",
      "ASSET_ADDED",
      "MEMBER_REMOVED",
      "ASSET_REMOVED",
    ]);
    await expect(removeIncidentMember(pm.id, actorA.id)).rejects.toBeInstanceOf(
      CrossOrganizationIncidentError,
    );
  });

  it("lets at most one of two concurrent identical participant adds win", async () => {
    const incident = await makeDraft();
    const results = await Promise.allSettled([
      addIncidentMember(incident.id, { memberId: memberA.id }, actorA.id),
      addIncidentMember(incident.id, { memberId: memberA.id }, actorA.id),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      await prisma.incidentMember.count({ where: { incidentId: incident.id } }),
    ).toBe(1);
  });

  it("never infers participation from callout responses", async () => {
    const provider = new FakeNotificationProvider();
    const responder = await prisma.member.create({
      data: { organizationId: orgA.id, displayName: uniq("responder") },
    });
    const { callout } = await activateCallout(
      orgA.id,
      {
        title: uniq("callout"),
        audience: "MEMBERS",
        memberIds: [responder.id],
        activationKey: uniq("k"),
      },
      actorA.id,
      { provider },
    );
    await prisma.calloutInvitation.update({
      where: {
        calloutId_memberId: {
          calloutId: callout.id,
          memberId: responder.id,
        },
      },
      data: { response: "COMING", respondedAt: new Date() },
    });

    const incident = await makeDraft({ calloutId: callout.id });
    expect(
      await prisma.incidentMember.count({ where: { incidentId: incident.id } }),
    ).toBe(0);
  });

  /* ---------------- notes ---------------- */

  it("creates attributed notes in each kind", async () => {
    const incident = await makeDraft();
    const note = await addIncidentNote(
      incident.id,
      { body: "Spoke with the reporting party.", kind: "GENERAL" },
      actorA.id,
    );
    expect(note.authorAuthIdentityId).toBe(actorA.id);
    const after = await addIncidentNote(
      incident.id,
      { body: "After-action narrative.", kind: "AFTER_ACTION" },
      actorA.id,
    );
    expect(after.kind).toBe("AFTER_ACTION");
    await addIncidentNote(
      incident.id,
      { body: "Closing note.", kind: "CLOSING" },
      actorA.id,
    );
    expect(
      await prisma.incidentNote.count({ where: { incidentId: incident.id } }),
    ).toBe(3);
  });

  it("amends a note by appending a correction — the original survives", async () => {
    const incident = await makeDraft();
    const note = await addIncidentNote(
      incident.id,
      { body: "Vessel was a yacht.", kind: "GENERAL" },
      actorA.id,
    );
    const amended = await correctIncidentNote(
      note.id,
      {
        body: "Vessel was a launch, not a yacht.",
        reason: "Reporting party corrected",
      },
      actorA.id,
    );
    expect(amended.body).toBe("Vessel was a launch, not a yacht.");

    const corrections = await prisma.incidentNoteCorrection.findMany({
      where: { noteId: note.id },
    });
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.beforeBody).toBe("Vessel was a yacht.");
    expect(corrections[0]!.afterBody).toBe("Vessel was a launch, not a yacht.");
    expect(corrections[0]!.reason).toBe("Reporting party corrected");
    expect(corrections[0]!.actorAuthIdentityId).toBe(actorA.id);
  });

  it("treats an identical note body as a no-op", async () => {
    const incident = await makeDraft();
    const note = await addIncidentNote(
      incident.id,
      { body: "Nothing to change.", kind: "GENERAL" },
      actorA.id,
    );
    await correctIncidentNote(
      note.id,
      { body: "Nothing to change." },
      actorA.id,
    );
    expect(
      await prisma.incidentNoteCorrection.count({ where: { noteId: note.id } }),
    ).toBe(0);
  });

  /* ---------------- corrections / audit ---------------- */

  it("audits field changes with before/after and a persisted reason", async () => {
    const incident = await makeDraft();
    const newTitle = uniq("corrected");
    const updated = await updateIncident(
      incident.id,
      {
        title: newTitle,
        summary: "Revised report",
        reason: "Wrong vessel name in first report",
      },
      actorA.id,
    );
    expect(updated.title).toBe(newTitle);

    const change = await prisma.incidentChange.findFirstOrThrow({
      where: { incidentId: incident.id },
    });
    expect(change.beforeTitle).toBe(incident.title);
    expect(change.afterTitle).toBe(newTitle);
    expect(change.beforeSummary).toBeNull();
    expect(change.afterSummary).toBe("Revised report");
    expect(change.reason).toBe("Wrong vessel name in first report");
    expect(change.actorAuthIdentityId).toBe(actorA.id);

    const event = await prisma.incidentTimelineEvent.findFirstOrThrow({
      where: { incidentId: incident.id, type: "CORRECTION_RECORDED" },
    });
    expect((event.metadata as { changeId: string }).changeId).toBe(change.id);
  });

  it("creates no audit noise for an identical submission", async () => {
    const incident = await makeDraft({ summary: "Keep me" });
    const again = await updateIncident(
      incident.id,
      { title: incident.title, summary: "Keep me" },
      actorA.id,
    );
    expect(again.title).toBe(incident.title);
    expect(
      await prisma.incidentChange.count({ where: { incidentId: incident.id } }),
    ).toBe(0);
    expect(
      await prisma.incidentTimelineEvent.count({
        where: { incidentId: incident.id, type: "CORRECTION_RECORDED" },
      }),
    ).toBe(0);
  });

  it("parses entered timestamps as wall time in the org timezone", async () => {
    const incident = await makeDraft({
      reportedAt: "2026-09-15T14:00",
      departedAt: "2026-09-15T14:30",
      onSceneAt: "2026-09-15T15:10",
      returnedAt: "2026-09-15T16:45",
    });
    // NZST is UTC+12 in September — 14:00 wall time → 02:00Z.
    expect(incident.reportedAt!.toISOString()).toBe("2026-09-15T02:00:00.000Z");
    // And the datetime-local renderer round-trips it.
    expect(localDateTimeString(incident.reportedAt, "Pacific/Auckland")).toBe(
      "2026-09-15T14:00",
    );
  });

  /* ---------------- closed-record corrections ---------------- */

  it("requires a reason for corrections once closed but keeps it closed", async () => {
    const incident = await makeDraft();
    await transitionIncidentStatus(incident.id, "CLOSED", actorA.id);

    await expect(
      updateIncident(incident.id, { title: uniq("closed-fix") }, actorA.id),
    ).rejects.toBeInstanceOf(IncidentCorrectionReasonError);

    const corrected = await updateIncident(
      incident.id,
      { title: uniq("closed-fix-2"), reason: "Typo in title" },
      actorA.id,
    );
    expect(corrected.status).toBe("CLOSED");
    expect(corrected.closedAt).not.toBeNull();
    expect(
      await prisma.incidentChange.count({ where: { incidentId: incident.id } }),
    ).toBe(1);
  });

  it("does not demand a reason for a no-change submission on a closed record", async () => {
    const incident = await makeDraft();
    await transitionIncidentStatus(incident.id, "CLOSED", actorA.id);
    const again = await updateIncident(
      incident.id,
      { title: incident.title },
      actorA.id,
    );
    expect(again.title).toBe(incident.title);
    expect(
      await prisma.incidentChange.count({ where: { incidentId: incident.id } }),
    ).toBe(0);
  });

  it("serializes concurrent corrections into a consistent audit chain", async () => {
    const incident = await makeDraft();
    const t1 = uniq("title-1");
    const t2 = uniq("title-2");
    await Promise.all([
      updateIncident(incident.id, { title: t1 }, actorA.id),
      updateIncident(incident.id, { title: t2 }, actorA.id),
    ]);
    const changes = await prisma.incidentChange.findMany({
      where: { incidentId: incident.id },
      orderBy: { createdAt: "asc" },
    });
    // The row lock serializes the two corrections: each change's `before`
    // equals the previous change's `after` — no lost updates, no torn rows.
    expect(changes).toHaveLength(2);
    expect(changes[0]!.beforeTitle).toBe(incident.title);
    expect(changes[0]!.afterTitle).toBe(changes[1]!.beforeTitle);
    const final = await prisma.incident.findUniqueOrThrow({
      where: { id: incident.id },
    });
    expect(final.title).toBe(changes[1]!.afterTitle);
  });

  /* ---------------- callout linkage after creation ---------------- */

  it("links an unlinked callout once, then refuses any relink", async () => {
    const callout = await makeCallout(orgA.id, unitA.id);
    const incident = await makeDraft();
    const linked = await linkIncidentCallout(
      incident.id,
      callout.id,
      actorA.id,
    );
    expect(linked.calloutId).toBe(callout.id);

    const other = await makeCallout(orgA.id, unitA.id);
    await expect(
      linkIncidentCallout(incident.id, other.id, actorA.id),
    ).rejects.toBeInstanceOf(IncidentLinkedError);
  });

  /* ---------------- detail read / attribution ---------------- */

  it("resolves actor display names and falls back to the raw id after deletion", async () => {
    // Actor with a linked member → the member's displayName wins.
    const linkedIdentity = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("linked"),
        email: `${uniq("linked")}@example.test`,
      },
    });
    const linkedMember = await prisma.member.create({
      data: {
        organizationId: orgA.id,
        displayName: uniq("named"),
        authIdentityId: linkedIdentity.id,
      },
    });
    const byLinked = await makeDraft();
    await prisma.incident.update({
      where: { id: byLinked.id },
      data: { createdByAuthIdentityId: linkedIdentity.id },
    });
    let detail = await getIncidentForAdmin(byLinked.id);
    expect(detail?.createdByDisplay).toBe(linkedMember.displayName);

    // Identity deleted → history rows survive and render the raw id.
    const deletedIdentity = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("gone"),
        email: `${uniq("gone")}@example.test`,
      },
    });
    const byDeleted = await makeDraft();
    await prisma.incident.update({
      where: { id: byDeleted.id },
      data: { createdByAuthIdentityId: deletedIdentity.id },
    });
    await prisma.authIdentity.delete({ where: { id: deletedIdentity.id } });
    detail = await getIncidentForAdmin(byDeleted.id);
    expect(detail?.createdByDisplay).toBe(deletedIdentity.id);
  });

  it("builds a deterministic feed mixing system events and human notes", async () => {
    const incident = await makeDraft();
    await addIncidentNote(
      incident.id,
      {
        body: "Observation from before the record existed.",
        kind: "GENERAL",
        // A historical observation time, entered as org wall time.
        occurredAt: "2020-01-01T09:00",
      },
      actorA.id,
    );
    await addIncidentMember(incident.id, { memberId: memberA.id }, actorA.id);

    const detail = await getIncidentForAdmin(incident.id);
    expect(detail).not.toBeNull();
    // A note with a historical occurredAt sorts before the system events
    // recorded "now" — occurredAt (when it happened) and createdAt (when
    // SARbase recorded it) are deliberately distinct.
    expect(detail!.feed.map((f) => f.kind)).toEqual(["note", "event", "event"]);
    const created = detail!.feed[1]!;
    expect(created.kind).toBe("event");
    if (created.kind === "event") {
      expect(created.event.type).toBe("INCIDENT_CREATED");
    }

    // List view summary shape.
    const listed = await listOrganizationIncidents(orgA.id);
    const row = listed.find((i) => i.id === incident.id);
    expect(row?._count.members).toBe(1);
    expect(row?._count.notes).toBe(1);
  });
});
