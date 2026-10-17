import type {
  AuthIdentityStatus,
  MemberInvitationStatus,
} from "@prisma/client";

import { invitationDisplayState } from "./invitations";

/**
 * A member's ACCOUNT/onboarding state — completely separate from
 * `Member.status` (membership status). Membership says whether the
 * domain person record is active in the organization; this state says
 * where the person is on the sign-in journey. Neither implies the
 * other: an ACTIVE member may have no account, and a linked account
 * never activates or deactivates membership.
 *
 * Every state is derived from authoritative rows at read time — a
 * linked AuthIdentity, its status, and `lastSignInAt` (recorded only
 * on verified successful sign-in), or the member's invitation row
 * with expiry derived like everywhere else. Nothing is inferred from
 * an email address, and no sign-in history is guessed.
 */
export type MemberAccountState =
  /** No invitation row and no linked sign-in identity. */
  | "not_invited"
  /** Outstanding invitation, not yet expired. */
  | "invited"
  /** Invitation exists but its validity window has passed. */
  | "invitation_expired"
  /** Invitation was revoked before acceptance. */
  | "invitation_revoked"
  /** Invitation was accepted but the identity link was removed later. */
  | "invitation_accepted"
  /** Identity linked with no verified successful sign-in recorded. */
  | "account_linked"
  /** Identity linked with at least one verified successful sign-in. */
  | "active_account"
  /** Linked identity is disabled — cannot hold a session. */
  | "account_disabled";

export const MEMBER_ACCOUNT_STATE_LABELS: Record<MemberAccountState, string> = {
  not_invited: "Not invited",
  invited: "Invited",
  invitation_expired: "Invitation expired",
  invitation_revoked: "Invitation revoked",
  invitation_accepted: "Invitation accepted",
  account_linked: "Account linked",
  active_account: "Active account",
  account_disabled: "Account disabled",
};

/**
 * Badge tint per account state — semantic palette classes only; the
 * dark theme rebinds them automatically. Amber marks states waiting on
 * the member (sent/expired invitations), green a verified-active
 * account, blue a linked-not-yet-used account, red a disabled account,
 * neutral the rest.
 */
export function memberAccountBadgeClass(state: MemberAccountState): string {
  switch (state) {
    case "active_account":
      return "bg-green-100 text-green-800";
    case "invited":
    case "invitation_expired":
      return "bg-amber-100 text-amber-800";
    case "account_linked":
      return "bg-blue-100 text-blue-800";
    case "account_disabled":
      return "bg-red-100 text-red-800";
    default:
      return "bg-neutral-100 text-neutral-600";
  }
}

export interface MemberAccountFacts {
  /**
   * The linked identity's status and sign-in marker — include
   * `authIdentity` on the member query. `null` covers both "never
   * linked" and "linked then unlinked" (FK is SetNull).
   */
  authIdentity: {
    status: AuthIdentityStatus;
    lastSignInAt: Date | null;
  } | null;
  /** The member's single invitation row, if any. */
  memberInvitation: {
    status: MemberInvitationStatus;
    expiresAt: Date;
  } | null;
}

/**
 * Derive the account state. A linked identity always wins over
 * invitation history — the invitation row survives acceptance as
 * history, so an accepted (or revoked) invitation alongside a linked
 * identity must not shadow the account's real state.
 */
export function memberAccountState(
  facts: MemberAccountFacts,
  now: Date = new Date(),
): MemberAccountState {
  const identity = facts.authIdentity;
  if (identity) {
    if (identity.status === "DISABLED") {
      return "account_disabled";
    }
    return identity.lastSignInAt ? "active_account" : "account_linked";
  }

  switch (invitationDisplayState(facts.memberInvitation, now)) {
    case "pending":
      return "invited";
    case "expired":
      return "invitation_expired";
    case "revoked":
      return "invitation_revoked";
    case "accepted":
      return "invitation_accepted";
    default:
      return "not_invited";
  }
}
