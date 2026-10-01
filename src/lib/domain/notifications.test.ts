import { describe, expect, it } from "vitest";

import {
  FakeNotificationProvider,
  fakeFailure,
} from "@/lib/notifications/fake";

import {
  computeIntentHash,
  isRetryableNotification,
  MAX_NOTIFICATION_ATTEMPTS,
} from "./notifications";
import { adminNotificationSendSchema, idempotencyKeySchema } from "./schemas";

/**
 * Pure unit tests for the notification domain — hashing, retry
 * eligibility, and input validation. Database-backed behavior lives in
 * notifications.db.test.ts.
 */

const baseIntent = {
  channel: "EMAIL",
  memberId: "mem_1",
  destination: "a@example.org",
  template: "admin_test",
  subject: "Hi",
  bodyText: "Body",
  metadata: { source: "admin_test_send" },
};

describe("computeIntentHash", () => {
  it("is deterministic and field-order insensitive for metadata", () => {
    const a = computeIntentHash({
      ...baseIntent,
      metadata: { a: "1", b: "2" },
    });
    const b = computeIntentHash({
      ...baseIntent,
      metadata: { b: "2", a: "1" },
    });
    expect(a).toBe(b);
  });

  it("differs when any content-bearing field differs", () => {
    const base = computeIntentHash(baseIntent);
    for (const variant of [
      { destination: "other@example.org" },
      { subject: "Different" },
      { bodyText: "Different body" },
      { memberId: "mem_2" },
      { template: "other_template" },
      { metadata: { source: "other" } },
    ]) {
      expect(computeIntentHash({ ...baseIntent, ...variant })).not.toBe(base);
    }
  });
});

describe("isRetryableNotification", () => {
  const STALE = new Date(Date.now() - 60 * 60 * 1000);
  const FRESH = new Date();
  const make = (
    status: string,
    attempts: { status: string; retryable: boolean; attemptedAt?: Date }[],
  ) =>
    isRetryableNotification({
      id: "n1",
      organizationId: "o1",
      memberId: null,
      channel: "EMAIL",
      template: "t",
      subject: null,
      bodyText: null,
      destination: null,
      metadata: null,
      idempotencyKey: "k",
      intentHash: "h",
      status: status as never,
      statusReason: null,
      requestedByAuthIdentityId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      attempts: attempts.map((a) => ({
        status: a.status as never,
        retryable: a.retryable,
        attemptedAt: a.attemptedAt ?? new Date(),
      })),
    });

  it("allows retry on a retryable FAILED attempt", () => {
    expect(make("FAILED", [{ status: "FAILED", retryable: true }])).toBe(true);
  });

  it("refuses retry on a non-retryable provider rejection", () => {
    expect(make("FAILED", [{ status: "FAILED", retryable: false }])).toBe(
      false,
    );
  });

  it("allows retry on a STALE DISPATCHING attempt (crash recovery)", () => {
    expect(
      make("PENDING", [
        { status: "DISPATCHING", retryable: false, attemptedAt: STALE },
      ]),
    ).toBe(true);
  });

  it("refuses retry while a DISPATCHING attempt is fresh (in flight)", () => {
    expect(
      make("PENDING", [
        { status: "DISPATCHING", retryable: false, attemptedAt: FRESH },
      ]),
    ).toBe(false);
  });

  it("allows a PENDING request that never got an attempt", () => {
    expect(make("PENDING", [])).toBe(true);
  });

  it("refuses terminal SUPPRESSED and ACCEPTED states", () => {
    expect(make("SUPPRESSED", [])).toBe(false);
    expect(make("ACCEPTED", [{ status: "ACCEPTED", retryable: false }])).toBe(
      false,
    );
  });

  it("refuses once the attempt cap is reached", () => {
    const attempts = Array.from({ length: MAX_NOTIFICATION_ATTEMPTS }, () => ({
      status: "FAILED",
      retryable: true,
    }));
    expect(make("FAILED", attempts)).toBe(false);
  });
});

describe("FakeNotificationProvider", () => {
  it("accepts by default with deterministic message ids", async () => {
    const provider = new FakeNotificationProvider();
    const r1 = await provider.send({
      channel: "EMAIL",
      to: "a@example.org",
      subject: "s",
      text: "b",
      idempotencyKey: "k1",
    });
    const r2 = await provider.send({
      channel: "EMAIL",
      to: "b@example.org",
      subject: "s",
      text: "b",
      idempotencyKey: "k2",
    });
    expect(r1).toEqual({ status: "accepted", providerMessageId: "fake-msg-1" });
    expect(r2).toEqual({ status: "accepted", providerMessageId: "fake-msg-2" });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]!.to).toBe("a@example.org");
  });

  it("plays scripted failures then falls back to the default", async () => {
    const provider = new FakeNotificationProvider({
      results: [fakeFailure.unavailable()],
    });
    expect(
      (
        await provider.send({
          channel: "EMAIL",
          to: "x@example.org",
          subject: null,
          text: null,
          idempotencyKey: "k",
        })
      ).status,
    ).toBe("failed");
    expect(
      (
        await provider.send({
          channel: "EMAIL",
          to: "x@example.org",
          subject: null,
          text: null,
          idempotencyKey: "k",
        })
      ).status,
    ).toBe("accepted");
  });

  it("can return a scripted non-retryable rejection", async () => {
    const provider = new FakeNotificationProvider({
      results: [fakeFailure.rejected()],
      defaultResult: { status: "accepted", providerMessageId: "late" },
    });
    const r = await provider.send({
      channel: "EMAIL",
      to: "x@example.org",
      subject: null,
      text: null,
      idempotencyKey: "k",
    });
    expect(r).toMatchObject({
      status: "failed",
      errorCode: "provider_rejected",
      retryable: false,
    });
  });
});

describe("adminNotificationSendSchema", () => {
  const valid = {
    subject: "Radio check",
    body: "Weekly radio check reminder.",
    idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
  };

  it("accepts a member target", () => {
    const parsed = adminNotificationSendSchema.safeParse({
      ...valid,
      memberId: "mem_1",
      destination: "",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a one-off destination", () => {
    const parsed = adminNotificationSendSchema.safeParse({
      ...valid,
      memberId: "",
      destination: "ops@example.org",
    });
    expect(parsed.success).toBe(true);
  });

  it("requires exactly one of member or destination", () => {
    expect(
      adminNotificationSendSchema.safeParse({
        ...valid,
        memberId: "mem_1",
        destination: "ops@example.org",
      }).success,
    ).toBe(false);
    expect(
      adminNotificationSendSchema.safeParse({
        ...valid,
        memberId: "",
        destination: "",
      }).success,
    ).toBe(false);
  });

  it("rejects malformed destinations and overlong bodies", () => {
    expect(
      adminNotificationSendSchema.safeParse({
        ...valid,
        destination: "not-an-email",
      }).success,
    ).toBe(false);
    expect(
      adminNotificationSendSchema.safeParse({
        ...valid,
        destination: "ops@example.org",
        body: "x".repeat(4001),
      }).success,
    ).toBe(false);
  });
});

describe("idempotencyKeySchema", () => {
  it("accepts bounded printable keys", () => {
    expect(
      idempotencyKeySchema.safeParse("550e8400-e29b-41d4-a716-446655440000")
        .success,
    ).toBe(true);
    expect(idempotencyKeySchema.safeParse("callout:42/attempt-1").success).toBe(
      true,
    );
  });

  it("rejects whitespace, short, and overlong keys", () => {
    expect(idempotencyKeySchema.safeParse("").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("short").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("a b c d e f g h").success).toBe(
      false,
    );
    expect(idempotencyKeySchema.safeParse("x".repeat(201)).success).toBe(false);
  });
});
