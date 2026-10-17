/**
 * Provider delivery-callback reconciliation (issue #101).
 *
 * WhatsApp status webhooks arrive at `app/api/webhooks/whatsapp`,
 * already signature-verified and shape-parsed. This module matches each
 * normalized status to the NotificationAttempt that produced the
 * provider message id and records the fact.
 *
 * Contracts:
 * - Append-only history. Every matched callback lands as a
 *   NotificationDeliveryEvent row; duplicates are durable no-ops via
 *   the (attemptId, status, occurredAt) unique constraint — Meta
 *   retries callbacks and a 200 must be safely replayable.
 * - Non-regressing aggregate. `attempt.deliveryStatus` only advances
 *   along OTHER < SENT < FAILED < DELIVERED < READ (see schema doc for
 *   the FAILED placement rationale). The update is a conditional
 *   `updateMany` — two callbacks racing can't move the aggregate
 *   backwards.
 * - Facts, not conclusions. A READ event never marks a callout
 *   acknowledged; nothing here touches invitations or responses.
 * - Unmatched wamids are reported, not stored — a signed payload may
 *   reference messages sent outside SARbase (test sends, other apps on
 *   the same sender).
 */

import { Prisma } from "@prisma/client";
import type { NotificationDeliveryStatus } from "@prisma/client";

import type { WhatsappStatusEvent } from "@/lib/notifications/whatsapp-webhook";
import { prisma } from "@/lib/prisma";

/** Statuses strictly below `s` — the conditional-update guard. */
const LOWER_THAN: Record<
  NotificationDeliveryStatus,
  NotificationDeliveryStatus[]
> = {
  OTHER: [],
  SENT: ["OTHER"],
  FAILED: ["OTHER", "SENT"],
  DELIVERED: ["OTHER", "SENT", "FAILED"],
  READ: ["OTHER", "SENT", "FAILED", "DELIVERED"],
};

export interface DeliveryEventIngestResult {
  /** New event rows written. */
  recorded: number;
  /** Matched callbacks that were already recorded (replays). */
  deduplicated: number;
  /** Callbacks whose providerMessageId matched no attempt. */
  unmatched: number;
}

export async function recordWhatsappDeliveryEvents(
  events: WhatsappStatusEvent[],
): Promise<DeliveryEventIngestResult> {
  const result: DeliveryEventIngestResult = {
    recorded: 0,
    deduplicated: 0,
    unmatched: 0,
  };

  for (const event of events) {
    // providerMessageId (Meta wamid) is globally unique in practice;
    // scoping the write through the attempt's own organizationId keeps
    // the composite-FK invariant even if a wamid ever collided.
    const attempt = await prisma.notificationAttempt.findFirst({
      where: { providerMessageId: event.providerMessageId },
      select: { id: true, organizationId: true },
    });
    if (!attempt) {
      result.unmatched += 1;
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.notificationDeliveryEvent.create({
          data: {
            organizationId: attempt.organizationId,
            attemptId: attempt.id,
            status: event.status,
            occurredAt: event.occurredAt,
            providerErrorCode: event.providerErrorCode,
          },
        });
        // Atomic "advance only": the WHERE clause enumerates every
        // state strictly below the new one, so a concurrent or delayed
        // higher-status callback can never be overwritten.
        await tx.notificationAttempt.updateMany({
          where: {
            id: attempt.id,
            OR: [
              { deliveryStatus: null },
              { deliveryStatus: { in: LOWER_THAN[event.status] } },
            ],
          },
          data: { deliveryStatus: event.status },
        });
      });
      result.recorded += 1;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        // Exact replay — the unique constraint caught it.
        result.deduplicated += 1;
      } else {
        throw error;
      }
    }
  }
  return result;
}
