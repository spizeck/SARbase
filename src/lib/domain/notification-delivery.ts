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

/** Internal sentinel: abort and retry the opt-out transaction. */
class OptOutRetrySignal extends Error {}

const OPT_OUT_TX_MAX_ATTEMPTS = 3;

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
    // Meta can deliver the same STOP concurrently. The transaction is
    // retried when a concurrent preference create claims the unique row
    // between the existence check and the create — the retry sees the
    // new row and stamps it rather than leaving the member un-opted-out.
    let changed = false;
    for (
      let attempt = 0;
      attempt < OPT_OUT_TX_MAX_ATTEMPTS && !changed;
      attempt++
    ) {
      try {
        changed = await prisma.$transaction(async (tx) => {
          const current = await tx.memberNotificationPreference.findUnique({
            where: {
              memberId_organizationId: {
                memberId: member.id,
                organizationId: member.organizationId,
              },
            },
            select: { whatsappConsentAt: true, whatsappOptedOutAt: true },
          });
          // Already opted out — idempotent no-op, whoever stamped it
          // wrote the audit row.
          if (current?.whatsappOptedOutAt != null) return false;
          if (current == null) {
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
                throw new OptOutRetrySignal();
              }
              throw error;
            }
          } else {
            // Conditional stamp — a concurrent delivery that already
            // wrote the opt-out wins; this becomes a clean no-op.
            const stamped = await tx.memberNotificationPreference.updateMany({
              where: {
                memberId: member.id,
                organizationId: member.organizationId,
                whatsappOptedOutAt: null,
              },
              data: { whatsappOptedOutAt: now },
            });
            if (stamped.count === 0) return false;
          }
          await tx.memberContactChange.create({
            data: {
              organizationId: member.organizationId,
              memberId: member.id,
              field: "whatsappConsent",
              previousValue:
                current?.whatsappConsentAt != null ? "granted" : null,
              newValue: "opted_out",
              selfReported: true,
              actorAuthIdentityId: WHATSAPP_WEBHOOK_ACTOR,
            },
          });
          return true;
        });
      } catch (error) {
        // A dead transaction can never be queried again, so the re-read
        // happens in a fresh one. Exhausting retries means the unique
        // row keeps being claimed by other writers — fail loudly so the
        // webhook 5xxs and Meta redelivers rather than losing a STOP.
        if (
          !(error instanceof OptOutRetrySignal) ||
          attempt === OPT_OUT_TX_MAX_ATTEMPTS - 1
        ) {
          throw error;
        }
      }
    }
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
