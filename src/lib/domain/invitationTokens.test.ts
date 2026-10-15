import { describe, expect, it } from "vitest";

import {
  deriveMemberInvitationToken,
  hashMemberInvitationToken,
  verifyMemberInvitationToken,
} from "./invitationTokens";

/**
 * Member-invitation token derivation — non-database behavior: the
 * token is deterministic per (invitationId, tokenVersion), verify is
 * version-scoped, and the persisted artifact is only the SHA-256 hash.
 */

describe("member invitation tokens", () => {
  it("derives a deterministic, version-scoped token", () => {
    const v1 = deriveMemberInvitationToken("inv-1", 1);
    expect(v1).toBe(deriveMemberInvitationToken("inv-1", 1));
    expect(v1).not.toBe(deriveMemberInvitationToken("inv-1", 2));
    expect(v1).not.toBe(deriveMemberInvitationToken("inv-2", 1));
    expect(v1).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url sha256
  });

  it("verifies only the live version's token", () => {
    const id = "inv-abc";
    const v1 = deriveMemberInvitationToken(id, 1);
    const v2 = deriveMemberInvitationToken(id, 2);
    expect(verifyMemberInvitationToken(id, 1, v1)).toBe(true);
    // A superseded token must not resolve under the new version.
    expect(verifyMemberInvitationToken(id, 2, v1)).toBe(false);
    expect(verifyMemberInvitationToken(id, 2, v2)).toBe(true);
    // Other ids, truncated tokens, and garbage all fail.
    expect(verifyMemberInvitationToken("inv-xyz", 1, v1)).toBe(false);
    expect(verifyMemberInvitationToken(id, 1, v1.slice(0, -2))).toBe(false);
    expect(verifyMemberInvitationToken(id, 1, "nonsense")).toBe(false);
  });

  it("persists a lookup hash that is not the token", () => {
    const token = deriveMemberInvitationToken("inv-1", 1);
    const hash = hashMemberInvitationToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    // The hash of a different version's token differs — token rotation
    // is observable in the persisted column.
    expect(
      hashMemberInvitationToken(deriveMemberInvitationToken("inv-1", 2)),
    ).not.toBe(hash);
  });
});
