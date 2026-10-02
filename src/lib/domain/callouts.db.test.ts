import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Database-backed tests for callouts and volunteer response tracking
 * (issue #14) — run only via `npm run test:db` (TEST_DATABASE_URL).
 * Real rows, real composite-FK and unique-constraint enforcement, real
 * row-lock serialization; the provider is always the deterministic
 * in-process fake (never the network). Fixture rows are prefixed
 * `cotest-` for cleanup.
 */

import { prisma } from "@/lib/prisma";
import {
  FakeNotificationProvider,
  fakeFailure,
} from "@/lib/notifications/fake";

import {
  activateCallout,
  closeCallout,
  getInvitationForToken,
  hashResponseToken,
  recordInvitationResponse,
  respondToCalloutToken,
  CalloutAudienceError,
  CalloutClosedError,
  CalloutIdempotencyConflictError,
  CalloutTokenInvalidError,
  CrossOrganizationCalloutError,
} from "./callouts";
import { retryNotification } from "./notifications";
import { setMemberContactPreference } from "./availability";

const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "cotest-";

let counter = 0;
function uniq(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}
function key(suffix: string) {
  return `${PREFIX}act-${counter}-${suffix}`;
}

let orgA: { id: string; name: string };
let orgB: { id: string };
let unitA: { id: string };
let unitB: { id: string };
let actor: { id: string };

async function makeMember(
  orgId: string,
  overrides: {
    email?: string | null;
    status?: "ACTIVE" | "INACTIVE";
  } = {},
) {
  return prisma.member.create({
    data: {
      organizationId: orgId,
      displayName: uniq("member"),
      email:
        overrides.email === undefined
          ? `${uniq("m")}@example.test`
          : overrides.email,
      status: overrides.status ?? "ACTIVE",
    },
  });
}

async function enableEmail(memberId: string) {
  await setMemberContactPreference(memberId, {
    notifyEmail: true,
    notifySms: false,
    notifyWhatsapp: false,
    notifyPush: false,
  });
}

function activate(
  orgId: string,
  input: Partial<Parameters<typeof activateCallout>[1]> = {},
  // Tests that inspect provider.calls MUST pass the instance through —
  // otherwise dispatch resolves a fresh fake per environment rules.
  provider: FakeNotificationProvider = new FakeNotificationProvider(),
) {
  return activateCallout(
    orgId,
    {
      title: uniq("callout"),
      audience: "ORGANIZATION",
      memberIds: [],
      activationKey: key("k"),
      ...input,
    },
    actor.id,
    { provider },
  );
}

/**
 * Pull the emailed response token out of a captured provider call.
 * Takes the LAST respond URL, matching the domain's recovery rule —
 * the real link is written after any coordinator-supplied message.
 */
function tokenFromCall(text: string | null | undefined): string {
  const match = [...(text ?? "").matchAll(/\/respond\?t=([A-Za-z0-9_-]+)/g)].at(
    -1,
  );
  if (!match) throw new Error("no response URL in provider call");
  return decodeURIComponent(match[1]!);
}

describe.skipIf(!hasDb)("callouts (issue #14)", () => {
  beforeAll(async () => {
    orgA = await prisma.organization.create({
      data: { name: uniq("org-a") },
    });
    orgB = await prisma.organization.create({
      data: { name: uniq("org-b") },
    });
    unitA = await prisma.unit.create({
      data: { organizationId: orgA.id, name: uniq("unit-a") },
    });
    unitB = await prisma.unit.create({
      data: { organizationId: orgB.id, name: uniq("unit-b") },
    });
    actor = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("actor"),
        email: `${uniq("actor")}@example.test`,
      },
    });
  });

  afterAll(async () => {
    const orgFilter = { organization: { name: { startsWith: PREFIX } } };
    await prisma.calloutResponseChange.deleteMany({ where: orgFilter });
    await prisma.calloutInvitation.deleteMany({ where: orgFilter });
    await prisma.callout.deleteMany({ where: orgFilter });
    await prisma.notificationAttempt.deleteMany({ where: orgFilter });
    await prisma.notification.deleteMany({ where: orgFilter });
    await prisma.memberNotificationPreference.deleteMany({
      where: orgFilter,
    });
    // MemberUnit / MemberAvailabilityUpdate have no `organization`
    // relation — filter by org ids.
    await prisma.memberUnit.deleteMany({
      where: { organizationId: { in: [orgA.id, orgB.id] } },
    });
    await prisma.memberAvailabilityUpdate.deleteMany({
      where: { organizationId: { in: [orgA.id, orgB.id] } },
    });
    await prisma.member.deleteMany({ where: orgFilter });
    await prisma.unit.deleteMany({ where: orgFilter });
    await prisma.authIdentity.deleteMany({
      where: { providerUid: { startsWith: PREFIX } },
    });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  /* ---------------- audience materialization ---------------- */

  it("ORGANIZATION audience materializes every ACTIVE member once", async () => {
    const m1 = await makeMember(orgA.id);
    const m2 = await makeMember(orgA.id);
    const inactive = await makeMember(orgA.id, { status: "INACTIVE" });
    await Promise.all([enableEmail(m1.id), enableEmail(m2.id)]);

    const provider = new FakeNotificationProvider();
    const { callout } = await activate(
      orgA.id,
      { title: "Org-wide" },
      provider,
    );

    const invitations = await prisma.calloutInvitation.findMany({
      where: { calloutId: callout.id },
    });
    const invitedIds = invitations.map((i) => i.memberId).sort();
    // Every ACTIVE member of the org is invited — including members
    // created by earlier tests in this suite.
    const allActive = await prisma.member.findMany({
      where: { organizationId: orgA.id, status: "ACTIVE" },
      select: { id: true },
    });
    expect(invitedIds).toEqual(allActive.map((m) => m.id).sort());
    expect(invitedIds).not.toContain(inactive.id);
    // One provider send per invited member with email enabled.
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("UNIT audience materializes only the unit's current active members", async () => {
    const inUnit = await makeMember(orgA.id);
    const alsoInUnit = await makeMember(orgA.id);
    const elsewhere = await makeMember(orgA.id);
    await prisma.memberUnit.createMany({
      data: [
        { organizationId: orgA.id, memberId: inUnit.id, unitId: unitA.id },
        {
          organizationId: orgA.id,
          memberId: alsoInUnit.id,
          unitId: unitA.id,
        },
      ],
    });
    await enableEmail(inUnit.id);
    await enableEmail(alsoInUnit.id);
    await enableEmail(elsewhere.id);

    const { callout } = await activate(orgA.id, {
      title: "Unit callout",
      audience: "UNIT",
      unitId: unitA.id,
    });
    const invitations = await prisma.calloutInvitation.findMany({
      where: { calloutId: callout.id },
    });
    expect(invitations.map((i) => i.memberId).sort()).toEqual(
      [inUnit.id, alsoInUnit.id].sort(),
    );
  });

  it("MEMBERS audience invites exactly the selected members", async () => {
    const picked = await makeMember(orgA.id);
    const alsoPicked = await makeMember(orgA.id);
    const skipped = await makeMember(orgA.id);
    await enableEmail(picked.id);
    await enableEmail(alsoPicked.id);
    await enableEmail(skipped.id);

    const { callout } = await activate(orgA.id, {
      title: "Selected",
      audience: "MEMBERS",
      memberIds: [picked.id, alsoPicked.id, picked.id], // dupe in input
    });
    const invitations = await prisma.calloutInvitation.findMany({
      where: { calloutId: callout.id },
    });
    expect(invitations.map((i) => i.memberId).sort()).toEqual(
      [picked.id, alsoPicked.id].sort(),
    );
    // @@unique([calloutId, memberId]) — one row per member even though
    // the input listed `picked` twice.
    expect(invitations).toHaveLength(2);
  });

  it("rejects a foreign member id opaquely", async () => {
    const foreign = await makeMember(orgB.id);
    await expect(
      activate(orgA.id, {
        title: "Sneaky",
        audience: "MEMBERS",
        memberIds: [foreign.id],
      }),
    ).rejects.toThrow(CrossOrganizationCalloutError);
  });

  it("rejects a foreign unit id opaquely", async () => {
    await expect(
      activate(orgA.id, {
        title: "Sneaky",
        audience: "UNIT",
        unitId: unitB.id,
      }),
    ).rejects.toThrow(CrossOrganizationCalloutError);
  });

  it("rejects an inactive member in an explicit selection", async () => {
    const inactive = await makeMember(orgA.id, { status: "INACTIVE" });
    await expect(
      activate(orgA.id, {
        title: "Inactive member",
        audience: "MEMBERS",
        memberIds: [inactive.id],
      }),
    ).rejects.toThrow(CalloutAudienceError);
  });

  it("historical audience survives later unit membership changes", async () => {
    const original = await makeMember(orgA.id);
    const unitOnly = await prisma.unit.create({
      data: { organizationId: orgA.id, name: uniq("unit-hist") },
    });
    await prisma.memberUnit.create({
      data: {
        organizationId: orgA.id,
        memberId: original.id,
        unitId: unitOnly.id,
      },
    });
    await enableEmail(original.id);
    const { callout } = await activate(orgA.id, {
      title: "Snapshot",
      audience: "UNIT",
      unitId: unitOnly.id,
    });

    // Roster churn AFTER activation must not rewrite the record.
    const later = await makeMember(orgA.id);
    await prisma.memberUnit.create({
      data: {
        organizationId: orgA.id,
        memberId: later.id,
        unitId: unitOnly.id,
      },
    });
    await prisma.memberUnit.deleteMany({
      where: { memberId: original.id, unitId: unitOnly.id },
    });

    const invitations = await prisma.calloutInvitation.findMany({
      where: { calloutId: callout.id },
    });
    expect(invitations.map((i) => i.memberId)).toEqual([original.id]);
  });

  it("does not exclude invitees based on availability status", async () => {
    const away = await makeMember(orgA.id);
    await enableEmail(away.id);
    // Record an explicit UNAVAILABLE availability statement — the member
    // is still invited; availability is context, not a filter.
    await prisma.memberAvailabilityUpdate.create({
      data: {
        organizationId: orgA.id,
        memberId: away.id,
        status: "UNAVAILABLE",
        selfReported: true,
        actorAuthIdentityId: actor.id,
      },
    });
    const { callout } = await activate(orgA.id, {
      title: "No availability filter",
      audience: "MEMBERS",
      memberIds: [away.id],
    });
    const invitations = await prisma.calloutInvitation.findMany({
      where: { calloutId: callout.id },
    });
    expect(invitations).toHaveLength(1);
    expect(invitations[0]!.memberId).toBe(away.id);
  });

  /* ---------------- activation idempotency ---------------- */

  it("identical activation replay returns the same callout once", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const provider = new FakeNotificationProvider();
    const input = {
      title: "Replay me",
      audience: "MEMBERS" as const,
      memberIds: [m.id],
      activationKey: key("replay"),
    };
    const first = await activate(orgA.id, input, provider);
    const second = await activate(orgA.id, input, provider);
    expect(second.deduplicated).toBe(true);
    expect(second.callout.id).toBe(first.callout.id);
    const callouts = await prisma.callout.count({
      where: { organizationId: orgA.id, activationKey: input.activationKey },
    });
    expect(callouts).toBe(1);
    // No second provider send on replay.
    expect(provider.calls).toHaveLength(1);
  });

  it("conflicting activation-key reuse fails loudly", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const activationKey = key("conflict");
    await activate(orgA.id, {
      title: "Original",
      audience: "MEMBERS",
      memberIds: [m.id],
      activationKey,
    });
    await expect(
      activate(orgA.id, {
        title: "Different title",
        audience: "MEMBERS",
        memberIds: [m.id],
        activationKey,
      }),
    ).rejects.toThrow(CalloutIdempotencyConflictError);
    // Different invitee set under the same key is also a conflict.
    const other = await makeMember(orgA.id);
    await expect(
      activate(orgA.id, {
        title: "Original",
        audience: "MEMBERS",
        memberIds: [other.id],
        activationKey,
      }),
    ).rejects.toThrow(CalloutIdempotencyConflictError);
  });

  it("concurrent duplicate activation produces one callout and one send per invitee", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const provider = new FakeNotificationProvider();
    const input = {
      title: "Raced",
      audience: "MEMBERS" as const,
      memberIds: [m.id],
      activationKey: key("race"),
    };
    const [a, b] = await Promise.all([
      activate(orgA.id, input, provider),
      activate(orgA.id, input, provider),
    ]);
    expect(a.callout.id).toBe(b.callout.id);
    const invitations = await prisma.calloutInvitation.findMany({
      where: { calloutId: a.callout.id },
    });
    expect(invitations).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
  });

  /* ---------------- notification integration ---------------- */

  it("each invitation gets a deterministic-keyed notification, linked back", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const provider = new FakeNotificationProvider();
    const { callout } = await activate(orgA.id, {
      title: "Link check",
      audience: "MEMBERS",
      memberIds: [m.id],
    });
    void provider;
    const invitation = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m.id },
    });
    expect(invitation.notificationId).not.toBeNull();
    const notification = await prisma.notification.findUniqueOrThrow({
      where: { id: invitation.notificationId! },
    });
    expect(notification.idempotencyKey).toBe(
      `callout:${callout.id}:invitation:${invitation.id}:email`,
    );
    expect(notification.status).toBe("ACCEPTED");
    expect(notification.template).toBe("callout_invitation");
  });

  it("preference-disabled member is still invited; notification suppressed", async () => {
    const quiet = await makeMember(orgA.id); // notifyEmail never enabled
    const provider = new FakeNotificationProvider();
    const { callout } = await activate(orgA.id, {
      title: "Suppressed pref",
      audience: "MEMBERS",
      memberIds: [quiet.id],
    });
    const invitation = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: quiet.id },
    });
    // Invitation remains a fact even though nothing was sent.
    expect(invitation.notificationId).not.toBeNull();
    const notification = await prisma.notification.findUniqueOrThrow({
      where: { id: invitation.notificationId! },
    });
    expect(notification.status).toBe("SUPPRESSED");
    expect(notification.statusReason).toBe("preference_disabled");
    expect(provider.calls).toHaveLength(0);
  });

  it("member with no email is still invited; notification suppressed", async () => {
    const noEmail = await makeMember(orgA.id);
    await enableEmail(noEmail.id);
    // Preference enabled, then the email is removed from the record —
    // the request is recorded as destination_missing, not sent.
    await prisma.member.update({
      where: { id: noEmail.id },
      data: { email: null },
    });
    const provider = new FakeNotificationProvider();
    const { callout } = await activate(orgA.id, {
      title: "No email",
      audience: "MEMBERS",
      memberIds: [noEmail.id],
    });
    const invitation = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: noEmail.id },
    });
    const notification = await prisma.notification.findUniqueOrThrow({
      where: { id: invitation.notificationId! },
    });
    expect(notification.status).toBe("SUPPRESSED");
    expect(notification.statusReason).toBe("destination_missing");
    expect(provider.calls).toHaveLength(0);
  });

  it("partial provider failure stays visible per invitation", async () => {
    const m1 = await makeMember(orgA.id);
    const m2 = await makeMember(orgA.id);
    await enableEmail(m1.id);
    await enableEmail(m2.id);
    // First send fails retryably; subsequent sends succeed.
    const provider = new FakeNotificationProvider({
      results: [fakeFailure.unavailable()],
    });
    const { callout } = await activate(
      orgA.id,
      {
        title: "Partial failure",
        audience: "MEMBERS",
        memberIds: [m1.id, m2.id],
      },
      provider,
    );
    const notifications = await prisma.notification.findMany({
      where: {
        idempotencyKey: { startsWith: `callout:${callout.id}:` },
      },
    });
    expect(notifications).toHaveLength(2);
    const statuses = notifications.map((n) => n.status).sort();
    expect(statuses).toEqual(["ACCEPTED", "FAILED"]);
    // Every invitation is linked to its notification row either way —
    // the failure is a recorded fact, not a lost write.
    const invitations = await prisma.calloutInvitation.findMany({
      where: { calloutId: callout.id },
    });
    expect(invitations.every((i) => i.notificationId !== null)).toBe(true);
  });

  /* ---------------- dispatch convergence ---------------- */

  /**
   * Re-run activateCallout as an idempotent replay of an existing
   * callout: same activationKey, same logical input (the memberIds the
   * callout originally materialized), fresh provider.
   */
  async function replay(
    calloutId: string,
    provider?: FakeNotificationProvider,
  ) {
    const callout = await prisma.callout.findUniqueOrThrow({
      where: { id: calloutId },
      include: { invitations: { select: { memberId: true } } },
    });
    return activateCallout(
      orgA.id,
      {
        title: callout.title,
        message: callout.message ?? undefined,
        audience: callout.audience,
        unitId: callout.unitId ?? undefined,
        memberIds: callout.invitations.map((i) => i.memberId),
        activationKey: callout.activationKey,
      },
      actor.id,
      provider ? { provider } : {},
    );
  }

  it("concurrent replays converge: one send, and the emailed token resolves", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const { callout } = await activate(orgA.id, {
      title: "Concurrent replay",
      audience: "MEMBERS",
      memberIds: [m.id],
    });
    const invitation = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m.id },
    });
    // Back to pending: unlink and remove the notification row so both
    // replays race the create+dispatch path.
    await prisma.calloutInvitation.update({
      where: { id: invitation.id },
      data: { notificationId: null },
    });
    await prisma.notificationAttempt.deleteMany({
      where: { notificationId: invitation.notificationId! },
    });
    await prisma.notification.delete({
      where: { id: invitation.notificationId! },
    });

    const provider = new FakeNotificationProvider();
    await Promise.all([
      replay(callout.id, provider),
      replay(callout.id, provider),
    ]);
    // Two dispatchers, one logical send — the deterministic token makes
    // the outcome identical no matter which dispatcher's row wins.
    expect(provider.calls).toHaveLength(1);
    const after = await prisma.calloutInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    expect(after.notificationId).not.toBeNull();
    const emailed = tokenFromCall(provider.calls[0]!.text);
    expect(after.responseTokenHash).toBe(hashResponseToken(emailed));
    expect((await getInvitationForToken(emailed))?.id).toBe(invitation.id);
  });

  it("a created-but-never-dispatched notification is resumed by a replay", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const provider = new FakeNotificationProvider();
    const { callout } = await activate(
      orgA.id,
      {
        title: "Resume crashed send",
        audience: "MEMBERS",
        memberIds: [m.id],
      },
      provider,
    );
    const invitation = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m.id },
    });
    // Simulate the crash window: notification row exists, invitation
    // unlinked, and the row is PENDING with no attempt recorded — the
    // provider was never reached.
    await prisma.calloutInvitation.update({
      where: { id: invitation.id },
      data: { notificationId: null },
    });
    await prisma.notificationAttempt.deleteMany({
      where: { notificationId: invitation.notificationId! },
    });
    await prisma.notification.update({
      where: { id: invitation.notificationId! },
      data: { status: "PENDING" },
    });

    const provider2 = new FakeNotificationProvider();
    await replay(callout.id, provider2);
    const after = await prisma.calloutInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    // The replay dispatched the existing row — no new notification,
    // but a real send now happened.
    expect(provider2.calls).toHaveLength(1);
    expect(after.notificationId).toBe(invitation.notificationId);
    const notification = await prisma.notification.findUniqueOrThrow({
      where: { id: invitation.notificationId! },
    });
    expect(notification.status).toBe("ACCEPTED");
    const emailed = tokenFromCall(provider2.calls[0]!.text);
    expect(after.responseTokenHash).toBe(hashResponseToken(emailed));
    expect((await getInvitationForToken(emailed))?.id).toBe(invitation.id);
  });

  it("an orphaned notification row is relinked on replay without resending", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const provider = new FakeNotificationProvider();
    const { callout } = await activate(
      orgA.id,
      {
        title: "Orphan relink",
        audience: "MEMBERS",
        memberIds: [m.id],
      },
      provider,
    );
    const invitation = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m.id },
    });
    const emailed = tokenFromCall(provider.calls[0]!.text);
    // Simulate a crash after the notification row was created and sent
    // but before the invitation was linked.
    await prisma.calloutInvitation.update({
      where: { id: invitation.id },
      data: { notificationId: null },
    });

    const provider2 = new FakeNotificationProvider();
    await replay(callout.id, provider2);
    const after = await prisma.calloutInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    expect(provider2.calls).toHaveLength(0); // no resend
    expect(after.notificationId).toBe(invitation.notificationId);
    expect(after.responseTokenHash).toBe(hashResponseToken(emailed));
    // And the originally emailed link still resolves.
    const resolved = await getInvitationForToken(emailed);
    expect(resolved?.id).toBe(invitation.id);
  });

  it("a dispatch failure leaves the invitation unlinked and resumable", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const { callout } = await activate(orgA.id, {
      title: "Failed dispatch",
      audience: "MEMBERS",
      memberIds: [m.id],
    });
    const invitation = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m.id },
    });
    // Pending: unlink and remove the notification row.
    await prisma.calloutInvitation.update({
      where: { id: invitation.id },
      data: { notificationId: null },
    });
    await prisma.notificationAttempt.deleteMany({
      where: { notificationId: invitation.notificationId! },
    });
    await prisma.notification.delete({
      where: { id: invitation.notificationId! },
    });

    // Force requestNotification to throw before persisting: no provider
    // dep, and env says resend without RESEND_API_KEY →
    // NotificationConfigError.
    const prevProviderEnv = process.env.NOTIFICATION_PROVIDER;
    const prevKeyEnv = process.env.RESEND_API_KEY;
    process.env.NOTIFICATION_PROVIDER = "resend";
    delete process.env.RESEND_API_KEY;
    try {
      await replay(callout.id);
    } finally {
      if (prevProviderEnv === undefined) {
        delete process.env.NOTIFICATION_PROVIDER;
      } else {
        process.env.NOTIFICATION_PROVIDER = prevProviderEnv;
      }
      if (prevKeyEnv !== undefined) {
        process.env.RESEND_API_KEY = prevKeyEnv;
      }
    }
    const afterFail = await prisma.calloutInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    expect(afterFail.notificationId).toBeNull();
    // No notification row was persisted for the failed request.
    expect(
      await prisma.notification.findFirst({
        where: {
          idempotencyKey: `callout:${callout.id}:invitation:${invitation.id}:email`,
        },
      }),
    ).toBeNull();

    // A later replay dispatches immediately — nothing is stranded.
    const provider = new FakeNotificationProvider();
    await replay(callout.id, provider);
    const afterRetry = await prisma.calloutInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    expect(provider.calls).toHaveLength(1);
    expect(afterRetry.notificationId).not.toBeNull();
  });

  /* ---------------- response tokens ---------------- */

  it("stores only the token hash; the emailed raw token resolves the invitation", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const provider = new FakeNotificationProvider();
    const { callout } = await activate(
      orgA.id,
      {
        title: "Token check",
        audience: "MEMBERS",
        memberIds: [m.id],
      },
      provider,
    );
    const invitation = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m.id },
    });
    // The stored value is a 64-char hex hash — not the base64url token.
    expect(invitation.responseTokenHash).toMatch(/^[0-9a-f]{64}$/);
    const rawToken = tokenFromCall(provider.calls[0]!.text);
    expect(hashResponseToken(rawToken)).toBe(invitation.responseTokenHash);
    // And the raw token resolves to exactly this invitation.
    const resolved = await getInvitationForToken(rawToken);
    expect(resolved?.id).toBe(invitation.id);
    expect(resolved?.callout.title).toBe("Token check");
  });

  it("persists a placeholder body — the raw token never reaches the database", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const provider = new FakeNotificationProvider();
    const { callout } = await activate(
      orgA.id,
      {
        title: "At rest",
        audience: "MEMBERS",
        memberIds: [m.id],
      },
      provider,
    );
    const invitation = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m.id },
    });
    const notification = await prisma.notification.findUniqueOrThrow({
      where: { id: invitation.notificationId! },
    });
    const emailedToken = tokenFromCall(provider.calls[0]!.text);
    // The durable record carries the placeholder — no live credential.
    expect(notification.bodyText).toContain("{callout-response-url}");
    expect(notification.bodyText).not.toContain("/respond?t=");
    expect(notification.bodyText).not.toContain(emailedToken);
    // The delivered email carries the real link — substituted at
    // provider-send time — and that token resolves the invitation.
    expect(provider.calls[0]!.text).toContain("/respond?t=");
    expect(provider.calls[0]!.text).not.toContain("{callout-response-url}");
    expect((await getInvitationForToken(emailedToken))?.id).toBe(invitation.id);
  });

  it("retryNotification re-sends a working link — the placeholder is substituted per send", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    // First send fails retryably; the request row is recorded FAILED.
    const failing = new FakeNotificationProvider({
      results: [fakeFailure.unavailable()],
    });
    const { callout } = await activate(
      orgA.id,
      {
        title: "Retry link",
        audience: "MEMBERS",
        memberIds: [m.id],
      },
      failing,
    );
    const invitation = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m.id },
    });
    const before = await prisma.notification.findUniqueOrThrow({
      where: { id: invitation.notificationId! },
    });
    expect(before.status).toBe("FAILED");

    // The explicit retry path — the same one the admin surface calls —
    // must deliver a usable link even though the stored body holds
    // only the placeholder.
    const retrying = new FakeNotificationProvider();
    const retried = await retryNotification(invitation.notificationId!, {
      provider: retrying,
    });
    expect(retried.status).toBe("ACCEPTED");
    expect(retrying.calls).toHaveLength(1);
    const text = retrying.calls[0]!.text;
    expect(text).toContain("/respond?t=");
    expect(text).not.toContain("{callout-response-url}");
    const retriedToken = tokenFromCall(text);
    expect((await getInvitationForToken(retriedToken))?.id).toBe(invitation.id);
    // Derived token is stable: the retried link carries the same token
    // the stored hash was written for.
    expect(hashResponseToken(retriedToken)).toBe(invitation.responseTokenHash);
  });

  it("rotating the token secret revokes outstanding links; the next send delivers the new one", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    // Script the first send to fail so the notification is retryable.
    const failing = new FakeNotificationProvider({
      results: [fakeFailure.unavailable()],
    });
    const { callout } = await activate(
      orgA.id,
      {
        title: "Rotation",
        audience: "MEMBERS",
        memberIds: [m.id],
      },
      failing,
    );
    const invitation = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m.id },
    });
    const oldToken = tokenFromCall(failing.calls[0]!.text);

    const prev = process.env.CALLOUT_RESPONSE_TOKEN_SECRET;
    process.env.CALLOUT_RESPONSE_TOKEN_SECRET = uniq("rotated");
    try {
      // The old link stops resolving immediately — the presented token
      // no longer equals the live derivation, even though its stored
      // hash still matches the lookup index.
      expect(await getInvitationForToken(oldToken)).toBeNull();
      await expect(respondToCalloutToken(oldToken, "COMING")).rejects.toThrow(
        CalloutTokenInvalidError,
      );

      // The next send (the admin retry path) substitutes the NEW
      // derivation and refreshes the stored hash — the new link works.
      const retrying = new FakeNotificationProvider();
      const retried = await retryNotification(invitation.notificationId!, {
        provider: retrying,
      });
      expect(retried.status).toBe("ACCEPTED");
      const newToken = tokenFromCall(retrying.calls[0]!.text);
      expect(newToken).not.toBe(oldToken);

      const after = await prisma.calloutInvitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });
      expect(after.responseTokenHash).toBe(hashResponseToken(newToken));
      expect((await getInvitationForToken(newToken))?.id).toBe(invitation.id);
      // And the retired token stays dead after the hash refresh too.
      expect(await getInvitationForToken(oldToken)).toBeNull();
    } finally {
      if (prev === undefined) {
        delete process.env.CALLOUT_RESPONSE_TOKEN_SECRET;
      } else {
        process.env.CALLOUT_RESPONSE_TOKEN_SECRET = prev;
      }
    }
  });

  it("an invalid token resolves nothing and cannot respond", async () => {
    expect(await getInvitationForToken("nonsense-token")).toBeNull();
    await expect(
      respondToCalloutToken("nonsense-token", "COMING"),
    ).rejects.toThrow(CalloutTokenInvalidError);
  });

  it("a token from one invitation cannot respond another", async () => {
    const m1 = await makeMember(orgA.id);
    const m2 = await makeMember(orgA.id);
    await enableEmail(m1.id);
    await enableEmail(m2.id);
    const provider = new FakeNotificationProvider();
    const { callout } = await activate(
      orgA.id,
      {
        title: "Two invitees",
        audience: "MEMBERS",
        memberIds: [m1.id, m2.id],
      },
      provider,
    );
    // Token in email for m1 resolves m1's invitation only — the public
    // route never accepts an invitationId as input at all.
    const token1 = tokenFromCall(
      provider.calls.find((c) => c.to === m1.email)!.text,
    );
    const resolved = await getInvitationForToken(token1);
    const inv1 = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m1.id },
    });
    expect(resolved?.id).toBe(inv1.id);
    const { invitation } = await respondToCalloutToken(token1, "COMING");
    expect(invitation.id).toBe(inv1.id);
    // m2's invitation untouched.
    const inv2 = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m2.id },
    });
    expect(inv2.response).toBeNull();
  });

  /* ---------------- responses ---------------- */

  it("records a first COMING response with respondedAt", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const { callout } = await activate(orgA.id, {
      title: "Coming",
      audience: "MEMBERS",
      memberIds: [m.id],
    });
    const inv = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m.id },
    });
    const { invitation, changed } = await recordInvitationResponse(
      inv.id,
      "COMING",
      "TOKEN_LINK",
      null,
    );
    expect(changed).toBe(true);
    expect(invitation.response).toBe("COMING");
    expect(invitation.respondedAt).toBeInstanceOf(Date);
    const changes = await prisma.calloutResponseChange.findMany({
      where: { invitationId: inv.id },
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.response).toBe("COMING");
    expect(changes[0]!.previousResponse).toBeNull();
    expect(changes[0]!.source).toBe("TOKEN_LINK");
  });

  it("records a first UNAVAILABLE response", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const { callout } = await activate(orgA.id, {
      title: "Unavailable",
      audience: "MEMBERS",
      memberIds: [m.id],
    });
    const inv = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m.id },
    });
    const { invitation } = await recordInvitationResponse(
      inv.id,
      "UNAVAILABLE",
      "TOKEN_LINK",
      null,
    );
    expect(invitation.response).toBe("UNAVAILABLE");
  });

  it("repeated same response is idempotent — no history noise", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const { callout } = await activate(orgA.id, {
      title: "Idempotent",
      audience: "MEMBERS",
      memberIds: [m.id],
    });
    const inv = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m.id },
    });
    await recordInvitationResponse(inv.id, "COMING", "TOKEN_LINK", null);
    const again = await recordInvitationResponse(
      inv.id,
      "COMING",
      "TOKEN_LINK",
      null,
    );
    expect(again.changed).toBe(false);
    const changes = await prisma.calloutResponseChange.count({
      where: { invitationId: inv.id },
    });
    expect(changes).toBe(1);
  });

  it("COMING → UNAVAILABLE appends history and updates current state", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const { callout } = await activate(orgA.id, {
      title: "Change mind",
      audience: "MEMBERS",
      memberIds: [m.id],
    });
    const inv = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m.id },
    });
    await recordInvitationResponse(inv.id, "COMING", "TOKEN_LINK", null);
    const { invitation } = await recordInvitationResponse(
      inv.id,
      "UNAVAILABLE",
      "TOKEN_LINK",
      null,
    );
    expect(invitation.response).toBe("UNAVAILABLE");
    const changes = await prisma.calloutResponseChange.findMany({
      where: { invitationId: inv.id },
      orderBy: { createdAt: "asc" },
    });
    expect(changes).toHaveLength(2);
    expect(changes[0]!.response).toBe("COMING");
    expect(changes[1]!.response).toBe("UNAVAILABLE");
    expect(changes[1]!.previousResponse).toBe("COMING");
  });

  it("concurrent same-response submissions produce one history row", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const { callout } = await activate(orgA.id, {
      title: "Concurrent same",
      audience: "MEMBERS",
      memberIds: [m.id],
    });
    const inv = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m.id },
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        recordInvitationResponse(inv.id, "COMING", "TOKEN_LINK", null),
      ),
    );
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    const changes = await prisma.calloutResponseChange.count({
      where: { invitationId: inv.id },
    });
    expect(changes).toBe(1);
    const fresh = await prisma.calloutInvitation.findUniqueOrThrow({
      where: { id: inv.id },
    });
    expect(fresh.response).toBe("COMING");
  });

  it("concurrent conflicting responses serialize into a consistent history", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const { callout } = await activate(orgA.id, {
      title: "Concurrent conflict",
      audience: "MEMBERS",
      memberIds: [m.id],
    });
    const inv = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m.id },
    });
    await Promise.all(
      Array.from({ length: 3 }, () =>
        recordInvitationResponse(inv.id, "COMING", "TOKEN_LINK", null),
      ).concat(
        Array.from({ length: 3 }, () =>
          recordInvitationResponse(inv.id, "UNAVAILABLE", "TOKEN_LINK", null),
        ),
      ),
    );
    const fresh = await prisma.calloutInvitation.findUniqueOrThrow({
      where: { id: inv.id },
    });
    const changes = await prisma.calloutResponseChange.findMany({
      where: { invitationId: inv.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    // Both values won at least once, so at least two transitions were
    // recorded. The history is a consistent chain — each change's
    // previousResponse equals the prior change's response — and the
    // final stored state equals the last recorded change.
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(changes.length).toBeLessThanOrEqual(6);
    expect(changes[0]!.previousResponse).toBeNull();
    for (let i = 1; i < changes.length; i++) {
      expect(changes[i]!.previousResponse).toBe(changes[i - 1]!.response);
    }
    expect(fresh.response).toBe(changes.at(-1)!.response);
    expect(changes.every((c) => c.source === "TOKEN_LINK")).toBe(true);
  });

  it("admin-recorded responses carry source ADMIN and the acting identity", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const { callout } = await activate(orgA.id, {
      title: "Phone response",
      audience: "MEMBERS",
      memberIds: [m.id],
    });
    const inv = await prisma.calloutInvitation.findFirstOrThrow({
      where: { calloutId: callout.id, memberId: m.id },
    });
    await recordInvitationResponse(
      inv.id,
      "COMING",
      "ADMIN",
      actor.id,
      "Confirmed by phone",
    );
    const change = await prisma.calloutResponseChange.findFirstOrThrow({
      where: { invitationId: inv.id },
    });
    expect(change.source).toBe("ADMIN");
    expect(change.actorAuthIdentityId).toBe(actor.id);
    expect(change.note).toBe("Confirmed by phone");
  });

  /* ---------------- close ---------------- */

  it("closed callout refuses token responses but preserves history", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const provider = new FakeNotificationProvider();
    const { callout } = await activate(
      orgA.id,
      {
        title: "Closable",
        audience: "MEMBERS",
        memberIds: [m.id],
      },
      provider,
    );
    const rawToken = tokenFromCall(provider.calls[0]!.text);
    await respondToCalloutToken(rawToken, "COMING");

    const closed = await closeCallout(callout.id, actor.id);
    expect(closed.status).toBe("CLOSED");
    expect(closed.closedAt).toBeInstanceOf(Date);
    expect(closed.closedByAuthIdentityId).toBe(actor.id);

    // The link still resolves (read-only) but no longer accepts responses.
    const view = await getInvitationForToken(rawToken);
    expect(view?.id).not.toBeNull();
    await expect(
      respondToCalloutToken(rawToken, "UNAVAILABLE"),
    ).rejects.toThrow(CalloutClosedError);
    const fresh = await prisma.calloutInvitation.findUniqueOrThrow({
      where: { id: view!.id },
    });
    expect(fresh.response).toBe("COMING");
    const changes = await prisma.calloutResponseChange.count({
      where: { invitationId: view!.id },
    });
    expect(changes).toBe(1);
  });

  it("closing twice is an idempotent no-op", async () => {
    const m = await makeMember(orgA.id);
    await enableEmail(m.id);
    const { callout } = await activate(orgA.id, {
      title: "Double close",
      audience: "MEMBERS",
      memberIds: [m.id],
    });
    const first = await closeCallout(callout.id, actor.id);
    const second = await closeCallout(callout.id, actor.id);
    expect(second.status).toBe("CLOSED");
    expect(second.closedAt?.getTime()).toBe(first.closedAt?.getTime());
  });
});
