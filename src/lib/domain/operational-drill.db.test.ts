import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  activateCallout,
  closeCallout,
  getCalloutForAdmin,
  respondToCalloutToken,
  updateCallout,
} from "@/lib/domain/callouts";
import {
  recordMemberAvailability,
  setMemberContactPreference,
  setMemberWhatsappConsent,
} from "@/lib/domain/availability";
import {
  addIncidentAsset,
  addIncidentMember,
  addIncidentNote,
  createIncident,
  getIncidentForAdmin,
} from "@/lib/domain/incidents";
import { recordWhatsappDeliveryEvents } from "@/lib/domain/notification-delivery";
import {
  FakeNotificationProvider,
  fakeFailure,
} from "@/lib/notifications/fake";

/**
 * Simulated operational acceptance drill (pre-activation sprint).
 *
 * Runs the REAL domain workflows end-to-end on disposable data — the
 * same functions the server actions call — with the in-process fake
 * provider standing in for Meta. Nothing here touches a network or a
 * real member record. Fixture rows are prefixed `drill-`.
 *
 * The drill asserts the product boundary at every step: delivery
 * callbacks are provider facts, never member responses; a DELIVERED
 * alert with no response is still outstanding; audit history preserves
 * both the original text and the correction.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "drill-";

let counter = 0;
const uniq = (suffix: string) => `${PREFIX}${++counter}-${suffix}`;

function tokenFromCall(text: string | null | undefined): string {
  const match = [...(text ?? "").matchAll(/\/respond\?t=([A-Za-z0-9_-]+)/g)].at(
    -1,
  );
  if (!match) throw new Error("no response URL in provider call");
  return decodeURIComponent(match[1]!);
}

describe.skipIf(!hasDb)("simulated operational drill", () => {
  let org: { id: string };
  let actor: { id: string };

  beforeAll(async () => {
    org = await prisma.organization.create({ data: { name: uniq("org") } });
    actor = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("coordinator"),
        email: `${uniq("coordinator")}@example.test`,
      },
    });
  });

  afterAll(async () => {
    const orgFilter = { organization: { name: { startsWith: PREFIX } } };
    await prisma.incidentNoteCorrection.deleteMany({ where: orgFilter });
    await prisma.incidentNote.deleteMany({ where: orgFilter });
    await prisma.incidentTimelineEvent.deleteMany({ where: orgFilter });
    await prisma.incidentChange.deleteMany({ where: orgFilter });
    await prisma.incidentMember.deleteMany({ where: orgFilter });
    await prisma.incidentAsset.deleteMany({ where: orgFilter });
    await prisma.incidentSequence.deleteMany({ where: orgFilter });
    await prisma.incident.deleteMany({ where: orgFilter });
    await prisma.calloutResponseChange.deleteMany({ where: orgFilter });
    await prisma.calloutChange.deleteMany({ where: orgFilter });
    await prisma.calloutInvitation.deleteMany({ where: orgFilter });
    await prisma.callout.deleteMany({ where: orgFilter });
    await prisma.notificationDeliveryEvent.deleteMany({
      where: orgFilter,
    });
    await prisma.notificationAttempt.deleteMany({ where: orgFilter });
    await prisma.notification.deleteMany({ where: orgFilter });
    await prisma.memberContactChange.deleteMany({ where: orgFilter });
    await prisma.memberNotificationPreference.deleteMany({
      where: orgFilter,
    });
    await prisma.memberAvailabilityUpdate.deleteMany({ where: orgFilter });
    await prisma.asset.deleteMany({ where: orgFilter });
    await prisma.member.deleteMany({ where: orgFilter });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
    await prisma.authIdentity.deleteMany({
      where: { providerUid: { startsWith: PREFIX } },
    });
  });

  async function makeResponder(suffix: string, phoneSuffix: number) {
    const member = await prisma.member.create({
      data: {
        organizationId: org.id,
        displayName: uniq(suffix),
        email: `${uniq(suffix)}@example.test`,
        phone: `+599416${String(phoneSuffix).padStart(4, "0")}`,
      },
    });
    await setMemberContactPreference(member.id, {
      notifyEmail: true,
      notifySms: false,
      notifyWhatsapp: true,
      notifyPush: false,
      preferredChannel: "WHATSAPP",
    });
    await setMemberWhatsappConsent(member.id, true, actor.id);
    return member;
  }

  it("runs a complete callout-to-incident drill with auditable corrections", async () => {
    // --- Members in different states ---------------------------------
    const coming = await makeResponder("coming", 1);
    const declining = await makeResponder("declining", 2);
    // Delivered but never responds — outstanding at the end.
    const silent = await makeResponder("silent", 3);
    // Provider rejects the send — a delivery failure, not a response.
    const unreachable = await makeResponder("unreachable", 4);

    await recordMemberAvailability(
      coming.id,
      { status: "AVAILABLE", note: "at the harbor" },
      actor.id,
      { selfReported: true },
    );
    await recordMemberAvailability(
      declining.id,
      { status: "UNAVAILABLE" },
      actor.id,
      { selfReported: true },
    );
    // `silent` and `unreachable` make no statement — UNKNOWN.

    // --- Coordinator activates the callout ---------------------------
    // Sends are scripted in memberIds order: three accepted, the last
    // rejected. Scripted results are returned verbatim, so wamids are
    // explicit.
    const provider = new FakeNotificationProvider({
      results: [
        { status: "accepted", providerMessageId: "wamid-coming" },
        { status: "accepted", providerMessageId: "wamid-declining" },
        { status: "accepted", providerMessageId: "wamid-silent" },
        fakeFailure.rejected("simulated provider outage"),
      ],
    });
    const { callout } = await activateCallout(
      org.id,
      {
        title: uniq("missing-hiker"),
        message: "Hiker overdue on Mt. Scenery trail.",
        audience: "MEMBERS",
        memberIds: [coming.id, declining.id, silent.id, unreachable.id],
        activationKey: uniq("key"),
      },
      actor.id,
      { provider },
    );

    const invitations = await prisma.calloutInvitation.findMany({
      where: { calloutId: callout.id },
      include: { notification: true },
    });
    expect(invitations).toHaveLength(4);
    const statuses = invitations.map((i) => i.notification?.status).sort();
    expect(statuses).toEqual(["ACCEPTED", "ACCEPTED", "ACCEPTED", "FAILED"]);
    // The failed send is a recorded fact — not a lost write.
    const failed = invitations.find(
      (i) => i.notification?.status === "FAILED",
    )!;
    const failedAttempt = await prisma.notificationAttempt.findFirstOrThrow({
      where: { notificationId: failed.notification!.id },
    });
    expect(failedAttempt.status).toBe("FAILED");
    expect(failedAttempt.errorCode).toBeTruthy();

    // --- Delivery callbacks: duplicates + out-of-order ---------------
    const t0 = new Date("2026-10-17T12:00:00Z");
    const event = (wamid: string, status: "SENT" | "DELIVERED", s: number) => ({
      providerMessageId: wamid,
      status,
      occurredAt: new Date(t0.getTime() + s * 1000),
      providerErrorCode: null,
    });
    const ingest = await recordWhatsappDeliveryEvents([
      event("wamid-coming", "SENT", 1),
      event("wamid-coming", "DELIVERED", 5),
      event("wamid-coming", "DELIVERED", 5), // exact replay — deduplicated
      event("wamid-coming", "SENT", 9), // stale state — must not downgrade
      event("wamid-declining", "SENT", 2),
      event("wamid-declining", "DELIVERED", 8),
      event("wamid-silent", "SENT", 3),
      event("wamid-silent", "DELIVERED", 6),
    ]);
    expect(ingest.deduplicated).toBe(1);
    const attempts = await prisma.notificationAttempt.findMany({
      where: { providerMessageId: { startsWith: "wamid-" } },
    });
    expect(attempts.map((a) => a.deliveryStatus).sort()).toEqual([
      "DELIVERED",
      "DELIVERED",
      "DELIVERED",
    ]);

    // Delivery is a provider fact — nothing above touched a response.
    expect(
      await prisma.calloutInvitation.count({
        where: { calloutId: callout.id, response: { not: null } },
      }),
    ).toBe(0);

    // --- Member responses --------------------------------------------
    const callByTo = new Map(provider.calls.map((c) => [c.to, c]));
    const phoneOf = (m: { phone: string | null }) =>
      (m.phone ?? "").replace(/^\+/, "");
    await respondToCalloutToken(
      tokenFromCall(
        callByTo.get(phoneOf(coming))?.template?.parameters.join(" "),
      ),
      "COMING",
    );
    await respondToCalloutToken(
      tokenFromCall(
        callByTo.get(phoneOf(declining))?.template?.parameters.join(" "),
      ),
      "UNAVAILABLE",
    );

    // --- Coordinator's outstanding-response view ---------------------
    const adminView = await getCalloutForAdmin(callout.id);
    const byMember = new Map(
      adminView!.invitations.map((i) => [i.member.id, i]),
    );
    expect(byMember.get(coming.id)?.response).toBe("COMING");
    expect(byMember.get(declining.id)?.response).toBe("UNAVAILABLE");
    // `silent`: DELIVERED, still unanswered — delivery ≠ response.
    const silentInv = byMember.get(silent.id)!;
    expect(silentInv.response).toBeNull();
    expect(silentInv.notification?.attempts[0]?.deliveryStatus).toBe(
      "DELIVERED",
    );
    // `unreachable`: FAILED send, no response — a failure fact, not an
    // unanswered invitation.
    const unreachableInv = byMember.get(unreachable.id)!;
    expect(unreachableInv.response).toBeNull();
    expect(unreachableInv.notification?.status).toBe("FAILED");

    // --- Incident association + recordkeeping -------------------------
    const incident = await createIncident(
      org.id,
      {
        title: "Overdue hiker — Mt. Scenery",
        reportedAt: "2026-10-17T13:05",
        calloutId: callout.id,
      },
      actor.id,
    );
    expect(incident.calloutId).toBe(callout.id);

    await addIncidentMember(
      incident.id,
      { memberId: coming.id, roleNote: "trail team" },
      actor.id,
    );
    const asset = await prisma.asset.create({
      data: { organizationId: org.id, name: uniq("rescue-vehicle") },
    });
    await addIncidentAsset(incident.id, { assetId: asset.id }, actor.id);
    await addIncidentNote(
      incident.id,
      {
        kind: "GENERAL",
        body: "Search of lower trail complete; expanding to upper ridge.",
      },
      actor.id,
    );

    const incidentView = await getIncidentForAdmin(incident.id);
    expect(incidentView?.members).toHaveLength(1);
    expect(incidentView?.assets).toHaveLength(1);
    expect(incidentView?.notes).toHaveLength(1);
    expect(incidentView!.timeline.length).toBeGreaterThanOrEqual(4);

    // --- Close the callout, then correct the record -------------------
    const originalTitle = callout.title;
    const originalBodies = new Map(
      invitations.map((i) => [i.notification!.id, i.notification!.bodyText]),
    );
    await closeCallout(callout.id, actor.id);

    const edits = await updateCallout(
      callout.id,
      {
        title: uniq("missing-hiker-corrected"),
        message: "Hiker overdue on Mt. Scenery trail — found safe.",
      },
      actor.id,
    );
    expect(edits.changedFields.sort()).toEqual(["message", "title"]);

    const changes = await prisma.calloutChange.findMany({
      where: { calloutId: callout.id },
    });
    expect(changes).toHaveLength(2);
    const titleChange = changes.find((c) => c.field === "title")!;
    expect(titleChange.beforeValue).toBe(originalTitle);
    expect(titleChange.actorAuthIdentityId).toBe(actor.id);

    // Notifications keep the dispatched snapshot — the correction does
    // not rewrite what was sent, and no new alert went out.
    const notificationsAfter = await prisma.notification.findMany({
      where: { idempotencyKey: { startsWith: `callout:${callout.id}:` } },
    });
    expect(notificationsAfter).toHaveLength(4);
    for (const n of notificationsAfter) {
      expect(n.bodyText).toBe(originalBodies.get(n.id));
    }
    expect(provider.calls).toHaveLength(4);

    // The admin view distinguishes the corrected text from the audit.
    const after = await getCalloutForAdmin(callout.id);
    expect(after?.title).toContain("corrected");
    expect(after?.changes[0]?.actorDisplay).toBeTruthy();
  });
});
