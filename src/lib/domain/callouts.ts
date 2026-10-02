import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";
import type {
  Callout,
  CalloutInvitation,
  CalloutResponse,
  CalloutResponseSource,
  Notification,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { log, logExpected, summarizeError } from "@/lib/logging";
import {
  assertCalloutResponseTokenConfigured,
  CALLOUT_INVITATION_TEMPLATE,
  CALLOUT_RESPONSE_URL_PLACEHOLDER,
  deriveInvitationResponseToken,
  verifyInvitationResponseToken,
} from "@/lib/domain/calloutTokens";

import {
  requestNotification,
  retryNotification,
  type NotificationDispatchDeps,
} from "./notifications";
import type { CalloutActivationInput } from "./schemas";

/**
 * Callouts and volunteer response tracking (issue #14).
 *
 * PRODUCT BOUNDARY: a callout records that an organization invited a
 * materialized set of members, and records each member's factual
 * response (COMING / UNAVAILABLE / none). SARbase never concludes that
 * a crew is sufficient, qualified, ready, or dispatchable — there is
 * no minimum-crew logic, no qualification inference, no readiness
 * state anywhere in this module. Counts shown to coordinators are
 * descriptive facts, not verdicts.
 *
 * Audience materialization: the invited set is resolved once at
 * activation (org members, unit members, or explicit member ids) and
 * written as CalloutInvitation rows. Later roster/unit changes never
 * rewrite history. Availability/qualifications are NEVER consulted for
 * audience selection — a member may only be skipped by the factual
 * rule that INACTIVE member records are not invited.
 *
 * Idempotency: `(organizationId, activationKey)` is unique and carries
 * an `intentHash` — same contract as Notification. A replayed key with
 * identical intent returns the existing callout (and resumes any
 * invitation whose notification was never recorded); conflicting reuse
 * throws CalloutIdempotencyConflictError.
 *
 * Notification dispatch happens AFTER the callout+invitations
 * transaction commits — no DB lock is held across a provider call, and
 * a partially-dispatched callout stays visible and resumable. Each
 * invitation's notification uses a deterministic idempotency key
 * (`callout:{id}:invitation:{id}:email`) so a retry/replay never
 * double-sends.
 *
 * Response tokens: the emailed link carries a bearer token DERIVED
 * per invitation — HMAC-SHA256 of `callout-response:<calloutId>:
 * <memberId>` under a server-held secret (calloutTokens.ts). It is
 * recomputed identically at every send and NEVER persisted anywhere:
 * the invitation stores only its SHA-256 hash for lookup, and the
 * Notification row's stored body carries a `{callout-response-url}`
 * placeholder that dispatch substitutes at provider-send time —
 * covering retries too. No database row, log, or telemetry payload
 * holds the raw token; closing the callout revokes every link it
 * appears in.
 */

/** A selector named a record outside this callout's organization. */
export class CrossOrganizationCalloutError extends Error {
  constructor() {
    super("A selected record belongs to another organization.");
    this.name = "CrossOrganizationCalloutError";
  }
}

/** Audience input that is validly shaped but invites nobody / an inactive record. */
export class CalloutAudienceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalloutAudienceError";
  }
}

/** Same activation key, materially different intent — fail loudly. */
export class CalloutIdempotencyConflictError extends Error {
  constructor() {
    super("That activation key was already used for a different callout.");
    this.name = "CalloutIdempotencyConflictError";
  }
}

/** A response was attempted against a callout that is closed. */
export class CalloutClosedError extends Error {
  constructor() {
    super("This callout is closed and no longer accepts responses.");
    this.name = "CalloutClosedError";
  }
}

/** The response token did not resolve to an invitation. Opaque. */
export class CalloutTokenInvalidError extends Error {
  constructor() {
    super("This response link is not valid.");
    this.name = "CalloutTokenInvalidError";
  }
}

export const CALLOUT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Active",
  CLOSED: "Closed",
};

export const CALLOUT_RESPONSE_LABELS: Record<CalloutResponse, string> = {
  COMING: "Coming",
  UNAVAILABLE: "Unavailable",
};

export const CALLOUT_RESPONSE_SOURCE_LABELS: Record<
  CalloutResponseSource,
  string
> = {
  TOKEN_LINK: "Response link",
  ACCOUNT: "Member account",
  ADMIN: "Recorded by an administrator",
};

/* ------------------------------------------------------------------ */
/* Response tokens                                                     */
/* ------------------------------------------------------------------ */

/**
 * SHA-256 of the raw bearer token — the only token material ever
 * persisted. The token itself is derived, not stored; see
 * calloutTokens.ts.
 */
export function hashResponseToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Activation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Fingerprint of the activation's material intent — everything that
 * changes what gets recorded or sent. The materialized member set is
 * part of the intent so reusing a key with a different audience is a
 * conflict, not a silent replay.
 */
function computeCalloutIntentHash(
  input: CalloutActivationInput,
  memberIds: string[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.title,
        input.message ?? null,
        input.audience,
        input.audience === "UNIT" ? (input.unitId ?? null) : null,
        [...memberIds].sort(),
      ]),
    )
    .digest("hex");
}

/**
 * Resolve the audience selector to a concrete, deduplicated list of
 * ACTIVE members of this organization. Every selector id is validated
 * against the record's own organizationId — a foreign id fails
 * opaquely (CrossOrganizationCalloutError), never a leak of which ids
 * exist elsewhere.
 */
async function resolveAudienceMembers(
  organizationId: string,
  input: CalloutActivationInput,
): Promise<{ id: string }[]> {
  if (input.audience === "ORGANIZATION") {
    const members = await prisma.member.findMany({
      where: { organizationId, status: "ACTIVE" },
      select: { id: true },
      orderBy: { displayName: "asc" },
    });
    if (members.length === 0) {
      throw new CalloutAudienceError(
        "This organization has no active members to invite.",
      );
    }
    return members;
  }

  if (input.audience === "UNIT") {
    const unit = await prisma.unit.findFirst({
      where: { id: input.unitId ?? "", organizationId },
      select: { id: true },
    });
    if (!unit) {
      throw new CrossOrganizationCalloutError();
    }
    const members = await prisma.member.findMany({
      where: {
        organizationId,
        status: "ACTIVE",
        memberUnits: { some: { unitId: unit.id } },
      },
      select: { id: true },
      orderBy: { displayName: "asc" },
    });
    if (members.length === 0) {
      throw new CalloutAudienceError(
        "That unit has no active members to invite.",
      );
    }
    return members;
  }

  // MEMBERS — explicit selection.
  const wanted = [...new Set(input.memberIds)];
  const members = await prisma.member.findMany({
    where: { id: { in: wanted }, organizationId },
    select: { id: true, status: true },
  });
  if (members.length !== wanted.length) {
    // Some supplied ids do not resolve inside this organization.
    throw new CrossOrganizationCalloutError();
  }
  if (members.some((m) => m.status !== "ACTIVE")) {
    throw new CalloutAudienceError(
      "Inactive member records cannot be invited to a callout.",
    );
  }
  return members.map(({ id }) => ({ id }));
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

export interface CalloutActivationResult {
  callout: Callout;
  /** True when the activation key replayed an existing callout. */
  deduplicated: boolean;
}

function calloutNotificationKey(calloutId: string, invitationId: string) {
  return `callout:${calloutId}:invitation:${invitationId}:email`;
}

/**
 * The stored email body. The response link is written as
 * `{callout-response-url}` — a placeholder, never the credential —
 * and substituted with the recomputed derived link at provider-send
 * time (see resolveDispatchBodyText in notifications.ts). The durable
 * record therefore holds no usable token while every send — initial
 * or retry — delivers the same working link.
 */
function buildCalloutEmail(input: {
  organizationName: string;
  title: string;
  message: string | null;
}): { subject: string; bodyText: string } {
  return {
    subject: `${input.organizationName} — Callout: ${input.title}`,
    bodyText: [
      `${input.organizationName} has sent a callout.`,
      "",
      `Callout: ${input.title}`,
      ...(input.message ? ["", input.message] : []),
      "",
      "Please respond using this link:",
      CALLOUT_RESPONSE_URL_PLACEHOLDER,
      "",
      'You can answer "I\'m coming" or "Unavailable" — and you can change your response while the callout is active.',
      "",
      "This link is personal to your invitation. Do not share it.",
    ].join("\n"),
  };
}

/**
 * Link an invitation to the Notification row recorded under its
 * deterministic key, and refresh `responseTokenHash` to the hash of
 * the token a send would carry today. The token is a pure derivation
 * (calloutTokens.ts), so the stored hash always equals the emailed
 * credential by construction — under every interleaving, and even
 * after a token-secret rotation (the new link becomes authoritative;
 * old links stop resolving, which is what rotation means).
 */
async function linkNotification(
  invitation: CalloutInvitation,
  notificationId: string,
): Promise<void> {
  await prisma.calloutInvitation.updateMany({
    where: {
      id: invitation.id,
      OR: [{ notificationId: null }, { notificationId }],
    },
    data: {
      notificationId,
      responseTokenHash: hashResponseToken(
        deriveInvitationResponseToken(
          invitation.calloutId,
          invitation.memberId,
        ),
      ),
    },
  });
}

/**
 * Dispatch the notification for one invitation that has no recorded
 * notification yet. The invitation's token never changes — it is
 * derived — so concurrent dispatchers are convergent by construction:
 * every dispatcher requests an identical body under the same
 * idempotency key, the unique constraint picks one Notification row,
 * and whichever dispatcher reaches it first links it. There is no
 * rotation and nothing to claim.
 *
 * 1. If a Notification row already exists under this invitation's
 *    deterministic key, link it. A row still PENDING was created but
 *    never dispatched (a crash between create and send) — resume it
 *    through retryNotification so a replay genuinely completes the
 *    send rather than only repairing the link.
 * 2. Otherwise requestNotification creates + dispatches the row; its
 *    own replay semantics settle a create-race, so whichever row comes
 *    back is the one linked.
 * 3. requestNotification throwing means nothing was persisted — a row
 *    that appeared meanwhile is linked instead; otherwise the failure
 *    is logged and the invitation stays unlinked, visible on the
 *    admin surface, resumable by a replay.
 */
async function dispatchInvitation(
  invitation: CalloutInvitation,
  callout: Callout,
  organizationName: string,
  requestedByAuthIdentityId: string,
  deps: NotificationDispatchDeps,
): Promise<void> {
  const key = calloutNotificationKey(callout.id, invitation.id);
  const keyWhere = {
    organizationId_idempotencyKey: {
      organizationId: callout.organizationId,
      idempotencyKey: key,
    },
  };

  const existing = await prisma.notification.findUnique({
    where: keyWhere,
    select: { id: true, status: true },
  });
  if (existing) {
    await linkNotification(invitation, existing.id);
    if (existing.status === "PENDING") {
      // Created but never dispatched — a crashed send. retryNotification
      // re-checks eligibility authoritatively; a live in-flight attempt
      // makes it decline, which is fine — that send is proceeding.
      try {
        await retryNotification(existing.id, deps);
      } catch (error) {
        logExpected({
          event: "callout.invitation_resume_skipped",
          subsystem: "callouts",
          entityType: "Notification",
          entityId: existing.id,
          organizationId: callout.organizationId,
          ...summarizeError(error),
        });
      }
    }
    return;
  }

  const { subject, bodyText } = buildCalloutEmail({
    organizationName,
    title: callout.title,
    message: callout.message,
  });

  let notification: Notification;
  try {
    ({ notification } = await requestNotification(
      {
        organizationId: callout.organizationId,
        channel: "EMAIL",
        memberId: invitation.memberId,
        template: CALLOUT_INVITATION_TEMPLATE,
        subject,
        bodyText,
        metadata: { calloutId: callout.id, invitationId: invitation.id },
        idempotencyKey: key,
      },
      requestedByAuthIdentityId,
      deps,
    ));
  } catch (error) {
    // A notification row may have appeared under our key — link it.
    const created = await prisma.notification.findUnique({
      where: keyWhere,
      select: { id: true, status: true },
    });
    if (created) {
      await linkNotification(invitation, created.id);
      return;
    }
    // Genuine failure — nothing was persisted. The invitation stays
    // recorded without a linked notification, visible on the admin
    // surface; a replay (same activation key) resumes the gap.
    logExpected({
      event: "callout.invitation_dispatch_failed",
      subsystem: "callouts",
      entityType: "CalloutInvitation",
      entityId: invitation.id,
      organizationId: callout.organizationId,
      ...summarizeError(error),
    });
    return;
  }

  await linkNotification(invitation, notification.id);
}

/**
 * Ensure every invitation of `callout` has a notification recorded.
 * Idempotent — safe to call on replay and safe against partial prior
 * dispatch.
 */
async function dispatchPendingInvitations(
  callout: Callout,
  organizationName: string,
  requestedByAuthIdentityId: string,
  deps: NotificationDispatchDeps,
): Promise<void> {
  const pending = await prisma.calloutInvitation.findMany({
    where: { calloutId: callout.id, notificationId: null },
  });
  for (const invitation of pending) {
    await dispatchInvitation(
      invitation,
      callout,
      organizationName,
      requestedByAuthIdentityId,
      deps,
    );
  }
}

/**
 * Create and activate a callout: materialize the audience, mint
 * response tokens, then dispatch one notification per invitation
 * through the #13 notification foundation.
 *
 * Idempotent on (organizationId, activationKey): an identical replay
 * returns the existing callout and resumes any undispatched
 * invitations; a conflicting reuse throws
 * CalloutIdempotencyConflictError. Concurrent duplicate activations are
 * settled by the unique index — the loser re-reads and applies the same
 * replay/conflict semantics.
 *
 * Authorization is the CALLER's job — the caller must already hold
 * ADMIN on organizationId.
 */
export async function activateCallout(
  organizationId: string,
  input: CalloutActivationInput,
  createdByAuthIdentityId: string,
  deps: NotificationDispatchDeps = {},
): Promise<CalloutActivationResult> {
  // Fail fast if the deployment cannot mint response links — before
  // any row is written.
  assertCalloutResponseTokenConfigured();

  const members = await resolveAudienceMembers(organizationId, input);
  const intentHash = computeCalloutIntentHash(
    input,
    members.map((m) => m.id),
  );

  // Replay check first — identical intent returns the recorded callout
  // and resumes undispatched invitations; conflicting intent fails
  // loudly. Mirrors requestNotification's ordering contract.
  const existing = await prisma.callout.findUnique({
    where: {
      organizationId_activationKey: {
        organizationId,
        activationKey: input.activationKey,
      },
    },
  });
  if (existing) {
    return replayActivation(existing, intentHash, input, {
      organizationId,
      createdByAuthIdentityId,
      deps,
    });
  }

  let callout: Callout;
  try {
    callout = await prisma.$transaction(async (tx) => {
      const created = await tx.callout.create({
        data: {
          organizationId,
          createdByAuthIdentityId,
          audience: input.audience,
          unitId: input.audience === "UNIT" ? (input.unitId ?? null) : null,
          title: input.title,
          message: input.message ?? null,
          activationKey: input.activationKey,
          intentHash,
          status: "ACTIVE",
        },
      });
      // One INSERT, not a loop of round trips — a large org roster
      // must not blow the interactive transaction timeout. Each row's
      // responseTokenHash is the SHA-256 of the token derived for
      // (calloutId, memberId) — the raw token itself is never stored.
      await tx.calloutInvitation.createMany({
        data: members.map((member) => ({
          organizationId,
          calloutId: created.id,
          memberId: member.id,
          responseTokenHash: hashResponseToken(
            deriveInvitationResponseToken(created.id, member.id),
          ),
        })),
      });
      return created;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    // Lost the concurrent-create race — apply replay/conflict semantics.
    const raced = await prisma.callout.findUniqueOrThrow({
      where: {
        organizationId_activationKey: {
          organizationId,
          activationKey: input.activationKey,
        },
      },
    });
    return replayActivation(raced, intentHash, input, {
      organizationId,
      createdByAuthIdentityId,
      deps,
    });
  }

  log({
    event: "callout.activated",
    subsystem: "callouts",
    entityType: "Callout",
    entityId: callout.id,
    organizationId,
    actorId: createdByAuthIdentityId,
    audience: input.audience,
    invitationCount: members.length,
  });

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { name: true },
  });
  await dispatchPendingInvitations(
    callout,
    org.name,
    createdByAuthIdentityId,
    deps,
  );
  return { callout, deduplicated: false };
}

/** Shared replay handling for the early-lookup and lost-race paths. */
async function replayActivation(
  existing: Callout,
  intentHash: string,
  input: CalloutActivationInput,
  ctx: {
    organizationId: string;
    createdByAuthIdentityId: string;
    deps: NotificationDispatchDeps;
  },
): Promise<CalloutActivationResult> {
  if (existing.intentHash !== intentHash) {
    logExpected({
      event: "callout.activation_conflict",
      subsystem: "callouts",
      entityType: "Callout",
      entityId: existing.id,
      organizationId: ctx.organizationId,
    });
    throw new CalloutIdempotencyConflictError();
  }
  log({
    event: "callout.activation_replayed",
    subsystem: "callouts",
    entityType: "Callout",
    entityId: existing.id,
    organizationId: ctx.organizationId,
  });
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: ctx.organizationId },
    select: { name: true },
  });
  // A replay also RESUMES dispatch for invitations whose notification
  // was never recorded (activation crashed mid-send) — the
  // deterministic per-invitation keys make this safe.
  await dispatchPendingInvitations(
    existing,
    org.name,
    ctx.createdByAuthIdentityId,
    ctx.deps,
  );
  return { callout: existing, deduplicated: true };
}

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

export interface RecordedResponse {
  invitation: CalloutInvitation;
  /** False when the submitted response equaled the current one (idempotent). */
  changed: boolean;
}

/**
 * Record a response on an invitation — the single write path used by
 * token links, member accounts, and admin entry.
 *
 * Concurrency: the parent Callout row is locked FOR UPDATE inside the
 * transaction, serializing every response (and close) for that
 * callout. Under the lock: a closed callout refuses, an identical
 * response returns idempotently, and a changed response updates the
 * invitation's current state + appends a CalloutResponseChange in the
 * same transaction — so history and current state can never diverge.
 *
 * actorAuthIdentityId is null for TOKEN_LINK (the token itself
 * establishes who responded — no auth identity exists).
 */
export async function recordInvitationResponse(
  invitationId: string,
  response: CalloutResponse,
  source: CalloutResponseSource,
  actorAuthIdentityId: string | null,
  note: string | null = null,
): Promise<RecordedResponse> {
  const seed = await prisma.calloutInvitation.findUnique({
    where: { id: invitationId },
    select: { calloutId: true, organizationId: true },
  });
  if (!seed) {
    throw new CalloutTokenInvalidError();
  }

  return prisma.$transaction(async (tx) => {
    // Serialize on the callout row: responses for different invitations
    // of the same callout — and the close transition — all contend on
    // this one lock, so a close can never interleave with a response.
    await tx.$queryRaw`
      SELECT id FROM "Callout" WHERE id = ${seed.calloutId} FOR UPDATE
    `;
    const callout = await tx.callout.findUniqueOrThrow({
      where: { id: seed.calloutId },
      select: { status: true },
    });
    if (callout.status !== "ACTIVE") {
      throw new CalloutClosedError();
    }
    const invitation = await tx.calloutInvitation.findUniqueOrThrow({
      where: { id: invitationId },
    });
    if (invitation.response === response) {
      return { invitation, changed: false };
    }
    const updated = await tx.calloutInvitation.update({
      where: { id: invitationId },
      data: { response, respondedAt: new Date() },
    });
    await tx.calloutResponseChange.create({
      data: {
        organizationId: seed.organizationId,
        invitationId,
        previousResponse: invitation.response,
        response,
        source,
        actorAuthIdentityId,
        note,
      },
    });
    log({
      event: "callout.response_recorded",
      subsystem: "callouts",
      entityType: "CalloutInvitation",
      entityId: invitationId,
      organizationId: seed.organizationId,
      response,
      source,
      actorId: actorAuthIdentityId ?? undefined,
    });
    return { invitation: updated, changed: true };
  });
}

/**
 * Resolve a response token to its invitation for the public page.
 * The stored hash locates the row; the presented token must then equal
 * the CURRENT derivation (timing-safe) — so rotating the token secret
 * revokes outstanding links even while a stale stored hash still
 * matches the lookup.
 */
export async function getInvitationForToken(rawToken: string) {
  const hash = hashResponseToken(rawToken);
  const invitation = await prisma.calloutInvitation.findUnique({
    where: { responseTokenHash: hash },
    include: {
      member: { select: { displayName: true } },
      callout: {
        select: {
          id: true,
          title: true,
          message: true,
          status: true,
          activatedAt: true,
          closedAt: true,
          organization: { select: { name: true } },
        },
      },
    },
  });
  if (
    !invitation ||
    !verifyInvitationResponseToken(
      invitation.calloutId,
      invitation.memberId,
      rawToken,
    )
  ) {
    return null;
  }
  return invitation;
}

/** Token submission — resolves hash → invitation → shared write path. */
export async function respondToCalloutToken(
  rawToken: string,
  response: CalloutResponse,
): Promise<RecordedResponse> {
  const hash = hashResponseToken(rawToken);
  const invitation = await prisma.calloutInvitation.findUnique({
    where: { responseTokenHash: hash },
    select: { id: true, calloutId: true, memberId: true },
  });
  if (
    !invitation ||
    !verifyInvitationResponseToken(
      invitation.calloutId,
      invitation.memberId,
      rawToken,
    )
  ) {
    throw new CalloutTokenInvalidError();
  }
  return recordInvitationResponse(invitation.id, response, "TOKEN_LINK", null);
}

/* ------------------------------------------------------------------ */
/* Close                                                               */
/* ------------------------------------------------------------------ */

/**
 * Close a callout — a human administrative act only. The record is
 * preserved; response tokens stop accepting new responses. Idempotent:
 * closing an already-closed callout returns it unchanged so a
 * double-click is a no-op rather than an error.
 */
export async function closeCallout(
  calloutId: string,
  closedByAuthIdentityId: string,
): Promise<Callout> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id FROM "Callout" WHERE id = ${calloutId} FOR UPDATE
    `;
    const callout = await tx.callout.findUniqueOrThrow({
      where: { id: calloutId },
    });
    if (callout.status === "CLOSED") {
      return callout;
    }
    const closed = await tx.callout.update({
      where: { id: calloutId },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        closedByAuthIdentityId,
      },
    });
    log({
      event: "callout.closed",
      subsystem: "callouts",
      entityType: "Callout",
      entityId: calloutId,
      organizationId: callout.organizationId,
      actorId: closedByAuthIdentityId,
    });
    return closed;
  });
}

/* ------------------------------------------------------------------ */
/* Read models for the coordinator/admin surface                       */
/* ------------------------------------------------------------------ */

/**
 * Organization callout list — newest first with response tallies.
 * Counts are descriptive facts (coming/unavailable/no response), never
 * a sufficiency judgment.
 */
export async function listOrganizationCallouts(organizationId: string) {
  const callouts = await prisma.callout.findMany({
    where: { organizationId },
    orderBy: [{ activatedAt: "desc" }, { id: "desc" }],
    include: {
      unit: { select: { id: true, name: true } },
      invitations: { select: { response: true } },
    },
  });
  return callouts.map((callout) => {
    const coming = callout.invitations.filter(
      (i) => i.response === "COMING",
    ).length;
    const unavailable = callout.invitations.filter(
      (i) => i.response === "UNAVAILABLE",
    ).length;
    return {
      ...callout,
      invitations: undefined,
      counts: {
        total: callout.invitations.length,
        coming,
        unavailable,
        noResponse: callout.invitations.length - coming - unavailable,
      },
    };
  });
}

/**
 * One callout with its full factual detail for the admin surface:
 * materialized invitations (member, current response, linked
 * notification with attempts), and the append-only response history
 * per invitation.
 */
export async function getCalloutForAdmin(calloutId: string) {
  const callout = await prisma.callout.findUnique({
    where: { id: calloutId },
    include: {
      organization: { select: { id: true, name: true } },
      unit: { select: { id: true, name: true } },
      // Issue #15 — at most one incident may link to this callout; the
      // admin page offers "create incident record" only when absent.
      incident: {
        select: { id: true, reference: true, title: true, status: true },
      },
      invitations: {
        orderBy: { member: { displayName: "asc" } },
        include: {
          member: { select: { id: true, displayName: true } },
          notification: {
            select: {
              id: true,
              status: true,
              statusReason: true,
              channel: true,
              createdAt: true,
              attempts: {
                orderBy: { attemptNumber: "asc" },
                select: {
                  id: true,
                  status: true,
                  provider: true,
                  errorCode: true,
                  errorSummary: true,
                  retryable: true,
                  attemptedAt: true,
                  resolvedAt: true,
                },
              },
            },
          },
          changes: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] },
        },
      },
    },
  });
  if (!callout) {
    return null;
  }

  // Best-effort actor display for createdBy / closedBy / admin-recorded
  // changes: member name in this org, else identity email, else the raw
  // scalar id. The scalar ids always remain on the rows.
  const actorIds = [
    ...new Set(
      [
        callout.createdByAuthIdentityId,
        callout.closedByAuthIdentityId,
        ...callout.invitations.flatMap((i) =>
          i.changes.map((c) => c.actorAuthIdentityId),
        ),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  const [identities, actorMembers] = await Promise.all([
    prisma.authIdentity.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, email: true },
    }),
    prisma.member.findMany({
      where: {
        organizationId: callout.organizationId,
        authIdentityId: { in: actorIds },
      },
      select: { authIdentityId: true, displayName: true },
    }),
  ]);
  const memberNameByIdentity = new Map(
    actorMembers.map((m) => [m.authIdentityId, m.displayName]),
  );
  const emailByIdentity = new Map(identities.map((i) => [i.id, i.email]));
  const actorName = (id: string | null) =>
    id ? (memberNameByIdentity.get(id) ?? emailByIdentity.get(id) ?? id) : null;

  return {
    ...callout,
    createdByDisplay: actorName(callout.createdByAuthIdentityId),
    closedByDisplay: actorName(callout.closedByAuthIdentityId),
    invitations: callout.invitations.map((invitation) => ({
      ...invitation,
      changes: invitation.changes.map((change) => ({
        ...change,
        actorDisplay: actorName(change.actorAuthIdentityId),
      })),
    })),
  };
}

/**
 * Active callout invitations for a set of member ids — the member
 * account surface. The caller supplies only member ids it already
 * verified are linked AND access-scoped; this returns their invitations
 * on ACTIVE callouts, newest first.
 */
export function listMemberCalloutInvitations(memberIds: string[]) {
  if (memberIds.length === 0) {
    return Promise.resolve([]);
  }
  return prisma.calloutInvitation.findMany({
    where: {
      memberId: { in: memberIds },
      callout: { status: "ACTIVE" },
    },
    orderBy: [{ invitedAt: "desc" }, { id: "desc" }],
    include: {
      member: { select: { id: true, displayName: true } },
      callout: {
        select: {
          id: true,
          title: true,
          message: true,
          activatedAt: true,
          organization: { select: { name: true } },
        },
      },
    },
  });
}
