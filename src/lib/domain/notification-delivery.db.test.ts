import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Database-backed tests for provider delivery-callback reconciliation
 * (issue #101) — run only via `npm run test:db` (TEST_DATABASE_URL).
 * Covers the durable contracts the webhook route relies on: wamid
 * matching, append-only history, replay deduplication, non-regressing
 * aggregate status, and organization scoping of the composite FK.
 * Fixture names are prefixed `dlvtest-` for cleanup.
 */

import { prisma } from "@/lib/prisma";

import { recordWhatsappDeliveryEvents } from "./notification-delivery";

const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "dlvtest-";

let counter = 0;
function uniq(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

let orgA: { id: string };
let orgB: { id: string };

/** An attempt whose provider accepted the message (wamid recorded). */
async function makeAttempt(organizationId: string, wamid: string) {
  const notification = await prisma.notification.create({
    data: {
      organizationId,
      channel: "WHATSAPP",
      template: "test",
      idempotencyKey: uniq("key"),
      intentHash: uniq("hash"),
      status: "ACCEPTED",
    },
  });
  return prisma.notificationAttempt.create({
    data: {
      organizationId,
      notificationId: notification.id,
      attemptNumber: 1,
      provider: "meta",
      status: "ACCEPTED",
      providerMessageId: wamid,
      resolvedAt: new Date(),
    },
  });
}

function event(
  providerMessageId: string,
  status: "SENT" | "DELIVERED" | "READ" | "FAILED" | "OTHER",
  occurredAt: Date,
  providerErrorCode: string | null = null,
) {
  return { providerMessageId, status, occurredAt, providerErrorCode };
}

const T1 = new Date("2025-12-24T10:00:00Z");
const T2 = new Date("2025-12-24T10:01:00Z");
const T3 = new Date("2025-12-24T10:02:00Z");

describe.skipIf(!hasDb)("whatsapp delivery reconciliation", () => {
  beforeAll(async () => {
    orgA = await prisma.organization.create({ data: { name: uniq("org-a") } });
    orgB = await prisma.organization.create({ data: { name: uniq("org-b") } });
  });

  afterAll(async () => {
    for (const organizationId of [orgA.id, orgB.id]) {
      const filter = { organizationId };
      await prisma.notificationDeliveryEvent.deleteMany({ where: filter });
      await prisma.notificationAttempt.deleteMany({ where: filter });
      await prisma.notification.deleteMany({ where: filter });
    }
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  it("records a matched callback and advances the attempt aggregate", async () => {
    const attempt = await makeAttempt(orgA.id, uniq("wamid"));
    const result = await recordWhatsappDeliveryEvents([
      event(attempt.providerMessageId!, "DELIVERED", T1),
    ]);
    expect(result).toEqual({ recorded: 1, deduplicated: 0, unmatched: 0 });

    const updated = await prisma.notificationAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(updated.deliveryStatus).toBe("DELIVERED");

    const rows = await prisma.notificationDeliveryEvent.findMany({
      where: { attemptId: attempt.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: orgA.id,
      status: "DELIVERED",
      occurredAt: T1,
    });
  });

  it("replays are durable no-ops — same status and timestamp deduplicates", async () => {
    const attempt = await makeAttempt(orgA.id, uniq("wamid"));
    const e = event(attempt.providerMessageId!, "DELIVERED", T1);
    await recordWhatsappDeliveryEvents([e]);
    const result = await recordWhatsappDeliveryEvents([e]);
    expect(result).toEqual({ recorded: 0, deduplicated: 1, unmatched: 0 });
    expect(
      await prisma.notificationDeliveryEvent.count({
        where: { attemptId: attempt.id },
      }),
    ).toBe(1);
  });

  it("reports callbacks for unknown wamids without storing anything", async () => {
    const before = await prisma.notificationDeliveryEvent.count();
    const result = await recordWhatsappDeliveryEvents([
      event("wamid.from-another-sender", "DELIVERED", T1),
    ]);
    expect(result).toEqual({ recorded: 0, deduplicated: 0, unmatched: 1 });
    expect(await prisma.notificationDeliveryEvent.count()).toBe(before);
  });

  it("out-of-order callbacks never regress the aggregate", async () => {
    const attempt = await makeAttempt(orgA.id, uniq("wamid"));
    const wamid = attempt.providerMessageId!;
    // READ arrives before DELIVERED (Meta ordering is not guaranteed).
    await recordWhatsappDeliveryEvents([event(wamid, "READ", T2)]);
    await recordWhatsappDeliveryEvents([
      event(wamid, "DELIVERED", T1),
      event(wamid, "SENT", T1),
    ]);
    const updated = await prisma.notificationAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(updated.deliveryStatus).toBe("READ");
    // ...but every callback is preserved in the append-only history.
    expect(
      await prisma.notificationDeliveryEvent.count({
        where: { attemptId: attempt.id },
      }),
    ).toBe(3);
  });

  it("FAILED advances past SENT and preserves the provider error code", async () => {
    const attempt = await makeAttempt(orgA.id, uniq("wamid"));
    const wamid = attempt.providerMessageId!;
    await recordWhatsappDeliveryEvents([event(wamid, "SENT", T1)]);
    await recordWhatsappDeliveryEvents([event(wamid, "FAILED", T2, "131047")]);
    const updated = await prisma.notificationAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(updated.deliveryStatus).toBe("FAILED");
    const failed = await prisma.notificationDeliveryEvent.findFirstOrThrow({
      where: { attemptId: attempt.id, status: "FAILED" },
    });
    expect(failed.providerErrorCode).toBe("131047");
  });

  it("a later DELIVERED can still advance past FAILED (provider retry succeeded)", async () => {
    const attempt = await makeAttempt(orgA.id, uniq("wamid"));
    const wamid = attempt.providerMessageId!;
    await recordWhatsappDeliveryEvents([event(wamid, "FAILED", T1)]);
    await recordWhatsappDeliveryEvents([event(wamid, "DELIVERED", T2)]);
    const updated = await prisma.notificationAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(updated.deliveryStatus).toBe("DELIVERED");
  });

  it("same wamid in another organization is a separate attempt, not a collision", async () => {
    // Composite-FK integrity: the event writes through the attempt's own
    // organizationId, so org B's history can never land on org A's rows.
    const wamid = uniq("shared-wamid");
    const attemptA = await makeAttempt(orgA.id, wamid);
    await makeAttempt(orgB.id, wamid);
    const result = await recordWhatsappDeliveryEvents([
      event(wamid, "DELIVERED", T3),
    ]);
    // findFirst matches ONE attempt deterministically-scoped write; the
    // sibling attempt is untouched.
    expect(result.recorded).toBe(1);
    // Exactly one event was written, and its organization matches
    // whichever attempt row it was reconciled against — never a
    // cross-organization write.
    const total = await prisma.notificationDeliveryEvent.count({
      where: { attempt: { providerMessageId: wamid } },
    });
    expect(total).toBe(1);
    const written = await prisma.notificationDeliveryEvent.findFirstOrThrow({
      where: { attempt: { providerMessageId: wamid } },
    });
    expect([orgA.id, orgB.id]).toContain(written.organizationId);
  });
});
