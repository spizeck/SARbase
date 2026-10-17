import { describe, expect, it } from "vitest";

import {
  memberAccountState,
  MEMBER_ACCOUNT_STATE_LABELS,
} from "./member-account";

/**
 * Pure derivation coverage — every state is checked against
 * authoritative facts only: a linked identity (+ its status and
 * lastSignInAt), or the invitation row's status/expiry. Nothing is
 * inferred from email addresses.
 */
const NOW = new Date("2026-10-17T12:00:00Z");
const EARLIER = new Date("2026-10-17T11:00:00Z");
const LATER = new Date("2026-10-18T12:00:00Z");

function invitation(
  status: "PENDING" | "ACCEPTED" | "REVOKED",
  expiresAt: Date = LATER,
) {
  return { status, expiresAt };
}

describe("memberAccountState", () => {
  it("not_invited — no invitation row, no linked identity", () => {
    expect(
      memberAccountState({ authIdentity: null, memberInvitation: null }, NOW),
    ).toBe("not_invited");
  });

  it("invited — pending invitation within its validity window", () => {
    expect(
      memberAccountState(
        {
          authIdentity: null,
          memberInvitation: invitation("PENDING", LATER),
        },
        NOW,
      ),
    ).toBe("invited");
  });

  it("invitation_expired — pending invitation past expiry", () => {
    expect(
      memberAccountState(
        {
          authIdentity: null,
          memberInvitation: invitation("PENDING", EARLIER),
        },
        NOW,
      ),
    ).toBe("invitation_expired");
  });

  it("invitation_expired at the exact expiry instant", () => {
    expect(
      memberAccountState(
        {
          authIdentity: null,
          memberInvitation: invitation("PENDING", NOW),
        },
        NOW,
      ),
    ).toBe("invitation_expired");
  });

  it("invitation_revoked — revoked before acceptance", () => {
    expect(
      memberAccountState(
        {
          authIdentity: null,
          memberInvitation: invitation("REVOKED"),
        },
        NOW,
      ),
    ).toBe("invitation_revoked");
  });

  it("invitation_accepted — accepted but identity unlinked afterwards", () => {
    expect(
      memberAccountState(
        {
          authIdentity: null,
          memberInvitation: invitation("ACCEPTED"),
        },
        NOW,
      ),
    ).toBe("invitation_accepted");
  });

  it("account_linked — linked ACTIVE identity, no verified sign-in", () => {
    expect(
      memberAccountState(
        {
          authIdentity: { status: "ACTIVE", lastSignInAt: null },
          memberInvitation: invitation("ACCEPTED"),
        },
        NOW,
      ),
    ).toBe("account_linked");
  });

  it("active_account — linked ACTIVE identity with a verified sign-in", () => {
    expect(
      memberAccountState(
        {
          authIdentity: { status: "ACTIVE", lastSignInAt: EARLIER },
          memberInvitation: invitation("ACCEPTED"),
        },
        NOW,
      ),
    ).toBe("active_account");
  });

  it("account_disabled — linked DISABLED identity (sign-in history irrelevant)", () => {
    expect(
      memberAccountState(
        {
          authIdentity: { status: "DISABLED", lastSignInAt: EARLIER },
          memberInvitation: invitation("ACCEPTED"),
        },
        NOW,
      ),
    ).toBe("account_disabled");
  });

  it("a linked identity wins over invitation history — a stale pending row cannot shadow the account", () => {
    expect(
      memberAccountState(
        {
          authIdentity: { status: "ACTIVE", lastSignInAt: EARLIER },
          memberInvitation: invitation("PENDING", LATER),
        },
        NOW,
      ),
    ).toBe("active_account");
  });

  it("every state has a display label", () => {
    const states = [
      "not_invited",
      "invited",
      "invitation_expired",
      "invitation_revoked",
      "invitation_accepted",
      "account_linked",
      "active_account",
      "account_disabled",
    ] as const;
    for (const state of states) {
      expect(MEMBER_ACCOUNT_STATE_LABELS[state]).toBeTruthy();
    }
  });
});
