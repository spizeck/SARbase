import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Database-backed tests for the WHATSAPP channel and member consent
 * (issue #100) — run only via `npm run test:db` (TEST_DATABASE_URL).
 * The provider is always the deterministic in-process fake.
 * Fixture names are prefixed `watest-` for cleanup.
 */

import { prisma } from "@/lib/prisma";
import {
  FakeNotificationProvider,
  fakeFailure,
} from "@/lib/notifications/fake";

import {
  requestNotification,
  retryNotification,
  SUPPRESSION_REASONS,
} from "./notifications";
import {
  setMemberContactPreference,
  setMemberWhatsappConsent,
} from "./availability";
import { CALLOUT_INVITATION_TEMPLATE } from "./calloutTokens";

const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "watest-";

let counter = 0;
function uniq(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

let orgA: { id: string; name: string };
let actor: { id: string };

function whatsappProvider() {
  return new FakeNotificationProvider({ channel: "WHATSAPP" });
}

async function makeMember(overrides: { email?: string; phone?: string } = {}) {
  return prisma.member.create({
    data: {
      organizationId: orgA.id,
      displayName: uniq("member"),
      status: "ACTIVE",
      email: overrides.email ?? null,
      phone: overrides.phone ?? null,
    },
  });
}

async function makeCallout(title: string) {
  return prisma.callout.create({
    data: {
      organizationId: orgA.id,
      createdByAuthIdentityId: actor.id,
      audience: "ORGANIZATION",
      title,
      activationKey: uniq("act"),
      intentHash: uniq("hash"),
    },
  });
}

async function makeInvitation(calloutId: string, memberId: string) {
  return prisma.calloutInvitation.create({
    data: {
      organizationId: orgA.id,
      calloutId,
      memberId,
      responseTokenHash: `hash-${calloutId}-${memberId}`,
    },
  });
}

describe.skipIf(!hasDb)("whatsapp channel and consent", () => {
  beforeAll(async () => {
    orgA = await prisma.organization.create({
      data: { name: uniq("org-a") },
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
    const orgFilter = { organizationId: orgA.id };
    await prisma.memberContactChange.deleteMany({ where: orgFilter });
    await prisma.calloutResponseChange.deleteMany({ where: orgFilter });
    await prisma.calloutInvitation.deleteMany({ where: orgFilter });
    await prisma.callout.deleteMany({ where: orgFilter });
    await prisma.notificationAttempt.deleteMany({ where: orgFilter });
    await prisma.notification.deleteMany({ where: orgFilter });
    await prisma.memberNotificationPreference.deleteMany({
      where: orgFilter,
    });
    await prisma.member.deleteMany({ where: orgFilter });
    await prisma.authIdentity.deleteMany({
      where: { providerUid: { startsWith: PREFIX } },
    });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  /* ---------------- consent lifecycle ---------------- */

  it("grants, audits, and revokes consent through the self-service function", async () => {
    const member = await makeMember({ phone: "+5994161234" });

    const granted = await setMemberWhatsappConsent(member.id, true, actor.id);
    expect(granted.whatsappConsentAt).not.toBeNull();
    expect(granted.whatsappOptedOutAt).toBeNull();
    expect(granted.whatsappConsentRecordedByIdentityId).toBe(actor.id);

    const grantAudit = await prisma.memberContactChange.findFirst({
      where: { memberId: member.id, field: "whatsappConsent" },
      orderBy: { createdAt: "desc" },
    });
    expect(grantAudit).toMatchObject({
      newValue: "granted",
      selfReported: true,
      actorAuthIdentityId: actor.id,
    });

    const revoked = await setMemberWhatsappConsent(member.id, false, actor.id);
    expect(revoked.whatsappOptedOutAt).not.toBeNull();
    // Historical consent timestamp is preserved for audit — the
    // opt-out, not deletion, ends consent.
    expect(revoked.whatsappConsentAt).not.toBeNull();

    const revokeAudit = await prisma.memberContactChange.findFirst({
      where: { memberId: member.id, field: "whatsappConsent" },
      orderBy: { createdAt: "desc" },
    });
    expect(revokeAudit).toMatchObject({
      previousValue: "granted",
      newValue: "opted_out",
    });
  });

  it("preference writes never touch consent fields", async () => {
    const member = await makeMember({ phone: "+5994161234" });
    await setMemberWhatsappConsent(member.id, true, actor.id);

    // The shared preference writer — what admin AND self-service
    // preference actions both call — must leave consent untouched.
    await setMemberContactPreference(member.id, {
      notifyEmail: false,
      notifySms: false,
      notifyWhatsapp: false,
      notifyPush: false,
    });
    const after = await prisma.memberNotificationPreference.findFirstOrThrow({
      where: { memberId: member.id },
    });
    expect(after.whatsappConsentAt).not.toBeNull();
    expect(after.whatsappOptedOutAt).toBeNull();
    expect(after.whatsappConsentRecordedByIdentityId).toBe(actor.id);
  });

  /* ---------------- dispatch suppression ---------------- */

  it("suppresses WHATSAPP when the willingness flag is off", async () => {
    const member = await makeMember({ phone: "+5994161234" });
    await setMemberWhatsappConsent(member.id, true, actor.id);
    // Consent exists but notifyWhatsapp was never enabled.
    const { notification } = await requestNotification(
      {
        organizationId: orgA.id,
        channel: "WHATSAPP",
        memberId: member.id,
        template: "admin_notice",
        subject: "Test",
        idempotencyKey: uniq("key"),
      },
      actor.id,
      { provider: whatsappProvider() },
    );
    expect(notification.status).toBe("SUPPRESSED");
    expect(notification.statusReason).toBe(
      SUPPRESSION_REASONS.PREFERENCE_DISABLED,
    );
  });

  it("suppresses WHATSAPP without member consent — admin flags cannot substitute", async () => {
    const member = await makeMember({ phone: "+5994161234" });
    // notifyWhatsapp enabled (e.g. by staff) but NO consent on record.
    await setMemberContactPreference(member.id, {
      notifyEmail: false,
      notifySms: false,
      notifyWhatsapp: true,
      notifyPush: false,
    });
    const { notification } = await requestNotification(
      {
        organizationId: orgA.id,
        channel: "WHATSAPP",
        memberId: member.id,
        template: "admin_notice",
        subject: "Test",
        idempotencyKey: uniq("key"),
      },
      actor.id,
      { provider: whatsappProvider() },
    );
    expect(notification.status).toBe("SUPPRESSED");
    expect(notification.statusReason).toBe(SUPPRESSION_REASONS.CONSENT_MISSING);
  });

  it("suppresses WHATSAPP after opt-out even with flag + past consent", async () => {
    const member = await makeMember({ phone: "+5994161234" });
    await setMemberContactPreference(member.id, {
      notifyEmail: false,
      notifySms: false,
      notifyWhatsapp: true,
      notifyPush: false,
    });
    await setMemberWhatsappConsent(member.id, true, actor.id);
    await setMemberWhatsappConsent(member.id, false, actor.id);
    const { notification } = await requestNotification(
      {
        organizationId: orgA.id,
        channel: "WHATSAPP",
        memberId: member.id,
        template: "admin_notice",
        subject: "Test",
        idempotencyKey: uniq("key"),
      },
      actor.id,
      { provider: whatsappProvider() },
    );
    expect(notification.status).toBe("SUPPRESSED");
    expect(notification.statusReason).toBe(SUPPRESSION_REASONS.CONSENT_MISSING);
  });

  it("suppresses WHATSAPP when the phone is missing or not a valid number", async () => {
    const member = await makeMember({ phone: "not-a-phone" });
    await setMemberContactPreference(member.id, {
      notifyEmail: false,
      notifySms: false,
      notifyWhatsapp: true,
      notifyPush: false,
    });
    await setMemberWhatsappConsent(member.id, true, actor.id);
    const { notification } = await requestNotification(
      {
        organizationId: orgA.id,
        channel: "WHATSAPP",
        memberId: member.id,
        template: "admin_notice",
        subject: "Test",
        idempotencyKey: uniq("key"),
      },
      actor.id,
      { provider: whatsappProvider() },
    );
    expect(notification.status).toBe("SUPPRESSED");
    expect(notification.statusReason).toBe(
      SUPPRESSION_REASONS.DESTINATION_MISSING,
    );
  });

  it("suppresses a direct-destination WHATSAPP send — consent is member-scoped", async () => {
    // A memberless send names a raw destination and skips the member
    // preference path entirely. For WhatsApp that must never bypass
    // consent — the request records consent_missing and the provider
    // is never invoked.
    const provider = whatsappProvider();
    const { notification } = await requestNotification(
      {
        organizationId: orgA.id,
        channel: "WHATSAPP",
        destination: "5994161234",
        template: "admin_notice",
        subject: "Direct send attempt",
        idempotencyKey: uniq("key"),
      },
      actor.id,
      { provider },
    );
    expect(notification.status).toBe("SUPPRESSED");
    expect(notification.statusReason).toBe(SUPPRESSION_REASONS.CONSENT_MISSING);
    expect(provider.calls).toHaveLength(0);
  });

  /* ---------------- template dispatch ---------------- */

  it("dispatches a callout alert with Meta template params and the derived link", async () => {
    const member = await makeMember({ phone: "+599 416 1234" });
    await setMemberContactPreference(member.id, {
      notifyEmail: false,
      notifySms: false,
      notifyWhatsapp: true,
      notifyPush: false,
    });
    await setMemberWhatsappConsent(member.id, true, actor.id);
    const callout = await makeCallout("Missing hiker near Mount Scenery");
    const invitation = await makeInvitation(callout.id, member.id);

    const provider = whatsappProvider();
    const { notification } = await requestNotification(
      {
        organizationId: orgA.id,
        channel: "WHATSAPP",
        memberId: member.id,
        template: CALLOUT_INVITATION_TEMPLATE,
        subject: callout.title,
        bodyText: `Alert: ${callout.title} — {callout-response-url}`,
        metadata: { calloutId: callout.id, invitationId: invitation.id },
        idempotencyKey: uniq("key"),
      },
      actor.id,
      { provider },
    );

    expect(notification.status).toBe("ACCEPTED");
    expect(provider.calls).toHaveLength(1);
    const sent = provider.calls[0]!;
    // Destination normalized to bare E.164 digits.
    expect(sent.to).toBe("5994161234");
    expect(sent.channel).toBe("WHATSAPP");
    expect(sent.template?.name).toBe("sarbase_callout_alert");
    expect(sent.template?.parameters[0]).toBe(orgA.name);
    expect(sent.template?.parameters[1]).toBe(
      "Missing hiker near Mount Scenery",
    );
    // The secure link is a real derived respond URL — and it never
    // reached the stored body, which keeps its placeholder.
    const link = sent.template?.parameters[2] ?? "";
    expect(link).toMatch(/\/respond\?t=.+/);
    const stored = await prisma.notification.findUniqueOrThrow({
      where: { id: notification.id },
    });
    expect(stored.bodyText).toContain("{callout-response-url}");
    expect(stored.bodyText).not.toContain("/respond?t=");

    // The token the member received actually resolves the invitation —
    // same derivation the email channel would carry.
    const token = decodeURIComponent(link.split("t=")[1]!);
    const invite = await prisma.calloutInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    const { createHash } = await import("node:crypto");
    expect(invite.responseTokenHash).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
  });

  it("keeps EMAIL behavior unchanged — no template on the provider request", async () => {
    const member = await makeMember({ email: `${uniq("m")}@example.test` });
    await setMemberContactPreference(member.id, {
      notifyEmail: true,
      notifySms: false,
      notifyWhatsapp: false,
      notifyPush: false,
    });
    const provider = new FakeNotificationProvider();
    const { notification } = await requestNotification(
      {
        organizationId: orgA.id,
        channel: "EMAIL",
        memberId: member.id,
        template: "admin_test",
        subject: "Hello",
        bodyText: "Body",
        idempotencyKey: uniq("key"),
      },
      actor.id,
      { provider },
    );
    expect(notification.status).toBe("ACCEPTED");
    expect(provider.calls[0]!.template ?? null).toBeNull();
  });

  /* -------- dispatch-time consent re-check (issue #111) -------- */

  it("a retry refuses loudly once the member has opted out", async () => {
    const member = await makeMember({ phone: "+5994161234" });
    await setMemberContactPreference(member.id, {
      notifyEmail: false,
      notifySms: false,
      notifyWhatsapp: true,
      notifyPush: false,
    });
    await setMemberWhatsappConsent(member.id, true, actor.id);

    const provider = new FakeNotificationProvider({
      channel: "WHATSAPP",
      results: [fakeFailure.unavailable()],
    });
    const { notification } = await requestNotification(
      {
        organizationId: orgA.id,
        channel: "WHATSAPP",
        memberId: member.id,
        template: "admin_notice",
        subject: "Test",
        idempotencyKey: uniq("key"),
      },
      actor.id,
      { provider },
    );
    expect(notification.status).toBe("FAILED");

    // Member opts out AFTER the request was created and failed.
    await setMemberWhatsappConsent(member.id, false, actor.id);

    await expect(
      retryNotification(notification.id, { provider }),
    ).rejects.toThrow(/opted out of WhatsApp/i);
    // No new attempt row was appended — the provider was never re-invoked.
    expect(
      await prisma.notificationAttempt.count({
        where: { notificationId: notification.id },
      }),
    ).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });

  it("a never-dispatched request suppresses on resume once consent is gone", async () => {
    // Simulates the crash window: a PENDING request exists with no
    // attempt (created but never dispatched), and the member has since
    // opted out. Resume must not send — it becomes an honest late
    // suppression instead.
    const member = await makeMember({ phone: "+5994161234" });
    await setMemberWhatsappConsent(member.id, true, actor.id);
    await setMemberWhatsappConsent(member.id, false, actor.id);
    const pending = await prisma.notification.create({
      data: {
        organizationId: orgA.id,
        memberId: member.id,
        channel: "WHATSAPP",
        template: "admin_notice",
        subject: "Test",
        destination: "5994161234",
        idempotencyKey: uniq("key"),
        intentHash: uniq("hash"),
        status: "PENDING",
      },
    });
    const provider = whatsappProvider();
    const resumed = await retryNotification(pending.id, { provider });
    expect(resumed.status).toBe("SUPPRESSED");
    expect(resumed.statusReason).toBe(SUPPRESSION_REASONS.CONSENT_MISSING);
    expect(provider.calls).toHaveLength(0);
    expect(
      await prisma.notificationAttempt.count({
        where: { notificationId: pending.id },
      }),
    ).toBe(0);
  });
});
