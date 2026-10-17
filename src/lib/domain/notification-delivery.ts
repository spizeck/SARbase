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
import { log } from "@/lib/logging";
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

/**
 * Audit-trail actor for webhook-driven consent changes — the plain
 * `actorAuthIdentityId` scalar convention lets a non-identity sentinel
 * attribute the write to the Meta callback itself (issue #111).
 */
const WHATSAPP_WEBHOOK_ACTOR = "whatsapp-webhook";

/**
 * Record a member-initiated WhatsApp opt-out signaled through the
 * inbound-message webhook (a bare STOP-style keyword). The configured
 * sender is deployment-wide, so the opt-out applies to EVERY member
 * whose stored E.164 phone matches the sender digits — across
 * organizations — exactly what the member means by "stop messaging
 * this number".
 *
 * Idempotent: an already-opted-out (or never-consented-with-row)
 * member is skipped silently; members with no preference row get one
 * carrying only the opt-out timestamp — the STOP still lands on the
 * MemberContactChange audit trail.
 */
export async function recordWhatsappOptOuts(
  senderDigits: string[],
): Promise<{ optedOut: number }> {
  if (senderDigits.length === 0) return { optedOut: 0 };

  // Member.phone is stored as canonical E.164 with the leading `+`;
  // Meta's wa_id drops it.
  const e164s = [...new Set(senderDigits)].map((digits) => `+${digits}`);
  const members = await prisma.member.findMany({
    where: { phone: { in: e164s } },
    select: {
      id: true,
      organizationId: true,
      notificationPreference: {
        select: {
          whatsappConsentAt: true,
          whatsappOptedOutAt: true,
        },
      },
    },
  });

  const now = new Date();
  let optedOut = 0;
  for (const member of members) {
    const changed = await prisma.$transaction(async (tx) => {
      // Conditional stamp — Meta can deliver the same STOP concurrently
      // and exactly one winner may write the audit row.
      const stamped = await tx.memberNotificationPreference.updateMany({
        where: {
          memberId: member.id,
          organizationId: member.organizationId,
          whatsappOptedOutAt: null,
        },
        data: { whatsappOptedOutAt: now },
      });
      if (stamped.count === 0) {
        // No preference row yet, or a concurrent/earlier delivery
        // already stamped it. A create races once — a unique violation
        // means someone else opted this member out.
        try {
          await tx.memberNotificationPreference.create({
            data: {
              organizationId: member.organizationId,
              memberId: member.id,
              whatsappOptedOutAt: now,
            },
          });
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          ) {
            return false;
          }
          throw error;
        }
      }
      await tx.memberContactChange.create({
        data: {
          organizationId: member.organizationId,
          memberId: member.id,
          field: "whatsappConsent",
          previousValue:
            member.notificationPreference?.whatsappConsentAt != null
              ? "granted"
              : null,
          newValue: "opted_out",
          selfReported: true,
          actorAuthIdentityId: WHATSAPP_WEBHOOK_ACTOR,
        },
      });
      return true;
    });
    if (!changed) continue;
    optedOut += 1;
    log({
      event: "contact_preference.whatsapp_opt_out_via_webhook",
      subsystem: "notifications",
      entityType: "Member",
      entityId: member.id,
      organizationId: member.organizationId,
    });
  }
  return { optedOut };
}
