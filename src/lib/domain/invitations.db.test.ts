import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Database-backed tests for the member-invitation lifecycle — run only
 * via `npm run test:db` (TEST_DATABASE_URL). Real rows, real unique
 * constraints, real row-lock serialization; the provider is always the
 * deterministic in-process fake (never the network). Fixture rows are
 * prefixed `invtest-` for cleanup.
 */

import { prisma } from "@/lib/prisma";
import {
  FakeNotificationProvider,
  fakeFailure,
} from "@/lib/notifications/fake";
import {
  requireOrgAdminForMember,
  requireOrgAdminForMemberInvitation,
} from "@/lib/auth/authorize";
import { AuthorizationError, type AuthContext } from "@/lib/auth/context";

import {
  acceptMemberInvitation,
  createMemberInvitation,
  getInvitationForToken,
  invitationDisplayState,
  resendMemberInvitation,
  revokeMemberInvitation,
  InvitationAcceptanceError,
  InvitationMemberLinkedError,
  InvitationStateError,
} from "./invitations";
import { MEMBER_INVITATION_TTL_MS } from "./invitationTokens";
const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "invtest-";

let counter = 0;
function uniq(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

let orgA: { id: string };
let orgB: { id: string };
let adminA: { id: string }; // ADMIN on orgA
let memberOnlyA: { id: string }; // MEMBER on orgA (not admin)
let adminB: { id: string }; // ADMIN on orgB — cross-org probe

function ctxFor(
  identityId: string,
  access: { organizationId: string; role: "ADMIN" | "MEMBER" }[],
): AuthContext {
  return {
    identity: { id: identityId } as AuthContext["identity"],
    access: access as AuthContext["access"],
    members: [],
  };
}

async function makeMember(
  orgId: string,
  overrides: { email?: string | null; authIdentityId?: string | null } = {},
) {
  return prisma.member.create({
    data: {
      organizationId: orgId,
      displayName: uniq("member"),
      email:
        overrides.email === undefined
          ? `${uniq("m")}@example.test`
          : overrides.email,
      ...(overrides.authIdentityId
        ? { authIdentityId: overrides.authIdentityId }
        : {}),
    },
  });
}

async function makeIdentity(email: string) {
  return prisma.authIdentity.create({
    data: { provider: "test", providerUid: uniq("uid"), email },
  });
}

async function grantAccess(
  identityId: string,
  orgId: string,
  role: "ADMIN" | "MEMBER",
) {
  return prisma.organizationAccess.create({
    data: { authIdentityId: identityId, organizationId: orgId, role },
  });
}

function invite(
  memberId: string,
  input: { email: string; role?: "MEMBER" | "ADMIN" },
  provider: FakeNotificationProvider = new FakeNotificationProvider(),
  actorId: string = adminA.id,
) {
  return createMemberInvitation(
    memberId,
    { email: input.email, role: input.role ?? "MEMBER" },
    actorId,
    { provider },
  );
}

/** Pull the emailed invitation token out of a captured provider call. */
function tokenFromCall(text: string | null | undefined): string {
  const match = /\/invite\?t=([A-Za-z0-9_-]+)/.exec(text ?? "");
  if (!match) throw new Error("no invite URL in provider call");
  return decodeURIComponent(match[1]!);
}

describe.skipIf(!hasDb)("member invitations", () => {
  beforeAll(async () => {
    orgA = await prisma.organization.create({
      data: { name: uniq("org-a") },
    });
    orgB = await prisma.organization.create({
      data: { name: uniq("org-b") },
    });
    adminA = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("admin-a"),
        email: `${uniq("admin-a")}@example.test`,
      },
    });
    memberOnlyA = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("member-a"),
        email: `${uniq("member-a")}@example.test`,
      },
    });
    adminB = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("admin-b"),
        email: `${uniq("admin-b")}@example.test`,
      },
    });
    await grantAccess(adminA.id, orgA.id, "ADMIN");
    await grantAccess(memberOnlyA.id, orgA.id, "MEMBER");
    await grantAccess(adminB.id, orgB.id, "ADMIN");
  });

  afterAll(async () => {
    const orgFilter = { organization: { name: { startsWith: PREFIX } } };
    const orgIds = [orgA.id, orgB.id];
    await prisma.memberInvitationEvent.deleteMany({ where: orgFilter });
    await prisma.memberInvitation.deleteMany({ where: orgFilter });
    await prisma.notificationAttempt.deleteMany({ where: orgFilter });
    await prisma.notification.deleteMany({ where: orgFilter });
    await prisma.member.deleteMany({ where: orgFilter });
    await prisma.organizationAccess.deleteMany({
      where: { organizationId: { in: orgIds } },
    });
    await prisma.authIdentity.deleteMany({
      where: { providerUid: { startsWith: PREFIX } },
    });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  /* ---------------- issuance ---------------- */

  it("creates a pending invitation, persists only the token hash, and emails the link", async () => {
    const member = await makeMember(orgA.id);
    const email = `${uniq("invitee")}@example.test`;
    const provider = new FakeNotificationProvider();

    const { invitation, delivered } = await invite(
      member.id,
      { email },
      provider,
    );

    expect(delivered).toBe(true);
    expect(invitation.status).toBe("PENDING");
    expect(invitation.role).toBe("MEMBER");
    expect(invitation.email).toBe(email);
    expect(invitation.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(invitation.notificationId).not.toBeNull();
    expect(invitation.createdByAuthIdentityId).toBe(adminA.id);

    // The provider got the live link; the durable body has only the
    // placeholder.
    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0]!;
    expect(call.to).toBe(email);
    const token = tokenFromCall(call.text);
    const notification = await prisma.notification.findUniqueOrThrow({
      where: { id: invitation.notificationId! },
    });
    expect(notification.bodyText).toContain("{member-invitation-url}");
    expect(notification.bodyText).not.toContain(token);
    expect(invitation.tokenHash).not.toContain(token);

    // Audit: a CREATED event names the org + actor; no token material.
    const events = await prisma.memberInvitationEvent.findMany({
      where: { invitationId: invitation.id },
    });
    expect(events.map((e) => e.action)).toEqual(["CREATED"]);
    expect(events[0]!.actorAuthIdentityId).toBe(adminA.id);
    expect(events[0]!.organizationId).toBe(orgA.id);
  });

  it("refuses to invite an already-linked member", async () => {
    const identity = await makeIdentity(`${uniq("linked")}@example.test`);
    const member = await makeMember(orgA.id, { authIdentityId: identity.id });
    await expect(
      invite(member.id, { email: `${uniq("x")}@example.test` }),
    ).rejects.toBeInstanceOf(InvitationMemberLinkedError);
  });

  it("survives a delivery failure without losing the invitation — resend retries", async () => {
    const member = await makeMember(orgA.id);
    const email = `${uniq("flaky")}@example.test`;
    const provider = new FakeNotificationProvider({
      defaultResult: fakeFailure.unavailable(),
    });

    const { invitation, delivered } = await invite(
      member.id,
      { email },
      provider,
    );
    expect(delivered).toBe(false);
    expect(invitation.status).toBe("PENDING");

    // Resend with a working provider — same invitation row, new token.
    const good = new FakeNotificationProvider();
    const resent = await resendMemberInvitation(invitation.id, adminA.id, {
      provider: good,
    });
    expect(resent.delivered).toBe(true);
    expect(resent.invitation.tokenVersion).toBe(2);
    expect(tokenFromCall(good.calls[0]!.text)).toBeTruthy();
  });

  /* ---------------- acceptance ---------------- */

  it("accepts with a verified matching identity: links the member and grants the invited role", async () => {
    const member = await makeMember(orgA.id);
    const email = `${uniq("accept")}@example.test`;
    const provider = new FakeNotificationProvider();
    const { invitation } = await invite(member.id, { email }, provider);
    const token = tokenFromCall(provider.calls[0]!.text);

    const uid = uniq("firebase-uid");
    const result = await acceptMemberInvitation(token, {
      uid,
      email,
      emailVerified: true,
    });
    expect(result.invitationId).toBe(invitation.id);

    const reloaded = await prisma.memberInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    expect(reloaded.status).toBe("ACCEPTED");
    expect(reloaded.acceptedAt).not.toBeNull();

    const linked = await prisma.member.findUniqueOrThrow({
      where: { id: member.id },
    });
    const identity = await prisma.authIdentity.findUniqueOrThrow({
      where: {
        provider_providerUid: { provider: "firebase", providerUid: uid },
      },
    });
    expect(linked.authIdentityId).toBe(identity.id);
    expect(reloaded.acceptedByAuthIdentityId).toBe(identity.id);

    const access = await prisma.organizationAccess.findMany({
      where: { authIdentityId: identity.id, organizationId: orgA.id },
    });
    expect(access).toHaveLength(1);
    expect(access[0]!.role).toBe("MEMBER");

    const events = await prisma.memberInvitationEvent.findMany({
      where: { invitationId: invitation.id },
    });
    expect(events.map((e) => e.action)).toEqual(["CREATED", "ACCEPTED"]);
  });

  it("grants ADMIN only when the invitation says so", async () => {
    const member = await makeMember(orgA.id);
    const email = `${uniq("admin-inv")}@example.test`;
    const provider = new FakeNotificationProvider();
    await invite(member.id, { email, role: "ADMIN" }, provider);
    const token = tokenFromCall(provider.calls[0]!.text);

    const uid = uniq("admin-uid");
    await acceptMemberInvitation(token, { uid, email, emailVerified: true });
    const identity = await prisma.authIdentity.findUniqueOrThrow({
      where: {
        provider_providerUid: { provider: "firebase", providerUid: uid },
      },
    });
    const access = await prisma.organizationAccess.findUniqueOrThrow({
      where: {
        authIdentityId_organizationId: {
          authIdentityId: identity.id,
          organizationId: orgA.id,
        },
      },
    });
    expect(access.role).toBe("ADMIN");
  });

  it("rejects an unverified sign-in email even when it matches", async () => {
    const member = await makeMember(orgA.id);
    const email = `${uniq("unverified")}@example.test`;
    const provider = new FakeNotificationProvider();
    await invite(member.id, { email }, provider);
    const token = tokenFromCall(provider.calls[0]!.text);

    await expect(
      acceptMemberInvitation(token, {
        uid: uniq("uid"),
        email,
        emailVerified: false,
      }),
    ).rejects.toMatchObject({
      name: "InvitationAcceptanceError",
      reason: "email_unverified",
    });

    // The invitation is NOT consumed — the invitee can verify and retry.
    const still = await prisma.memberInvitation.findUniqueOrThrow({
      where: { memberId: member.id },
    });
    expect(still.status).toBe("PENDING");
  });

  it("rejects a forwarded link: an identity whose verified email differs gets nothing", async () => {
    const member = await makeMember(orgA.id);
    const email = `${uniq("intended")}@example.test`;
    const provider = new FakeNotificationProvider();
    await invite(member.id, { email }, provider);
    const token = tokenFromCall(provider.calls[0]!.text);

    await expect(
      acceptMemberInvitation(token, {
        uid: uniq("attacker"),
        email: `${uniq("attacker")}@example.test`,
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ reason: "email_mismatch" });

    // Nothing was granted or linked.
    const reloaded = await prisma.member.findUniqueOrThrow({
      where: { id: member.id },
    });
    expect(reloaded.authIdentityId).toBeNull();
  });

  it("rejects expired, revoked, accepted, and unknown tokens distinctly", async () => {
    // Expired: force expiry on a live invitation.
    const mExpired = await makeMember(orgA.id);
    const p1 = new FakeNotificationProvider();
    const { invitation: expired } = await invite(
      mExpired.id,
      { email: `${uniq("exp")}@example.test` },
      p1,
    );
    await prisma.memberInvitation.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(
      acceptMemberInvitation(tokenFromCall(p1.calls[0]!.text), {
        uid: uniq("u"),
        email: expired.email,
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ reason: "expired" });

    // Revoked.
    const mRevoked = await makeMember(orgA.id);
    const p2 = new FakeNotificationProvider();
    const { invitation: revoked } = await invite(
      mRevoked.id,
      { email: `${uniq("rev")}@example.test` },
      p2,
    );
    await revokeMemberInvitation(revoked.id, adminA.id);
    await expect(
      acceptMemberInvitation(tokenFromCall(p2.calls[0]!.text), {
        uid: uniq("u"),
        email: revoked.email,
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ reason: "revoked" });

    // Accepted — replay of a consumed token.
    const mAccepted = await makeMember(orgA.id);
    const p3 = new FakeNotificationProvider();
    const { invitation: accepted } = await invite(
      mAccepted.id,
      { email: `${uniq("acc")}@example.test` },
      p3,
    );
    const token = tokenFromCall(p3.calls[0]!.text);
    const uid = uniq("replay");
    await acceptMemberInvitation(token, {
      uid,
      email: accepted.email,
      emailVerified: true,
    });
    await expect(
      acceptMemberInvitation(token, {
        uid: uniq("replay2"),
        email: accepted.email,
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ reason: "accepted" });

    // Unknown token.
    await expect(
      acceptMemberInvitation("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", {
        uid: uniq("u"),
        email: "nobody@example.test",
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ reason: "invalid" });
  });

  it("lets exactly one of two concurrent accepts succeed", async () => {
    const member = await makeMember(orgA.id);
    const email = `${uniq("race")}@example.test`;
    const provider = new FakeNotificationProvider();
    await invite(member.id, { email }, provider);
    const token = tokenFromCall(provider.calls[0]!.text);

    const uid = uniq("race-uid");
    const results = await Promise.allSettled([
      acceptMemberInvitation(token, { uid, email, emailVerified: true }),
      acceptMemberInvitation(token, { uid, email, emailVerified: true }),
    ]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toBeInstanceOf(InvitationAcceptanceError);

    // Exactly one link + one access grant + one ACCEPTED event.
    const linked = await prisma.member.findUniqueOrThrow({
      where: { id: member.id },
    });
    expect(linked.authIdentityId).not.toBeNull();
    const events = await prisma.memberInvitationEvent.findMany({
      where: { invitation: { memberId: member.id }, action: "ACCEPTED" },
    });
    expect(events).toHaveLength(1);
  });

  it("links an already-provisioned identity instead of duplicating it", async () => {
    // The invitee signed in before — an AuthIdentity already exists for
    // the uid. Acceptance must reuse it, not create a second row.
    const email = `${uniq("existing")}@example.test`;
    const uid = uniq("preexisting");
    const existing = await prisma.authIdentity.create({
      data: { provider: "firebase", providerUid: uid, email },
    });

    const member = await makeMember(orgA.id);
    const provider = new FakeNotificationProvider();
    await invite(member.id, { email }, provider);
    const token = tokenFromCall(provider.calls[0]!.text);

    const result = await acceptMemberInvitation(token, {
      uid,
      email,
      emailVerified: true,
    });
    expect(result.authIdentityId).toBe(existing.id);
    expect(
      await prisma.authIdentity.count({
        where: { provider: "firebase", providerUid: uid },
      }),
    ).toBe(1);
  });

  it("reconciles a pre-existing access grant to the invited role rather than duplicating it", async () => {
    const email = `${uniq("reconcile")}@example.test`;
    const uid = uniq("reconcile");
    const identity = await prisma.authIdentity.create({
      data: { provider: "firebase", providerUid: uid, email },
    });
    await grantAccess(identity.id, orgA.id, "MEMBER");

    const member = await makeMember(orgA.id);
    const provider = new FakeNotificationProvider();
    await invite(member.id, { email, role: "ADMIN" }, provider);
    await acceptMemberInvitation(tokenFromCall(provider.calls[0]!.text), {
      uid,
      email,
      emailVerified: true,
    });

    const rows = await prisma.organizationAccess.findMany({
      where: { authIdentityId: identity.id, organizationId: orgA.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("ADMIN");
  });

  it("refuses acceptance when the member got linked meanwhile, and when the identity is linked elsewhere", async () => {
    // Case 1: member linked to a DIFFERENT identity after the invite.
    const otherIdentity = await makeIdentity(`${uniq("other")}@example.test`);
    const m1 = await makeMember(orgA.id);
    const m1Email = `${uniq("m1")}@example.test`;
    const p1 = new FakeNotificationProvider();
    await invite(m1.id, { email: m1Email }, p1);
    await prisma.member.update({
      where: { id: m1.id },
      data: { authIdentityId: otherIdentity.id },
    });
    await expect(
      acceptMemberInvitation(tokenFromCall(p1.calls[0]!.text), {
        uid: uniq("u1"),
        email: m1Email,
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ reason: "member_conflict" });

    // Case 2: the accepting identity is already linked to another member
    // in this organization — the @@unique([organizationId,
    // authIdentityId]) collision maps to member_conflict.
    const email = `${uniq("shared")}@example.test`;
    const uid = uniq("shared-uid");
    const identity = await prisma.authIdentity.create({
      data: { provider: "firebase", providerUid: uid, email },
    });
    await makeMember(orgA.id, { authIdentityId: identity.id });
    const m2 = await makeMember(orgA.id);
    const p2 = new FakeNotificationProvider();
    await invite(m2.id, { email }, p2);
    await expect(
      acceptMemberInvitation(tokenFromCall(p2.calls[0]!.text), {
        uid,
        email,
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ reason: "member_conflict" });
  });

  /* ---------------- resend / revoke ---------------- */

  it("resend rotates the token: the old link dies, the new one works", async () => {
    const member = await makeMember(orgA.id);
    const email = `${uniq("resend")}@example.test`;
    const p1 = new FakeNotificationProvider();
    const { invitation } = await invite(member.id, { email }, p1);
    const oldToken = tokenFromCall(p1.calls[0]!.text);
    const oldExpiry = invitation.expiresAt;

    const p2 = new FakeNotificationProvider();
    const { invitation: resent, delivered } = await resendMemberInvitation(
      invitation.id,
      adminA.id,
      { provider: p2 },
    );
    expect(delivered).toBe(true);
    expect(resent.id).toBe(invitation.id); // same row — resend ≠ new invite
    expect(resent.tokenVersion).toBe(2);
    expect(resent.expiresAt.getTime()).toBeGreaterThanOrEqual(
      oldExpiry.getTime(),
    );
    expect(p2.calls).toHaveLength(1);
    const newToken = tokenFromCall(p2.calls[0]!.text);
    expect(newToken).not.toBe(oldToken);

    // The superseded link resolves to nothing.
    expect(await getInvitationForToken(oldToken)).toBeNull();
    await expect(
      acceptMemberInvitation(oldToken, {
        uid: uniq("u"),
        email,
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ reason: "invalid" });

    // The new link accepts.
    await acceptMemberInvitation(newToken, {
      uid: uniq("resent-uid"),
      email,
      emailVerified: true,
    });
    const events = await prisma.memberInvitationEvent.findMany({
      where: { invitationId: invitation.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.action)).toEqual([
      "CREATED",
      "RESENT",
      "ACCEPTED",
    ]);
  });

  it("resend refuses non-pending invitations", async () => {
    const member = await makeMember(orgA.id);
    const provider = new FakeNotificationProvider();
    const { invitation } = await invite(
      member.id,
      { email: `${uniq("nr")}@example.test` },
      provider,
    );
    await revokeMemberInvitation(invitation.id, adminA.id);
    await expect(
      resendMemberInvitation(invitation.id, adminA.id),
    ).rejects.toBeInstanceOf(InvitationStateError);
  });

  it("revoke kills the link immediately and refuses a second revoke", async () => {
    const member = await makeMember(orgA.id);
    const email = `${uniq("revoked")}@example.test`;
    const provider = new FakeNotificationProvider();
    const { invitation } = await invite(member.id, { email }, provider);
    const token = tokenFromCall(provider.calls[0]!.text);

    await revokeMemberInvitation(invitation.id, adminA.id);

    // The token still RESOLVES (the row is found) but reports revoked —
    // the page shows the honest state; acceptance refuses.
    const resolved = await getInvitationForToken(token);
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("REVOKED");
    await expect(
      acceptMemberInvitation(token, {
        uid: uniq("u"),
        email,
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ reason: "revoked" });

    await expect(
      revokeMemberInvitation(invitation.id, adminA.id),
    ).rejects.toBeInstanceOf(InvitationStateError);

    const events = await prisma.memberInvitationEvent.findMany({
      where: { invitationId: invitation.id },
    });
    expect(events.map((e) => e.action)).toEqual(["CREATED", "REVOKED"]);
  });

  it("re-inviting a revoked member reissues the row as a fresh CREATED invitation", async () => {
    const member = await makeMember(orgA.id);
    const p1 = new FakeNotificationProvider();
    const { invitation } = await invite(
      member.id,
      { email: `${uniq("r1")}@example.test` },
      p1,
    );
    await revokeMemberInvitation(invitation.id, adminA.id);

    const p2 = new FakeNotificationProvider();
    const newEmail = `${uniq("r2")}@example.test`;
    const { invitation: reissued, delivered } = await invite(
      member.id,
      { email: newEmail },
      p2,
    );
    expect(delivered).toBe(true);
    expect(reissued.id).toBe(invitation.id);
    expect(reissued.status).toBe("PENDING");
    expect(reissued.tokenVersion).toBe(2);
    expect(reissued.email).toBe(newEmail);

    const events = await prisma.memberInvitationEvent.findMany({
      where: { invitationId: invitation.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.action)).toEqual([
      "CREATED",
      "REVOKED",
      "CREATED",
    ]);
  });

  /* ---------------- display state ---------------- */

  it("derives the display state — expired is read-time, never materialized", () => {
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    expect(invitationDisplayState(null)).toBe("not_invited");
    expect(
      invitationDisplayState({ status: "PENDING", expiresAt: future }),
    ).toBe("pending");
    expect(invitationDisplayState({ status: "PENDING", expiresAt: past })).toBe(
      "expired",
    );
    expect(
      invitationDisplayState({ status: "ACCEPTED", expiresAt: past }),
    ).toBe("accepted");
    expect(
      invitationDisplayState({ status: "REVOKED", expiresAt: future }),
    ).toBe("revoked");
  });

  it("keeps a nearly-expired invitation pending until the exact instant, then expires it", () => {
    // One second to go — still pending; the boundary itself is expired
    // (expiry is inclusive: expiresAt <= now). A fixed injected clock
    // keeps this deterministic.
    const now = new Date("2027-10-15T12:00:00.000Z");
    const oneSecondOut = new Date(now.getTime() + 1_000);
    expect(
      invitationDisplayState(
        { status: "PENDING", expiresAt: oneSecondOut },
        now,
      ),
    ).toBe("pending");
    expect(
      invitationDisplayState({ status: "PENDING", expiresAt: now }, now),
    ).toBe("expired");
    // A fresh invitation's full 7-day window is far from the boundary.
    const fresh = new Date(now.getTime() + MEMBER_INVITATION_TTL_MS);
    expect(
      invitationDisplayState({ status: "PENDING", expiresAt: fresh }, now),
    ).toBe("pending");
  });

  /* ---------------- authorization ---------------- */

  it("scopes admin actions to the member's real organization — member-role and foreign-org admins are denied", async () => {
    const member = await makeMember(orgA.id);
    const provider = new FakeNotificationProvider();
    const { invitation } = await invite(
      member.id,
      { email: `${uniq("authz")}@example.test` },
      provider,
    );

    // Org A admin resolves the member.
    await expect(
      requireOrgAdminForMember(
        ctxFor(adminA.id, [{ organizationId: orgA.id, role: "ADMIN" }]),
        member.id,
      ),
    ).resolves.toMatchObject({ id: member.id });
    await expect(
      requireOrgAdminForMemberInvitation(
        ctxFor(adminA.id, [{ organizationId: orgA.id, role: "ADMIN" }]),
        invitation.id,
      ),
    ).resolves.toMatchObject({ id: invitation.id });

    // A MEMBER-only grant is not enough (elevated actions need ADMIN).
    await expect(
      requireOrgAdminForMember(
        ctxFor(memberOnlyA.id, [{ organizationId: orgA.id, role: "MEMBER" }]),
        member.id,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);

    // Admin of org B cannot act on org A's member or invitation.
    await expect(
      requireOrgAdminForMember(
        ctxFor(adminB.id, [{ organizationId: orgB.id, role: "ADMIN" }]),
        member.id,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      requireOrgAdminForMemberInvitation(
        ctxFor(adminB.id, [{ organizationId: orgB.id, role: "ADMIN" }]),
        invitation.id,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("cross-org: an invitation for org A can never grant access in org B", async () => {
    // The invitation's own organizationId is the grant target — even if
    // an org-B admin somehow presented a valid org-A token, the grant
    // lands in org A (its admin's choice), never the caller's org.
    const member = await makeMember(orgA.id);
    const email = `${uniq("xo")}@example.test`;
    const provider = new FakeNotificationProvider();
    await invite(member.id, { email }, provider);
    const token = tokenFromCall(provider.calls[0]!.text);

    const uid = uniq("xo-uid");
    const { authIdentityId } = await acceptMemberInvitation(token, {
      uid,
      email,
      emailVerified: true,
    });
    const grants = await prisma.organizationAccess.findMany({
      where: { authIdentityId },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]!.organizationId).toBe(orgA.id);
    expect(grants[0]!.organizationId).not.toBe(orgB.id);
  });
});
