import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Database-backed regression tests for the #33 replay-ordering fix in
 * `requestNotification` — run only via `npm run test:db`.
 *
 * The ordering contract: the (organizationId, idempotencyKey) lookup and
 * intentHash comparison run BEFORE provider resolution. An identical
 * replay of an already-recorded request is answered from the durable
 * record alone — it must keep succeeding even if provider configuration
 * has since become invalid, and must never resolve the provider at all.
 *
 * `resolveNotificationProvider` is mocked here so tests can both count
 * resolution attempts and simulate broken provider configuration
 * deterministically — no env flipping, no network.
 *
 * Fixture rows are prefixed `repltest-` for cleanup.
 */

const { resolveProviderMock } = vi.hoisted(() => ({
  resolveProviderMock: vi.fn(),
}));

vi.mock("@/lib/notifications/resolve", () => ({
  resolveNotificationProvider: resolveProviderMock,
}));

import { prisma } from "@/lib/prisma";
import {
  FakeNotificationProvider,
  fakeFailure,
} from "@/lib/notifications/fake";
import { NotificationConfigError } from "@/lib/notifications/provider";

import {
  NotificationIdempotencyConflictError,
  requestNotification,
} from "./notifications";
import { setMemberContactPreference } from "./availability";

const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "repltest-";

let counter = 0;
function uniq(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

let org: { id: string };
let member: { id: string; email: string | null };
let actor: { id: string };

function request(
  overrides: Partial<Parameters<typeof requestNotification>[0]> = {},
) {
  return requestNotification(
    {
      organizationId: org.id,
      channel: "EMAIL",
      memberId: member.id,
      template: "admin_test",
      subject: "Replay test",
      bodyText: "Replay test body",
      metadata: { source: "test" },
      idempotencyKey: uniq("key"),
      ...overrides,
    },
    actor.id,
  );
}

describe.skipIf(!hasDb)("notification replay ordering (post-#33 fix)", () => {
  beforeAll(async () => {
    org = await prisma.organization.create({ data: { name: uniq("org") } });
    member = await prisma.member.create({
      data: {
        organizationId: org.id,
        displayName: uniq("member"),
        email: `${uniq("m")}@example.test`,
      },
    });
    actor = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("actor"),
        email: `${uniq("actor")}@example.test`,
      },
    });
    await setMemberContactPreference(member.id, {
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

  it("resolves the provider for a genuinely new non-suppressed request", async () => {
    const provider = new FakeNotificationProvider();
    resolveProviderMock.mockReset().mockReturnValue(provider);
    const { notification } = await request();
    expect(notification.status).toBe("ACCEPTED");
    expect(resolveProviderMock).toHaveBeenCalledTimes(1);
    expect(provider.calls).toHaveLength(1);
  });

  it("identical replay succeeds with broken provider config — provider never resolved", async () => {
    const provider = new FakeNotificationProvider();
    resolveProviderMock.mockReset().mockReturnValue(provider);
    const key = uniq("replay-ok");
    const first = await request({ idempotencyKey: key });
    expect(first.notification.status).toBe("ACCEPTED");
    expect(provider.calls).toHaveLength(1);

    // Provider configuration breaks AFTER the original request was
    // recorded (e.g. RESEND_API_KEY removed between deployments).
    resolveProviderMock.mockReset().mockImplementation(() => {
      throw new NotificationConfigError(
        "Notification provider 'resend' requires RESEND_API_KEY and NOTIFICATION_EMAIL_FROM.",
      );
    });
    const replay = await request({ idempotencyKey: key });
    expect(replay.deduplicated).toBe(true);
    expect(replay.notification.id).toBe(first.notification.id);
    expect(replay.notification.status).toBe("ACCEPTED");
    // The replay was answered from the durable record alone.
    expect(resolveProviderMock).not.toHaveBeenCalled();
    expect(provider.calls).toHaveLength(1);
  });

  it("conflicting replay still fails loudly — without resolving the provider", async () => {
    const provider = new FakeNotificationProvider();
    resolveProviderMock.mockReset().mockReturnValue(provider);
    const key = uniq("conflict");
    await request({ idempotencyKey: key });
    resolveProviderMock.mockReset();
    await expect(
      request({ idempotencyKey: key, subject: "Different subject" }),
    ).rejects.toThrow(NotificationIdempotencyConflictError);
    expect(resolveProviderMock).not.toHaveBeenCalled();
  });

  it("a NEW request with broken provider config fails before any row is created", async () => {
    resolveProviderMock.mockReset().mockImplementation(() => {
      throw new NotificationConfigError("not configured");
    });
    const key = uniq("no-orphan");
    await expect(request({ idempotencyKey: key })).rejects.toThrow(
      NotificationConfigError,
    );
    expect(resolveProviderMock).toHaveBeenCalled();
    // No orphan row — not PENDING, not anything.
    const rows = await prisma.notification.count({
      where: { organizationId: org.id, idempotencyKey: key },
    });
    expect(rows).toBe(0);
  });

  it("a suppressed request still never resolves the provider", async () => {
    const quiet = await prisma.member.create({
      data: { organizationId: org.id, displayName: uniq("quiet") },
    });
    resolveProviderMock.mockReset();
    const { notification } = await request({ memberId: quiet.id });
    expect(notification.status).toBe("SUPPRESSED");
    expect(resolveProviderMock).not.toHaveBeenCalled();
    // And its replay is answered from the record too.
    await expect(
      request({
        memberId: quiet.id,
        idempotencyKey: notification.idempotencyKey,
      }),
    ).resolves.toMatchObject({ deduplicated: true });
    expect(resolveProviderMock).not.toHaveBeenCalled();
  });

  it("concurrent identical creates produce one row and one dispatch", async () => {
    const provider = new FakeNotificationProvider();
    resolveProviderMock.mockReset().mockReturnValue(provider);
    const key = uniq("race");
    const [a, b] = await Promise.all([
      request({ idempotencyKey: key }),
      request({ idempotencyKey: key }),
    ]);
    expect(a.notification.id).toBe(b.notification.id);
    expect([a.deduplicated, b.deduplicated].sort()).toEqual([false, true]);
    const rows = await prisma.notification.count({
      where: { organizationId: org.id, idempotencyKey: key },
    });
    expect(rows).toBe(1);
    const attempts = await prisma.notificationAttempt.count({
      where: { notificationId: a.notification.id },
    });
    expect(attempts).toBe(1);
  });

  it("concurrent conflicting creates resolve to one winner plus a conflict", async () => {
    const provider = new FakeNotificationProvider();
    resolveProviderMock.mockReset().mockReturnValue(provider);
    const key = uniq("race-conflict");
    const [a, b] = await Promise.allSettled([
      request({ idempotencyKey: key }),
      request({ idempotencyKey: key, subject: "Different subject" }),
    ]);
    const settled = [a, b].map((r) =>
      r.status === "fulfilled" ? "ok" : (r.reason as Error).name,
    );
    expect(settled).toContain("ok");
    // The loser either hit the early-lookup conflict path or the P2002
    // race path — both surface the same error.
    expect(settled).toContain("NotificationIdempotencyConflictError");
    const rows = await prisma.notification.findMany({
      where: { organizationId: org.id, idempotencyKey: key },
    });
    expect(rows).toHaveLength(1);
  });

  it("replay of a FAILED request returns it without touching the provider", async () => {
    const provider = new FakeNotificationProvider({
      defaultResult: fakeFailure.unavailable(),
    });
    resolveProviderMock.mockReset().mockReturnValue(provider);
    const key = uniq("replay-failed");
    const first = await request({ idempotencyKey: key });
    expect(first.notification.status).toBe("FAILED");

    resolveProviderMock.mockReset();
    const replay = await request({ idempotencyKey: key });
    expect(replay.deduplicated).toBe(true);
    expect(replay.notification.id).toBe(first.notification.id);
    expect(replay.notification.status).toBe("FAILED");
    expect(resolveProviderMock).not.toHaveBeenCalled();
  });
});
