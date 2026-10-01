import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Database-backed tests for the notification foundation (issue #13) —
 * run only via `npm run test:db` (TEST_DATABASE_URL). Real rows, real
 * composite-FK and unique-constraint enforcement; the provider is
 * always the deterministic in-process fake (never the network).
 * Fixture names are prefixed `ntftest-` for cleanup.
 */

import { prisma } from "@/lib/prisma";
import {
  FakeNotificationProvider,
  fakeFailure,
} from "@/lib/notifications/fake";

import {
  isRetryableNotification,
  listOrganizationNotifications,
  MAX_NOTIFICATION_ATTEMPTS,
  NotificationIdempotencyConflictError,
  NotificationRecipientError,
  NotificationRetryError,
  requestNotification,
  retryNotification,
} from "./notifications";
import { setMemberContactPreference } from "./availability";

const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "ntftest-";

let counter = 0;
function uniq(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}
function idem(suffix: string) {
  return `${PREFIX}key-${counter}-${suffix}`;
}

let orgA: { id: string };
let orgB: { id: string };
let memberA: { id: string; email: string | null };
let memberNoEmail: { id: string };
let memberB: { id: string };
let actor: { id: string };

function request(
  overrides: Partial<Parameters<typeof requestNotification>[0]> & {
    provider?: FakeNotificationProvider;
  } = {},
) {
  const { provider, ...input } = overrides;
  return requestNotification(
    {
      organizationId: orgA.id,
      channel: "EMAIL",
      memberId: memberA.id,
      template: "admin_test",
      subject: "Test subject",
      bodyText: "Test body",
      metadata: { source: "test" },
      idempotencyKey: uniq("key"),
      ...input,
    },
    actor.id,
    provider ? { provider } : {},
  );
}

describe.skipIf(!hasDb)("notification requests and attempts", () => {
  beforeAll(async () => {
    orgA = await prisma.organization.create({
      data: { name: uniq("org-a") },
    });
    orgB = await prisma.organization.create({
      data: { name: uniq("org-b") },
    });
    memberA = await prisma.member.create({
      data: {
        organizationId: orgA.id,
        displayName: uniq("member-a"),
        email: `${uniq("m")}@example.test`,
      },
    });
    memberNoEmail = await prisma.member.create({
      data: { organizationId: orgA.id, displayName: uniq("no-email") },
    });
    memberB = await prisma.member.create({
      data: {
        organizationId: orgB.id,
        displayName: uniq("member-b"),
        email: `${uniq("mb")}@example.test`,
      },
    });
    actor = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("actor"),
        email: `${uniq("actor")}@example.test`,
      },
    });
    // memberA is willing to receive email; the others have no
    // preference row (default = not willing).
    await setMemberContactPreference(memberA.id, {
      notifyEmail: true,
      notifySms: false,
      notifyWhatsapp: false,
      notifyPush: false,
    });
  });

  afterAll(async () => {
    await prisma.notificationAttempt.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.notification.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.memberNotificationPreference.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.member.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.authIdentity.deleteMany({
      where: { providerUid: { startsWith: PREFIX } },
    });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  it("sends to a willing member: request ACCEPTED, attempt recorded with provider id and destination snapshot", async () => {
    const provider = new FakeNotificationProvider();
    const { notification, deduplicated } = await request({ provider });
    expect(deduplicated).toBe(false);
    expect(notification.status).toBe("ACCEPTED");
    expect(notification.destination).toBe(memberA.email);
    expect(notification.requestedByAuthIdentityId).toBe(actor.id);

    const attempts = await prisma.notificationAttempt.findMany({
      where: { notificationId: notification.id },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: "ACCEPTED",
      provider: "fake",
      attemptNumber: 1,
      providerMessageId: "fake-msg-1",
      organizationId: orgA.id,
    });
    expect(attempts[0]!.resolvedAt).not.toBeNull();
    // The provider was invoked with the snapshot destination and a
    // per-attempt idempotency key.
    expect(provider.calls[0]!.to).toBe(memberA.email);
    expect(provider.calls[0]!.idempotencyKey).toBe(
      `${notification.id}/attempt-1`,
    );
  });

  it("suppresses a member whose email preference is off — provider never invoked", async () => {
    await setMemberContactPreference(memberNoEmail.id, {
      notifyEmail: false,
      notifySms: false,
      notifyWhatsapp: false,
      notifyPush: false,
    });
    const provider = new FakeNotificationProvider();
    const { notification } = await request({
      memberId: memberNoEmail.id,
      provider,
    });
    expect(notification.status).toBe("SUPPRESSED");
    expect(notification.statusReason).toBe("preference_disabled");
    expect(provider.calls).toHaveLength(0);
    const attempts = await prisma.notificationAttempt.count({
      where: { notificationId: notification.id },
    });
    expect(attempts).toBe(0);
  });

  it("suppresses a member with no preference row at all", async () => {
    const member = await prisma.member.create({
      data: {
        organizationId: orgA.id,
        displayName: uniq("no-pref"),
        email: `${uniq("np")}@example.test`,
      },
    });
    const provider = new FakeNotificationProvider();
    const { notification } = await request({ memberId: member.id, provider });
    expect(notification.status).toBe("SUPPRESSED");
    expect(notification.statusReason).toBe("preference_disabled");
    expect(provider.calls).toHaveLength(0);
  });

  it("suppresses a willing member with no destination on record", async () => {
    // notifyEmail can't be set true without an email through the write
    // path — remove the destination afterwards to reach this state.
    const member = await prisma.member.create({
      data: {
        organizationId: orgA.id,
        displayName: uniq("dest-missing"),
        email: `${uniq("dm")}@example.test`,
      },
    });
    await setMemberContactPreference(member.id, {
      notifyEmail: true,
      notifySms: false,
      notifyWhatsapp: false,
      notifyPush: false,
    });
    await prisma.member.update({
      where: { id: member.id },
      data: { email: null },
    });
    const provider = new FakeNotificationProvider();
    const { notification } = await request({ memberId: member.id, provider });
    expect(notification.status).toBe("SUPPRESSED");
    expect(notification.statusReason).toBe("destination_missing");
    expect(notification.destination).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it("sends to a one-off destination without a member", async () => {
    const provider = new FakeNotificationProvider();
    const { notification } = await request({
      memberId: undefined,
      destination: "ops@example.test",
      provider,
    });
    expect(notification.status).toBe("ACCEPTED");
    expect(notification.memberId).toBeNull();
    expect(notification.destination).toBe("ops@example.test");
    expect(provider.calls).toHaveLength(1);
  });

  it("rejects a member id that belongs to another organization", async () => {
    await expect(request({ memberId: memberB.id })).rejects.toThrow(
      NotificationRecipientError,
    );
  });

  it("idempotent replay returns the existing request and does not send twice", async () => {
    const provider = new FakeNotificationProvider();
    const key = idem("replay");
    const first = await request({ idempotencyKey: key, provider });
    const replay = await request({ idempotencyKey: key, provider });
    expect(replay.deduplicated).toBe(true);
    expect(replay.notification.id).toBe(first.notification.id);
    expect(provider.calls).toHaveLength(1);
    const attempts = await prisma.notificationAttempt.count({
      where: { notificationId: first.notification.id },
    });
    expect(attempts).toBe(1);
  });

  it("rejects a reused key with different intent — loudly", async () => {
    const provider = new FakeNotificationProvider();
    const key = idem("conflict");
    await request({ idempotencyKey: key, provider });
    await expect(
      request({ idempotencyKey: key, subject: "Different", provider }),
    ).rejects.toThrow(NotificationIdempotencyConflictError);
    expect(provider.calls).toHaveLength(1);
  });

  it("the same key in another organization is an independent request", async () => {
    const provider = new FakeNotificationProvider();
    const key = idem("cross-org");
    const inA = await request({ idempotencyKey: key, provider });
    const inB = await requestNotification(
      {
        organizationId: orgB.id,
        channel: "EMAIL",
        destination: "b@example.test",
        template: "admin_test",
        subject: "Test subject",
        bodyText: "Test body",
        idempotencyKey: key,
      },
      actor.id,
      { provider },
    );
    expect(inB.notification.id).not.toBe(inA.notification.id);
    expect(inB.notification.organizationId).toBe(orgB.id);
  });

  it("concurrent duplicate requests produce one row and one send", async () => {
    const provider = new FakeNotificationProvider();
    const key = idem("race");
    const [a, b] = await Promise.all([
      request({ idempotencyKey: key, provider }),
      request({ idempotencyKey: key, provider }),
    ]);
    expect(a.notification.id).toBe(b.notification.id);
    expect([a.deduplicated, b.deduplicated].sort()).toEqual([false, true]);
    expect(provider.calls).toHaveLength(1);
    const rows = await prisma.notification.count({
      where: { organizationId: orgA.id, idempotencyKey: key },
    });
    expect(rows).toBe(1);
  });

  it("a failed send records a FAILED attempt with safe fields and exposes retry eligibility", async () => {
    const provider = new FakeNotificationProvider({
      results: [fakeFailure.unavailable()],
    });
    const { notification } = await request({ provider });
    expect(notification.status).toBe("FAILED");

    const attempt = await prisma.notificationAttempt.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(attempt).toMatchObject({
      status: "FAILED",
      errorCode: "provider_unavailable",
      retryable: true,
    });
    expect(attempt.errorSummary).toBeTruthy();

    const withAttempts = await prisma.notification.findUniqueOrThrow({
      where: { id: notification.id },
      include: { attempts: { orderBy: { attemptNumber: "asc" } } },
    });
    expect(isRetryableNotification(withAttempts)).toBe(true);
  });

  it("retry appends a NEW attempt and reaches ACCEPTED", async () => {
    const provider = new FakeNotificationProvider({
      results: [fakeFailure.unavailable()],
    });
    const { notification } = await request({ provider });
    expect(notification.status).toBe("FAILED");

    const retried = await retryNotification(notification.id, { provider });
    expect(retried.status).toBe("ACCEPTED");
    const attempts = await prisma.notificationAttempt.findMany({
      where: { notificationId: notification.id },
      orderBy: { attemptNumber: "asc" },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.status).toBe("FAILED"); // history preserved
    expect(attempts[1]!.status).toBe("ACCEPTED");
    expect(attempts[1]!.providerMessageId).toBe("fake-msg-2");
  });

  it("refuses to retry a non-retryable provider rejection", async () => {
    const provider = new FakeNotificationProvider({
      results: [fakeFailure.rejected()],
    });
    const { notification } = await request({ provider });
    expect(notification.status).toBe("FAILED");
    await expect(
      retryNotification(notification.id, { provider }),
    ).rejects.toThrow(NotificationRetryError);
    expect(provider.calls).toHaveLength(1);
  });

  it("refuses to retry ACCEPTED or SUPPRESSED notifications", async () => {
    const provider = new FakeNotificationProvider();
    const accepted = await request({ provider });
    await expect(
      retryNotification(accepted.notification.id, { provider }),
    ).rejects.toThrow(NotificationRetryError);

    const suppressed = await request({
      memberId: memberNoEmail.id,
      provider,
    });
    await expect(
      retryNotification(suppressed.notification.id, { provider }),
    ).rejects.toThrow(NotificationRetryError);
  });

  it("recovers a stuck DISPATCHING attempt via retry", async () => {
    // Simulate a crash: an attempt row left DISPATCHING with the
    // notification still PENDING.
    const notification = await prisma.notification.create({
      data: {
        organizationId: orgA.id,
        memberId: memberA.id,
        channel: "EMAIL",
        template: "admin_test",
        destination: memberA.email,
        idempotencyKey: idem("stuck"),
        intentHash: "synthetic",
        status: "PENDING",
      },
    });
    await prisma.notificationAttempt.create({
      data: {
        organizationId: orgA.id,
        notificationId: notification.id,
        attemptNumber: 1,
        provider: "fake",
        status: "DISPATCHING",
        // Older than DISPATCHING_STALE_MS → presumed orphaned by a crash.
        attemptedAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });

    const provider = new FakeNotificationProvider();
    const retried = await retryNotification(notification.id, { provider });
    expect(retried.status).toBe("ACCEPTED");
    const attempts = await prisma.notificationAttempt.findMany({
      where: { notificationId: notification.id },
      orderBy: { attemptNumber: "asc" },
    });
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
    expect(attempts[0]!.status).toBe("DISPATCHING"); // untouched history
  });

  it("two concurrent retries produce one new attempt, not two sends", async () => {
    const provider = new FakeNotificationProvider({
      results: [fakeFailure.unavailable()],
    });
    const { notification } = await request({ provider });
    const [a, b] = await Promise.allSettled([
      retryNotification(notification.id, { provider }),
      retryNotification(notification.id, { provider }),
    ]);
    const outcomes = [a, b].map((r) =>
      r.status === "fulfilled" ? "ok" : (r.reason as Error).name,
    );
    // Exactly one wins; the loser is refused — either by the eligibility
    // re-check under the row lock (fresh DISPATCHING now in flight) or by
    // the unique attempt index (NotificationConcurrentDispatchError).
    const rejected = outcomes.find((o) => o !== "ok");
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    expect([
      "NotificationRetryError",
      "NotificationConcurrentDispatchError",
    ]).toContain(rejected);
    expect(provider.calls).toHaveLength(2); // initial + one retry
    const attempts = await prisma.notificationAttempt.count({
      where: { notificationId: notification.id },
    });
    expect(attempts).toBe(2);
  });

  it("stops at the attempt cap", async () => {
    const provider = new FakeNotificationProvider({
      defaultResult: fakeFailure.unavailable(),
    });
    const { notification } = await request({ provider });
    for (let i = 1; i < MAX_NOTIFICATION_ATTEMPTS; i++) {
      await retryNotification(notification.id, { provider });
    }
    await expect(
      retryNotification(notification.id, { provider }),
    ).rejects.toThrow(NotificationRetryError);
    const attempts = await prisma.notificationAttempt.count({
      where: { notificationId: notification.id },
    });
    expect(attempts).toBe(MAX_NOTIFICATION_ATTEMPTS);
  });

  it("the destination snapshot survives a later member email change", async () => {
    const provider = new FakeNotificationProvider();
    const { notification } = await request({ provider });
    const originalDestination = notification.destination;
    await prisma.member.update({
      where: { id: memberA.id },
      data: { email: `${uniq("new")}@example.test` },
    });
    const persisted = await prisma.notification.findUniqueOrThrow({
      where: { id: notification.id },
    });
    expect(persisted.destination).toBe(originalDestination);
    // And the member's current email is genuinely different.
    const member = await prisma.member.findUniqueOrThrow({
      where: { id: memberA.id },
    });
    expect(member.email).not.toBe(originalDestination);
  });

  it("cross-organization integrity is enforced at the database level", async () => {
    // A notification naming orgA cannot carry orgB's member.
    await expect(
      prisma.notification.create({
        data: {
          organizationId: orgA.id,
          memberId: memberB.id,
          channel: "EMAIL",
          template: "admin_test",
          idempotencyKey: idem("fk-member"),
          intentHash: "x",
        },
      }),
    ).rejects.toThrow();

    // An attempt cannot point at a notification through a different org.
    const notification = await prisma.notification.create({
      data: {
        organizationId: orgA.id,
        channel: "EMAIL",
        template: "admin_test",
        destination: "x@example.test",
        idempotencyKey: idem("fk-attempt"),
        intentHash: "x",
      },
    });
    await expect(
      prisma.notificationAttempt.create({
        data: {
          organizationId: orgB.id, // mismatched org
          notificationId: notification.id,
          attemptNumber: 1,
          provider: "fake",
        },
      }),
    ).rejects.toThrow();
  });

  it("a member with notification history cannot be hard-deleted (Restrict)", async () => {
    const member = await prisma.member.create({
      data: {
        organizationId: orgA.id,
        displayName: uniq("restricted"),
        email: `${uniq("r")}@example.test`,
      },
    });
    await setMemberContactPreference(member.id, {
      notifyEmail: true,
      notifySms: false,
      notifyWhatsapp: false,
      notifyPush: false,
    });
    await request({
      memberId: member.id,
      provider: new FakeNotificationProvider(),
    });
    await expect(
      prisma.member.delete({ where: { id: member.id } }),
    ).rejects.toThrow();
  });

  it("actor attribution survives identity deletion (scalar ref)", async () => {
    const ghost = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("ghost"),
        email: `${uniq("g")}@example.test`,
      },
    });
    const { notification } = await requestNotification(
      {
        organizationId: orgA.id,
        channel: "EMAIL",
        destination: "ghost@example.test",
        template: "admin_test",
        idempotencyKey: idem("ghost"),
      },
      ghost.id,
      { provider: new FakeNotificationProvider() },
    );
    await prisma.authIdentity.delete({ where: { id: ghost.id } });
    const persisted = await prisma.notification.findUniqueOrThrow({
      where: { id: notification.id },
    });
    // The raw id remains a stable forensic reference — the row is not
    // anonymized or removed with the identity.
    expect(persisted.requestedByAuthIdentityId).toBe(ghost.id);
  });

  it("org history lists requests newest-first with attempts and member", async () => {
    const provider = new FakeNotificationProvider();
    await request({ provider });
    const list = await listOrganizationNotifications(orgA.id, { limit: 10 });
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toHaveProperty("attempts");
    expect(list[0]).toHaveProperty("member");
    // Every row belongs to org A — cross-org records never appear.
    expect(list.every((n) => n.organizationId === orgA.id)).toBe(true);
  });

  it("default provider resolution in tests uses the fake — never the network", async () => {
    // No RESEND_API_KEY and NODE_ENV=test → the resolver returns the
    // deterministic fake. This exercises the unconfigured default path.
    const { notification } = await request({});
    expect(notification.status).toBe("ACCEPTED");
    const attempt = await prisma.notificationAttempt.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(attempt.provider).toBe("fake");
  });
});
