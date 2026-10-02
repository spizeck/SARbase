import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";
import type { Notification } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  log,
  logExpected,
  logOperational,
  summarizeError,
} from "@/lib/logging";
import {
  CALLOUT_INVITATION_TEMPLATE,
  CALLOUT_RESPONSE_URL_PLACEHOLDER,
  invitationResponseUrl,
} from "@/lib/domain/calloutTokens";
import type {
  NotificationChannelName,
  NotificationProvider,
} from "@/lib/notifications/provider";
import { resolveNotificationProvider } from "@/lib/notifications/resolve";

/**
 * Notification request and delivery records (issue #13).
 *
 * PRODUCT BOUNDARY: this module is communication infrastructure. It
 * records that an application intent existed, whether policy allowed
 * dispatch, and what the provider reported — nothing more. It never
 * decides who should respond, whether a crew is sufficient, or whether
 * a notification's delivery means a response capability exists.
 *
 * Model — request vs attempt:
 * - `Notification` is the durable request: channel, destination
 *   SNAPSHOT, template, content, idempotency key, intent hash, actor.
 *   `status` is a factual projection of the latest known state.
 * - `NotificationAttempt` is one append-only provider invocation. The
 *   row is written DISPATCHING before the provider call and resolved
 *   afterwards — a stuck DISPATCHING row is the honest record of "we
 *   invoked the provider and never learned the outcome".
 *
 * Idempotency — application-level, not provider-dependent:
 * `(organizationId, idempotencyKey)` is a DB unique constraint. A
 * replay with an identical `intentHash` returns the existing request
 * (no second send); a replay with a DIFFERENT intent hash is a loud
 * `NotificationIdempotencyConflictError`, never a silent reuse.
 *
 * Member preference enforcement: when a request targets a Member, the
 * member's MemberNotificationPreference must allow the channel —
 * otherwise the request is recorded SUPPRESSED with a factual
 * statusReason and the provider is never invoked. A request without a
 * member (direct administrative destination) has no member preference
 * to check.
 *
 * Retry: no automatic retry machinery exists — a failed request exposes
 * retry ELIGIBILITY as a fact, and `retryNotification` performs one
 * explicit dispatch as a new attempt row. Attempts are capped at
 * MAX_ATTEMPTS; a non-retryable provider rejection is never retried.
 */

export const MAX_NOTIFICATION_ATTEMPTS = 5;

/**
 * A DISPATCHING attempt younger than this is treated as in-flight —
 * its provider call may still be running, so retry is refused. Older
 * than this, it is presumed orphaned by a crashed invocation and the
 * request becomes retry-eligible again.
 */
export const DISPATCHING_STALE_MS = 10 * 60 * 1000;

/** A key was replayed with materially different intent — fail loudly. */
export class NotificationIdempotencyConflictError extends Error {
  constructor() {
    super("That idempotency key was already used for a different request.");
    this.name = "NotificationIdempotencyConflictError";
  }
}

/** Two dispatches raced — the unique attempt index already fired. */
export class NotificationConcurrentDispatchError extends Error {
  constructor() {
    super("A send attempt for this notification is already in progress.");
    this.name = "NotificationConcurrentDispatchError";
  }
}

/** The request is not eligible for retry (terminal state or cap). */
export class NotificationRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationRetryError";
  }
}

/** The target member does not exist in the request's organization. */
export class NotificationRecipientError extends Error {
  constructor() {
    super("The recipient member does not exist in this organization.");
    this.name = "NotificationRecipientError";
  }
}

/** Factual reasons a request was never dispatched (statusReason). */
export const SUPPRESSION_REASONS = {
  PREFERENCE_DISABLED: "preference_disabled",
  DESTINATION_MISSING: "destination_missing",
} as const;
export type SuppressionReason =
  (typeof SUPPRESSION_REASONS)[keyof typeof SUPPRESSION_REASONS];

export const NOTIFICATION_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  SUPPRESSED: "Not sent (suppressed)",
  ACCEPTED: "Accepted by provider",
  FAILED: "Failed",
};

export const NOTIFICATION_ATTEMPT_STATUS_LABELS: Record<string, string> = {
  DISPATCHING: "Sending",
  ACCEPTED: "Accepted",
  FAILED: "Failed",
};

export const SUPPRESSION_REASON_LABELS: Record<string, string> = {
  preference_disabled: "Member preference does not allow this channel",
  destination_missing: "No destination on the member record",
};

export interface NotificationRequestInput {
  organizationId: string;
  channel: NotificationChannelName;
  /** Member target — preference-checked. Omit for a direct send. */
  memberId?: string;
  /** Destination when no member is targeted (e.g. an admin test send). */
  destination?: string;
  /** Machine template identifier, e.g. "admin_test". */
  template: string;
  subject?: string;
  bodyText?: string;
  /** Small structured non-sensitive context — ids and codes only. */
  metadata?: Record<string, string>;
  idempotencyKey: string;
}

export interface NotificationRequestResult {
  notification: Notification;
  /** True when the idempotency key replayed an existing request. */
  deduplicated: boolean;
}

export interface NotificationDispatchDeps {
  /** Provider override — tests inject FakeNotificationProvider. */
  provider?: NotificationProvider;
}

/**
 * Canonical intent fingerprint for idempotency-conflict detection.
 * Two requests with the same key are "the same request" iff every field
 * that changes the delivered message agrees — destination snapshots
 * included, so a replay after the member changed email is a conflict,
 * not a silent reuse.
 */
export function computeIntentHash(input: {
  channel: string;
  memberId: string | null;
  destination: string | null;
  template: string;
  subject: string | null;
  bodyText: string | null;
  metadata: Record<string, string> | null;
}): string {
  const entries = input.metadata ? Object.entries(input.metadata) : null;
  const metadata = entries
    ? entries.sort(([a], [b]) => a.localeCompare(b))
    : null;
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.channel,
        input.memberId,
        input.destination,
        input.template,
        input.subject,
        input.bodyText,
        metadata,
      ]),
    )
    .digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

interface ResolvedRecipient {
  memberId: string | null;
  destination: string | null;
  suppression: SuppressionReason | null;
}

/**
 * Resolve the destination snapshot and member-preference outcome. Pure
 * DB reads — no provider contact. A member-targeted request is
 * suppressed when the channel preference is off or absent, or when the
 * member record lacks the channel's destination.
 */
async function resolveRecipient(
  input: NotificationRequestInput,
): Promise<ResolvedRecipient> {
  if (!input.memberId) {
    return {
      memberId: null,
      destination: input.destination ?? null,
      suppression: input.destination
        ? null
        : SUPPRESSION_REASONS.DESTINATION_MISSING,
    };
  }

  const member = await prisma.member.findFirst({
    where: { id: input.memberId, organizationId: input.organizationId },
    select: {
      id: true,
      email: true,
      notificationPreference: { select: { notifyEmail: true } },
    },
  });
  if (!member) {
    throw new NotificationRecipientError();
  }

  if (input.channel === "EMAIL") {
    if (member.notificationPreference?.notifyEmail !== true) {
      return {
        memberId: member.id,
        destination: member.email,
        suppression: SUPPRESSION_REASONS.PREFERENCE_DISABLED,
      };
    }
    if (!member.email) {
      return {
        memberId: member.id,
        destination: null,
        suppression: SUPPRESSION_REASONS.DESTINATION_MISSING,
      };
    }
    return {
      memberId: member.id,
      destination: member.email,
      suppression: null,
    };
  }

  // Unreachable while EMAIL is the only channel — future channels add
  // their preference/destination check here.
  throw new Error(`Unsupported notification channel: ${input.channel}`);
}

type NotificationWithAttempts = Notification & {
  attempts: { status: string; retryable: boolean; attemptedAt: Date }[];
};

function dispatchEligibilityError(
  notification: NotificationWithAttempts,
): Error | null {
  if (notification.attempts.length >= MAX_NOTIFICATION_ATTEMPTS) {
    return new NotificationRetryError(
      "This notification has reached the maximum number of send attempts.",
    );
  }
  const latest = notification.attempts.at(-1);
  if (notification.status === "FAILED") {
    return latest?.status === "FAILED" && latest.retryable
      ? null
      : new NotificationRetryError(
          "The last failure is not retryable; create a new request instead.",
        );
  }
  if (notification.status === "PENDING") {
    if (latest?.status === "DISPATCHING") {
      return Date.now() - latest.attemptedAt.getTime() > DISPATCHING_STALE_MS
        ? null
        : new NotificationRetryError(
            "A send attempt is already in progress for this notification.",
          );
    }
    // No attempts yet — eligible only for the initial dispatch.
    return latest
      ? new NotificationRetryError(
          "This notification is not eligible for retry.",
        )
      : null;
  }
  return new NotificationRetryError(
    notification.status === "ACCEPTED"
      ? "This notification was already accepted by the provider."
      : "This notification was not sent; create a new request instead.",
  );
}

/**
 * The exact text this attempt sends to the provider.
 *
 * `bodyText` is the durable send-record — what was requested, verbatim —
 * and it must never persist a live credential. A callout invitation's
 * body therefore carries `{callout-response-url}` where the member's
 * link belongs; the link is a deterministic HMAC derivation
 * (calloutTokens.ts) recomputed identically on every send, so honest
 * retries deliver the same working URL without the raw token ever
 * reaching the database. Substitution needs only fields already on the
 * row: `metadata.calloutId` plus the `memberId` column.
 *
 * A body whose placeholder cannot be resolved (wrong template, missing
 * callout/member context) is a programming or data bug — throwing here
 * records no attempt and emails nobody a dead link.
 */
async function resolveDispatchBodyText(
  notification: Notification,
): Promise<string | null> {
  const text = notification.bodyText;
  if (text == null || !text.includes(CALLOUT_RESPONSE_URL_PLACEHOLDER)) {
    return text;
  }
  const metadata = (notification.metadata ?? null) as {
    calloutId?: string;
  } | null;
  if (
    notification.template === CALLOUT_INVITATION_TEMPLATE &&
    metadata?.calloutId &&
    notification.memberId
  ) {
    return text.replaceAll(
      CALLOUT_RESPONSE_URL_PLACEHOLDER,
      invitationResponseUrl(metadata.calloutId, notification.memberId),
    );
  }
  throw new Error(
    `Notification ${notification.id} carries an unresolvable response-link placeholder.`,
  );
}

/**
 * Record one provider invocation attempt for an existing notification.
 *
 * Serialization: the notification row is locked FOR UPDATE inside the
 * creation transaction and eligibility is re-checked under the lock, so
 * two concurrent dispatches can never both proceed — a winner commits
 * its attempt row, a loser sees the new latest attempt and is refused.
 * `@@unique([notificationId, attemptNumber])` remains as
 * defense-in-depth (a loser racing the check maps P2002 →
 * NotificationConcurrentDispatchError).
 *
 * The provider call happens AFTER the transaction commits so no
 * database lock is held across a network call; a crash between the two
 * leaves a permanently DISPATCHING attempt — the honest record — which
 * becomes retryable once DISPATCHING_STALE_MS has elapsed.
 */
async function dispatchAttempt(
  notification: Notification,
  provider: NotificationProvider,
  mode: "initial" | "retry",
): Promise<Notification> {
  // Resolve the text this attempt sends BEFORE any attempt row exists:
  // the stored body is the durable request record and must never hold a
  // live credential, so a callout invitation's response link is carried
  // as a placeholder and recomputed here for each send — initial and
  // retry alike. A placeholder that cannot be resolved fails loudly
  // rather than emailing a member a dead link.
  const dispatchText = await resolveDispatchBodyText(notification);

  let attempt;
  try {
    attempt = await prisma.$transaction(async (tx) => {
      // Lock the request row: serializes concurrent dispatches against
      // each other for the whole eligibility-check-and-create window.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Notification" WHERE id = ${notification.id} FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new NotificationRetryError("This notification does not exist.");
      }
      const fresh = await tx.notification.findUniqueOrThrow({
        where: { id: notification.id },
        include: { attempts: { orderBy: { attemptNumber: "asc" } } },
      });
      const eligibilityError =
        mode === "initial"
          ? fresh.status === "PENDING" && fresh.attempts.length === 0
            ? null
            : new NotificationConcurrentDispatchError()
          : dispatchEligibilityError(fresh);
      if (eligibilityError) throw eligibilityError;
      const attemptNumber = fresh.attempts.length + 1;
      return tx.notificationAttempt.create({
        data: {
          organizationId: notification.organizationId,
          notificationId: notification.id,
          attemptNumber,
          provider: provider.providerName,
          status: "DISPATCHING",
        },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new NotificationConcurrentDispatchError();
    }
    throw error;
  }

  log({
    event: "notification.dispatch",
    subsystem: "notifications",
    entityType: "Notification",
    entityId: notification.id,
    organizationId: notification.organizationId,
    channel: notification.channel,
    provider: provider.providerName,
    attemptNumber: attempt.attemptNumber,
  });

  let outcome;
  try {
    outcome = await provider.send({
      channel: notification.channel as NotificationChannelName,
      to: notification.destination ?? "",
      subject: notification.subject,
      text: dispatchText,
      // Provider-level idempotency (Resend Idempotency-Key header): a
      // re-invoked SAME attempt dedupes at the provider; a deliberate
      // retry is a new attempt number and a new provider operation.
      idempotencyKey: `${notification.id}/attempt-${attempt.attemptNumber}`,
    });
  } catch (error) {
    // A provider that throws instead of returning a failure outcome is
    // normalized the same way — never propagate the raw exception.
    logOperational({
      event: "notification.provider_threw",
      subsystem: "notifications",
      entityType: "Notification",
      entityId: notification.id,
      organizationId: notification.organizationId,
      provider: provider.providerName,
      attemptNumber: attempt.attemptNumber,
      ...summarizeError(error),
    });
    outcome = {
      status: "failed" as const,
      errorCode: "provider_unavailable" as const,
      errorSummary: "The provider could not be reached. Retrying may succeed.",
      retryable: true,
    };
  }

  const resolvedAt = new Date();
  const finalStatus = outcome.status === "accepted" ? "ACCEPTED" : "FAILED";

  const updated = await prisma.$transaction(async (tx) => {
    await tx.notificationAttempt.update({
      where: { id: attempt.id },
      data:
        outcome.status === "accepted"
          ? {
              status: "ACCEPTED",
              providerMessageId: outcome.providerMessageId,
              resolvedAt,
            }
          : {
              status: "FAILED",
              errorCode: outcome.errorCode,
              errorSummary: outcome.errorSummary,
              retryable: outcome.retryable,
              resolvedAt,
            },
    });
    return tx.notification.update({
      where: { id: notification.id },
      data: { status: finalStatus },
    });
  });

  log({
    event:
      outcome.status === "accepted"
        ? "notification.accepted"
        : "notification.failed",
    level: outcome.status === "accepted" ? "info" : "warn",
    outcome: outcome.status === "accepted" ? "success" : "expected_failure",
    subsystem: "notifications",
    entityType: "Notification",
    entityId: notification.id,
    organizationId: notification.organizationId,
    channel: notification.channel,
    provider: provider.providerName,
    attemptNumber: attempt.attemptNumber,
    notificationStatus: finalStatus,
    providerMessageId:
      outcome.status === "accepted" ? outcome.providerMessageId : undefined,
    errorCode: outcome.status === "failed" ? outcome.errorCode : undefined,
    retryable: outcome.status === "failed" ? outcome.retryable : undefined,
  });

  return updated;
}

/**
 * Settle an already-recorded request for a replayed idempotency key:
 * identical intent returns the existing row; conflicting intent fails
 * loudly. Pure lookup semantics — no provider contact, so a replay is
 * answered from the durable record even when provider configuration
 * has since become invalid.
 */
function replayResult(
  existing: Notification,
  intentHash: string,
  input: NotificationRequestInput,
): NotificationRequestResult {
  if (existing.intentHash !== intentHash) {
    logExpected({
      event: "notification.idempotency_conflict",
      subsystem: "notifications",
      entityType: "Notification",
      entityId: existing.id,
      organizationId: input.organizationId,
      channel: input.channel,
    });
    throw new NotificationIdempotencyConflictError();
  }
  log({
    event: "notification.replayed",
    subsystem: "notifications",
    entityType: "Notification",
    entityId: existing.id,
    organizationId: input.organizationId,
    channel: input.channel,
  });
  return { notification: existing, deduplicated: true };
}

/**
 * Create and dispatch a notification request — the application-facing
 * entry point. Idempotent on (organizationId, idempotencyKey): a replay
 * with identical intent returns the existing row (deduplicated: true);
 * a replay with conflicting intent throws
 * NotificationIdempotencyConflictError.
 *
 * Ordering is deliberate: the idempotency-key lookup runs BEFORE any
 * provider resolution. A replay of a completed request must be answered
 * from the durable record alone — re-checking provider configuration on
 * replay could fail a request that already succeeded. Provider
 * resolution happens only for a genuinely new, non-suppressed request,
 * still BEFORE the row is created so a configuration error leaves no
 * orphaned PENDING record. The unique constraint remains underneath as
 * the concurrent-create race protection.
 *
 * Authorization is the CALLER's job — this function trusts that the
 * caller already established ADMIN access to `organizationId`. The
 * composite member FK still guarantees a member from another
 * organization can never be attached even if a caller gets it wrong.
 */
export async function requestNotification(
  input: NotificationRequestInput,
  requestedByAuthIdentityId: string | null,
  deps: NotificationDispatchDeps = {},
): Promise<NotificationRequestResult> {
  const recipient = await resolveRecipient(input);
  const intentHash = computeIntentHash({
    channel: input.channel,
    memberId: recipient.memberId,
    destination: recipient.destination,
    template: input.template,
    subject: input.subject ?? null,
    bodyText: input.bodyText ?? null,
    metadata: input.metadata ?? null,
  });

  // Replay check first: an identical-keyed request that was already
  // recorded is returned as-is — the provider is never resolved for it.
  const existing = await prisma.notification.findUnique({
    where: {
      organizationId_idempotencyKey: {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (existing) {
    return replayResult(existing, intentHash, input);
  }

  // Resolve the provider BEFORE writing the row: a configuration error
  // must leave no orphaned PENDING request (and no row that a later
  // identical-key replay could silently "succeed" against). Suppressed
  // requests never reach a provider, so none is resolved for them.
  const provider = recipient.suppression
    ? null
    : (deps.provider ?? resolveNotificationProvider(input.channel));

  const createData = {
    organizationId: input.organizationId,
    memberId: recipient.memberId,
    channel: input.channel,
    template: input.template,
    subject: input.subject ?? null,
    bodyText: input.bodyText ?? null,
    destination: recipient.destination,
    metadata: input.metadata ?? Prisma.DbNull,
    idempotencyKey: input.idempotencyKey,
    intentHash,
    status: recipient.suppression
      ? ("SUPPRESSED" as const)
      : ("PENDING" as const),
    statusReason: recipient.suppression ?? null,
    requestedByAuthIdentityId,
  };

  let notification: Notification;
  try {
    notification = await prisma.notification.create({ data: createData });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    // A concurrent request won the create race — settle it with the same
    // replay/conflict semantics as the early lookup above.
    const raced = await prisma.notification.findUniqueOrThrow({
      where: {
        organizationId_idempotencyKey: {
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    return replayResult(raced, intentHash, input);
  }

  if (notification.status === "SUPPRESSED") {
    log({
      event: "notification.suppressed",
      subsystem: "notifications",
      entityType: "Notification",
      entityId: notification.id,
      organizationId: notification.organizationId,
      channel: notification.channel,
      memberId: notification.memberId,
      statusReason: notification.statusReason,
    });
    return { notification, deduplicated: false };
  }

  const dispatched = await dispatchAttempt(notification, provider!, "initial");
  return { notification: dispatched, deduplicated: false };
}

/**
 * Whether this notification may be retried right now — a factual state,
 * not a scheduler. Eligible: a FAILED request whose latest attempt was
 * classified retryable, a request whose latest DISPATCHING attempt is
 * older than DISPATCHING_STALE_MS (presumed orphaned by a crash), or a
 * PENDING request that never got an attempt (creation crashed before
 * dispatch). SUPPRESSED and ACCEPTED are terminal; the attempt cap
 * applies regardless. The authoritative check is re-run under the row
 * lock inside dispatchAttempt — this is a display hint.
 */
export function isRetryableNotification(
  notification: Notification & {
    attempts: { status: string; retryable: boolean; attemptedAt: Date }[];
  },
): boolean {
  return dispatchEligibilityError(notification) === null;
}

/**
 * One explicit retry dispatch — appends a NEW attempt row; prior
 * attempts are never overwritten. Refuses ineligible states rather than
 * dispatching anyway (an ACCEPTED or SUPPRESSED request is terminal,
 * and a non-retryable rejection is never retried). The eligibility
 * check is performed twice: here for a fast safe error, and again under
 * the row lock in dispatchAttempt where it is authoritative.
 */
export async function retryNotification(
  notificationId: string,
  deps: NotificationDispatchDeps = {},
): Promise<Notification> {
  const notification = await prisma.notification.findUniqueOrThrow({
    where: { id: notificationId },
    include: { attempts: { orderBy: { attemptNumber: "asc" } } },
  });
  const eligibilityError = dispatchEligibilityError(notification);
  if (eligibilityError) {
    throw eligibilityError;
  }
  const provider =
    deps.provider ?? resolveNotificationProvider(notification.channel);
  return dispatchAttempt(notification, provider, "retry");
}

/**
 * Organization notification history for the admin surface — requests
 * newest first, each with its ordered attempts and member display name.
 * The destination snapshot is shown as stored (admins already see
 * member contact details); it is history, never an auth input.
 */
export function listOrganizationNotifications(
  organizationId: string,
  options: { limit?: number } = {},
) {
  return prisma.notification.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.limit ?? 50,
    include: {
      member: { select: { id: true, displayName: true } },
      attempts: { orderBy: { attemptNumber: "asc" } },
    },
  });
}

/**
 * A single notification with attempts for admin inspection. Org scoping
 * is the caller's job (requireOrgAdminForNotification resolves the
 * record's real organization before granting).
 */
export function getNotificationForAdmin(notificationId: string) {
  return prisma.notification.findUnique({
    where: { id: notificationId },
    include: {
      member: { select: { id: true, displayName: true } },
      attempts: { orderBy: { attemptNumber: "asc" } },
    },
  });
}
