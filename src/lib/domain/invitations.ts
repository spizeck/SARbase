import { Prisma } from "@prisma/client";
import type { MemberInvitation } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { log, logExpected, summarizeError } from "@/lib/logging";
import { AUTH_PROVIDER } from "@/lib/auth/session";
import {
  requestNotification,
  type NotificationDispatchDeps,
} from "@/lib/domain/notifications";

import {
  MEMBER_INVITATION_TEMPLATE,
  MEMBER_INVITATION_TTL_MS,
  MEMBER_INVITATION_URL_PLACEHOLDER,
  assertMemberInvitationTokenConfigured,
  deriveMemberInvitationToken,
  hashMemberInvitationToken,
  verifyMemberInvitationToken,
} from "./invitationTokens";

/**
 * Member invitation lifecycle — the administrator-driven onboarding path
 * (replaces "have them sign in, then link by email" as the primary flow).
 *
 * SECURITY MODEL:
 * - The emailed link carries an HMAC-derived bearer token; only its
 *   SHA-256 hash is persisted (invitationTokens.ts). Resend bumps
 *   tokenVersion → the superseded link stops resolving.
 * - Acceptance requires an authenticated Firebase identity whose
 *   VERIFIED sign-in email equals the invitation's destination — a
 *   forwarded link alone grants nothing, and the member's contact email
 *   is never an authorization input.
 * - The granted OrganizationAccess role is exactly `invitation.role`,
 *   chosen by the inviting administrator — never inferred.
 * - Expiration and single-use are enforced under a row lock inside the
 *   acceptance transaction, so concurrent accepts cannot both succeed.
 *
 * Authorization is the CALLER's job for the admin-facing functions —
 * callers must already hold ADMIN on the target member's organization.
 * `acceptMemberInvitation` is unauthenticated-by-design (the token is the
 * invitation) but requires the verified identity proof above.
 */

/** The invitation email is not deliverable or was never dispatched. */
export class InvitationDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvitationDispatchError";
  }
}

/** The member already has a sign-in identity linked. */
export class InvitationMemberLinkedError extends Error {
  constructor() {
    super(
      "This member record is already linked to a sign-in account. Unlink it first if the account needs to change.",
    );
    this.name = "InvitationMemberLinkedError";
  }
}

/** Resend/revoke was requested against a state that cannot accept it. */
export class InvitationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvitationStateError";
  }
}

/**
 * Token-gated acceptance failures. `reason` is what the public page may
 * safely say — invalid/revoked/accepted all read the same to a probing
 * caller; "expired" is shown only when the token still resolves.
 */
export class InvitationAcceptanceError extends Error {
  constructor(
    public readonly reason:
      | "invalid"
      | "expired"
      | "revoked"
      | "accepted"
      | "email_mismatch"
      | "email_unverified"
      | "account_disabled"
      | "member_conflict",
    message: string,
  ) {
    super(message);
    this.name = "InvitationAcceptanceError";
  }
}

export interface MemberInvitationInput {
  /** Destination the invitation email is sent to (normalized). */
  email: string;
  /** The organization role granted at acceptance. */
  role: "MEMBER" | "ADMIN";
}

/** Display state for the admin surface — expiry is read-time derived. */
export type MemberInvitationDisplayState =
  "not_invited" | "pending" | "accepted" | "expired" | "revoked";

export const MEMBER_INVITATION_STATE_LABELS: Record<
  MemberInvitationDisplayState,
  string
> = {
  not_invited: "Not invited",
  pending: "Pending",
  accepted: "Accepted",
  expired: "Expired",
  revoked: "Revoked",
};

export const MEMBER_INVITATION_ACTION_LABELS: Record<string, string> = {
  CREATED: "Invitation sent",
  RESENT: "Invitation resent",
  REVOKED: "Invitation revoked",
  ACCEPTED: "Invitation accepted",
};

/**
 * Outstanding (still PENDING) invitations for an organization — the
 * access screen lists them so an invited role is never mistaken for a
 * granted one. Expiry stays read-time derived.
 */
export function listPendingMemberInvitations(organizationId: string) {
  return prisma.memberInvitation.findMany({
    where: { organizationId, status: "PENDING" },
    include: { member: { select: { id: true, displayName: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export function invitationDisplayState(
  invitation: Pick<MemberInvitation, "status" | "expiresAt"> | null,
  now: Date = new Date(),
): MemberInvitationDisplayState {
  if (!invitation) return "not_invited";
  if (invitation.status === "PENDING" && invitation.expiresAt <= now) {
    return "expired";
  }
  return invitation.status === "PENDING"
    ? "pending"
    : invitation.status === "ACCEPTED"
      ? "accepted"
      : "revoked";
}

/**
 * The invitation record for an admin's member view — current state plus
 * the full event history (sends, resends, revocation, acceptance).
 */
export function getMemberInvitation(memberId: string) {
  return prisma.memberInvitation.findUnique({
    where: { memberId },
    include: {
      notification: {
        select: {
          status: true,
          statusReason: true,
          createdAt: true,
          attempts: {
            select: {
              status: true,
              attemptedAt: true,
              errorSummary: true,
              providerMessageId: true,
            },
            orderBy: { attemptNumber: "asc" },
          },
        },
      },
      events: { orderBy: { createdAt: "desc" } },
    },
  });
}

/**
 * Public token lookup for the invite page. The token itself is the
 * credential; only its hash is queried. Returns the member-facing
 * context the page needs — org name, member name, invited email — or
 * null for an unknown token. State checks (expired/revoked/accepted)
 * happen in the caller, which renders the honest state to a holder of a
 * real (resolved) token.
 */
export async function getInvitationForToken(presentedToken: string) {
  const tokenHash = hashMemberInvitationToken(presentedToken);
  const invitation = await prisma.memberInvitation.findUnique({
    where: { tokenHash },
    include: {
      member: {
        select: {
          displayName: true,
          organizationId: true,
          authIdentityId: true,
        },
      },
      organization: { select: { name: true, timezone: true } },
    },
  });
  if (!invitation) return null;
  // The stored hash resolves the row; the timing-safe check against the
  // current version's derivation makes tokenVersion bumps and secret
  // rotation actually revoke — a stale-hash match still fails closed.
  if (
    !verifyMemberInvitationToken(
      invitation.id,
      invitation.tokenVersion,
      presentedToken,
    )
  ) {
    return null;
  }
  return invitation;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function buildInvitationEmail(input: {
  organizationName: string;
  memberDisplayName: string;
  role: "MEMBER" | "ADMIN";
}) {
  const roleLine =
    input.role === "ADMIN" ? "administrator access to" : "member access to";
  return {
    subject: `You're invited to join ${input.organizationName} on SARbase`,
    bodyText: [
      `Hello ${input.memberDisplayName},`,
      "",
      `${input.organizationName} has invited you to SARbase with ${roleLine} the organization.`,
      "",
      `Accept the invitation: ${MEMBER_INVITATION_URL_PLACEHOLDER}`,
      "",
      `This link expires in 7 days and can only be used once, with a sign-in account for the email address this message was sent to. If you weren't expecting this invitation, you can ignore it.`,
      "",
      `— SARbase`,
    ].join("\n"),
  };
}

/**
 * Dispatch the notification for an invitation's CURRENT token version.
 * A fresh send gets a fresh idempotency key (scoped by version) so each
 * resend is a new Notification — resends are never swallowed by replay
 * deduplication, and the stored body keeps the placeholder rather than
 * a live link.
 *
 * A dispatch failure is recorded and reported but does NOT remove the
 * invitation: the admin sees the send state and can resend once the
 * provider problem is fixed. Returns the up-to-date invitation row and
 * whether the provider actually accepted the send — the notificationId
 * link is recorded either way (it IS the delivery history), while
 * `delivered` reflects the notification's terminal status.
 */
async function dispatchInvitationNotification(
  invitation: MemberInvitation,
  deps: NotificationDispatchDeps,
): Promise<{ invitation: MemberInvitation; delivered: boolean }> {
  const member = await prisma.member.findUniqueOrThrow({
    where: { id: invitation.memberId },
    select: {
      displayName: true,
      organization: { select: { name: true } },
    },
  });
  const { subject, bodyText } = buildInvitationEmail({
    organizationName: member.organization.name,
    memberDisplayName: member.displayName,
    role: invitation.role,
  });

  try {
    const { notification } = await requestNotification(
      {
        organizationId: invitation.organizationId,
        channel: "EMAIL",
        // Direct destination, not a member-targeted send: the invitation
        // address is the admin's explicit choice (it may differ from the
        // member's contact email) and onboarding is administrative —
        // member notification preferences do not gate it.
        destination: invitation.email,
        template: MEMBER_INVITATION_TEMPLATE,
        subject,
        bodyText,
        metadata: {
          invitationId: invitation.id,
          memberId: invitation.memberId,
        },
        // A new send per token version — resends always dispatch.
        idempotencyKey: `member-invitation:${invitation.id}:v${invitation.tokenVersion}`,
      },
      invitation.createdByAuthIdentityId,
      deps,
    );
    const updated = await prisma.memberInvitation.update({
      where: { id: invitation.id },
      data: { notificationId: notification.id },
    });
    return {
      invitation: updated,
      delivered: notification.status === "ACCEPTED",
    };
  } catch (error) {
    logExpected({
      event: "member_invitation.dispatch_failed",
      subsystem: "invitations",
      entityType: "MemberInvitation",
      entityId: invitation.id,
      organizationId: invitation.organizationId,
      ...summarizeError(error),
    });
    return { invitation, delivered: false };
  }
}

/**
 * Issue a member invitation: create (or reissue the member's existing)
 * row, rotate the token, record the event, then dispatch the email.
 *
 * Reissuance — the same member row carries at most one invitation:
 * - none yet → create PENDING;
 * - REVOKED/ACCEPTED/expired-or-live PENDING → reset to PENDING with a
 *   new version. For a live PENDING invitation that is a RESEND path —
 *   use resendMemberInvitation instead so the distinction is explicit.
 *
 * Refuses when the member already has a linked sign-in identity — the
 * link is the finished state; inviting it again would be meaningless.
 */
export async function createMemberInvitation(
  memberId: string,
  input: MemberInvitationInput,
  actorAuthIdentityId: string,
  deps: NotificationDispatchDeps = {},
): Promise<{ invitation: MemberInvitation; delivered: boolean }> {
  assertMemberInvitationTokenConfigured();

  const member = await prisma.member.findUniqueOrThrow({
    where: { id: memberId },
    select: { id: true, organizationId: true, authIdentityId: true },
  });
  if (member.authIdentityId) {
    throw new InvitationMemberLinkedError();
  }

  const expiresAt = new Date(Date.now() + MEMBER_INVITATION_TTL_MS);
  const invitation = await prisma.$transaction(async (tx) => {
    const existing = await tx.memberInvitation.findUnique({
      where: { memberId },
    });
    const nextVersion = (existing?.tokenVersion ?? 0) + 1;
    // The token derivation names the invitation id — generate it up
    // front for a new row so the persisted hash matches.
    const invitationId = existing?.id ?? crypto.randomUUID();
    const data = {
      email: input.email,
      role: input.role,
      status: "PENDING" as const,
      expiresAt,
      tokenVersion: nextVersion,
      tokenHash: hashMemberInvitationToken(
        deriveMemberInvitationToken(invitationId, nextVersion),
      ),
      acceptedAt: null,
      revokedAt: null,
    };
    const row = existing
      ? await tx.memberInvitation.update({
          where: { id: existing.id },
          data,
        })
      : await tx.memberInvitation.create({
          data: {
            id: invitationId,
            organizationId: member.organizationId,
            memberId,
            createdByAuthIdentityId: actorAuthIdentityId,
            ...data,
          },
        });
    await tx.memberInvitationEvent.create({
      data: {
        organizationId: member.organizationId,
        invitationId: row.id,
        action: "CREATED",
        actorAuthIdentityId,
        detail: { role: input.role },
      },
    });
    return row;
  });

  log({
    event: "member_invitation.created",
    subsystem: "invitations",
    entityType: "MemberInvitation",
    entityId: invitation.id,
    organizationId: member.organizationId,
    memberId,
    actorId: actorAuthIdentityId,
    memberInvitationRole: input.role,
  });

  return dispatchInvitationNotification(invitation, deps);
}

/**
 * Resend a PENDING invitation — rotates the token (superseded links die
 * immediately), extends expiry, dispatches a fresh email, and records a
 * RESENT event. Not a new invitation: the row's identity and history
 * are preserved.
 */
export async function resendMemberInvitation(
  invitationId: string,
  actorAuthIdentityId: string,
  deps: NotificationDispatchDeps = {},
): Promise<{ invitation: MemberInvitation; delivered: boolean }> {
  assertMemberInvitationTokenConfigured();

  const expiresAt = new Date(Date.now() + MEMBER_INVITATION_TTL_MS);
  const invitation = await prisma.$transaction(async (tx) => {
    const current = await tx.memberInvitation.findUniqueOrThrow({
      where: { id: invitationId },
    });
    if (current.status !== "PENDING") {
      throw new InvitationStateError(
        "Only a pending invitation can be resent.",
      );
    }
    const nextVersion = current.tokenVersion + 1;
    const row = await tx.memberInvitation.update({
      where: { id: invitationId },
      data: {
        tokenVersion: nextVersion,
        tokenHash: hashMemberInvitationToken(
          deriveMemberInvitationToken(invitationId, nextVersion),
        ),
        expiresAt,
      },
    });
    await tx.memberInvitationEvent.create({
      data: {
        organizationId: current.organizationId,
        invitationId,
        action: "RESENT",
        actorAuthIdentityId,
      },
    });
    return row;
  });

  log({
    event: "member_invitation.resent",
    subsystem: "invitations",
    entityType: "MemberInvitation",
    entityId: invitation.id,
    organizationId: invitation.organizationId,
    memberId: invitation.memberId,
    actorId: actorAuthIdentityId,
  });

  return dispatchInvitationNotification(invitation, deps);
}

/** Revoke a PENDING invitation — the outstanding link dies immediately. */
export async function revokeMemberInvitation(
  invitationId: string,
  actorAuthIdentityId: string,
): Promise<void> {
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.memberInvitation.findUniqueOrThrow({
      where: { id: invitationId },
    });
    if (current.status !== "PENDING") {
      throw new InvitationStateError(
        current.status === "ACCEPTED"
          ? "This invitation was already accepted."
          : "This invitation was already revoked.",
      );
    }
    await tx.memberInvitation.update({
      where: { id: invitationId },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    await tx.memberInvitationEvent.create({
      data: {
        organizationId: current.organizationId,
        invitationId,
        action: "REVOKED",
        actorAuthIdentityId,
      },
    });
    return current;
  });

  log({
    event: "member_invitation.revoked",
    subsystem: "invitations",
    entityType: "MemberInvitation",
    entityId: result.id,
    organizationId: result.organizationId,
    memberId: result.memberId,
    actorId: actorAuthIdentityId,
  });
}

export interface VerifiedInvitationIdentity {
  /** Firebase uid (providerUid). */
  uid: string;
  /** Verified sign-in email claim, already normalized by the caller. */
  email: string | null;
  emailVerified: boolean;
}

/**
 * Accept an invitation with a verified Firebase identity. The caller
 * (invite action) has already run `verifyIdToken` — this function binds
 * the verified claims to the invitation atomically:
 *
 * - token resolves a PENDING, unexpired invitation (under row lock);
 * - the verified email equals the invitation destination;
 * - the identity is upserted, the member is linked, the invited role is
 *   granted, and the invitation is marked ACCEPTED — one transaction,
 *   so a concurrent accept sees the consumed state and fails cleanly.
 */
export async function acceptMemberInvitation(
  presentedToken: string,
  identity: VerifiedInvitationIdentity,
): Promise<{ invitationId: string; authIdentityId: string }> {
  const tokenHash = hashMemberInvitationToken(presentedToken);
  const invitation = await prisma.memberInvitation.findUnique({
    where: { tokenHash },
    include: { member: { select: { id: true, authIdentityId: true } } },
  });
  if (!invitation) {
    throw new InvitationAcceptanceError("invalid", "Invalid or expired link.");
  }
  if (invitation.status === "ACCEPTED") {
    throw new InvitationAcceptanceError(
      "accepted",
      "This invitation has already been accepted.",
    );
  }
  if (invitation.status === "REVOKED") {
    throw new InvitationAcceptanceError(
      "revoked",
      "This invitation has been revoked. Ask an administrator to send a new one.",
    );
  }
  if (invitation.expiresAt <= new Date()) {
    throw new InvitationAcceptanceError(
      "expired",
      "This invitation has expired. Ask an administrator to send a new one.",
    );
  }
  if (
    !verifyMemberInvitationToken(
      invitation.id,
      invitation.tokenVersion,
      presentedToken,
    )
  ) {
    throw new InvitationAcceptanceError("invalid", "Invalid or expired link.");
  }

  const normalizedEmail = identity.email?.trim().toLowerCase() ?? null;
  if (!normalizedEmail || normalizedEmail !== invitation.email) {
    throw new InvitationAcceptanceError(
      "email_mismatch",
      "Sign in with the account this invitation was sent to.",
    );
  }
  if (!identity.emailVerified) {
    throw new InvitationAcceptanceError(
      "email_unverified",
      "Verify your email address before accepting this invitation.",
    );
  }

  return prisma.$transaction(async (tx) => {
    // Serialize concurrent accepts on the invitation row — the second
    // one sees status ACCEPTED below and fails cleanly.
    const locked = await tx.$queryRaw<
      { id: string; status: string; expiresAt: Date }[]
    >`SELECT id, status, "expiresAt" FROM "MemberInvitation" WHERE id = ${invitation.id} FOR UPDATE`;
    const fresh = locked[0];
    if (!fresh || fresh.status !== "PENDING" || fresh.expiresAt <= new Date()) {
      throw new InvitationAcceptanceError(
        fresh?.status === "ACCEPTED" ? "accepted" : "invalid",
        "This invitation is no longer available.",
      );
    }

    const authIdentity = await tx.authIdentity.upsert({
      where: {
        provider_providerUid: {
          provider: AUTH_PROVIDER,
          providerUid: identity.uid,
        },
      },
      update: { email: normalizedEmail },
      create: {
        provider: AUTH_PROVIDER,
        providerUid: identity.uid,
        email: normalizedEmail,
      },
    });
    if (authIdentity.status !== "ACTIVE") {
      throw new InvitationAcceptanceError(
        "account_disabled",
        "This account is disabled. Contact an administrator.",
      );
    }

    // The member record must be unlinked — or already linked to THIS
    // identity (idempotent re-accept). A link to a different identity
    // never gets silently replaced.
    if (
      invitation.member.authIdentityId &&
      invitation.member.authIdentityId !== authIdentity.id
    ) {
      throw new InvitationAcceptanceError(
        "member_conflict",
        "This member record is already linked to a different account.",
      );
    }

    try {
      await tx.member.update({
        where: { id: invitation.memberId },
        data: { authIdentityId: authIdentity.id },
      });
    } catch (error) {
      // @@unique([organizationId, authIdentityId]): this identity already
      // links to a DIFFERENT member record in the organization.
      if (isUniqueViolation(error)) {
        throw new InvitationAcceptanceError(
          "member_conflict",
          "This account is already linked to a member record in this organization.",
        );
      }
      throw error;
    }

    // The grant is exactly the invited role — upsert so a pre-existing
    // row is reconciled to it rather than duplicated or left stale.
    await tx.organizationAccess.upsert({
      where: {
        authIdentityId_organizationId: {
          authIdentityId: authIdentity.id,
          organizationId: invitation.organizationId,
        },
      },
      update: { role: invitation.role },
      create: {
        authIdentityId: authIdentity.id,
        organizationId: invitation.organizationId,
        role: invitation.role,
      },
    });

    await tx.memberInvitation.update({
      where: { id: invitation.id },
      data: {
        status: "ACCEPTED",
        acceptedAt: new Date(),
        acceptedByAuthIdentityId: authIdentity.id,
      },
    });
    await tx.memberInvitationEvent.create({
      data: {
        organizationId: invitation.organizationId,
        invitationId: invitation.id,
        action: "ACCEPTED",
        actorAuthIdentityId: authIdentity.id,
        detail: { role: invitation.role },
      },
    });

    return { invitationId: invitation.id, authIdentityId: authIdentity.id };
  });
}
