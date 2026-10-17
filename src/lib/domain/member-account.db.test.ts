import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { createOrganization } from "@/lib/domain/organization";
import { listMembersWithAccount } from "@/lib/domain/member";
import { memberAccountState } from "@/lib/domain/member-account";

/**
 * Database coverage for the account/onboarding facts loaded by the
 * members screen — each account state is materialized with real rows
 * (invitation + linked identity combinations) and asserted through the
 * same query and derivation the page uses.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "dbtest-macct-";

let counter = 0;
function uniqueName(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

describe.skipIf(!hasDb)("member account state", () => {
  afterAll(async () => {
    await prisma.memberInvitation.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.member.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.authIdentity.deleteMany({
      where: { providerUid: { startsWith: PREFIX } },
    });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  it("returns facts that derive every account state end-to-end", async () => {
    const org = await createOrganization({ name: uniqueName("org") });
    const now = new Date();

    const member = (displayName: string) =>
      prisma.member.create({
        data: { organizationId: org.id, displayName },
      });

    const linked = await prisma.authIdentity.create({
      data: {
        provider: "firebase",
        providerUid: uniqueName("uid-linked"),
      },
    });
    const signedIn = await prisma.authIdentity.create({
      data: {
        provider: "firebase",
        providerUid: uniqueName("uid-signed"),
        lastSignInAt: now,
      },
    });
    const disabled = await prisma.authIdentity.create({
      data: {
        provider: "firebase",
        providerUid: uniqueName("uid-disabled"),
        status: "DISABLED",
        lastSignInAt: now,
      },
    });

    const notInvited = await member(uniqueName("not-invited"));

    const invited = await member(uniqueName("invited"));
    await prisma.memberInvitation.create({
      data: {
        organizationId: org.id,
        memberId: invited.id,
        email: "invited@example.org",
        role: "MEMBER",
        tokenHash: uniqueName("hash-invited"),
        status: "PENDING",
        expiresAt: new Date(now.getTime() + 86400_000),
      },
    });

    const expired = await member(uniqueName("expired"));
    await prisma.memberInvitation.create({
      data: {
        organizationId: org.id,
        memberId: expired.id,
        email: "expired@example.org",
        role: "MEMBER",
        tokenHash: uniqueName("hash-expired"),
        status: "PENDING",
        expiresAt: new Date(now.getTime() - 1000),
      },
    });

    const revoked = await member(uniqueName("revoked"));
    await prisma.memberInvitation.create({
      data: {
        organizationId: org.id,
        memberId: revoked.id,
        email: "revoked@example.org",
        role: "MEMBER",
        tokenHash: uniqueName("hash-revoked"),
        status: "REVOKED",
        expiresAt: new Date(now.getTime() + 86400_000),
      },
    });

    const acceptedUnlinked = await member(uniqueName("accepted"));
    await prisma.memberInvitation.create({
      data: {
        organizationId: org.id,
        memberId: acceptedUnlinked.id,
        email: "accepted@example.org",
        role: "MEMBER",
        tokenHash: uniqueName("hash-accepted"),
        status: "ACCEPTED",
        expiresAt: new Date(now.getTime() + 86400_000),
      },
    });

    const noSignIn = await prisma.member.create({
      data: {
        organizationId: org.id,
        displayName: uniqueName("linked"),
        authIdentityId: linked.id,
      },
    });
    const active = await prisma.member.create({
      data: {
        organizationId: org.id,
        displayName: uniqueName("active"),
        authIdentityId: signedIn.id,
      },
    });
    const disabledMember = await prisma.member.create({
      data: {
        organizationId: org.id,
        displayName: uniqueName("disabled"),
        authIdentityId: disabled.id,
      },
    });

    const members = await listMembersWithAccount(org.id);
    const byId = new Map(members.map((m) => [m.id, m]));

    expect(memberAccountState(byId.get(notInvited.id)!)).toBe("not_invited");
    expect(memberAccountState(byId.get(invited.id)!)).toBe("invited");
    expect(memberAccountState(byId.get(expired.id)!)).toBe(
      "invitation_expired",
    );
    expect(memberAccountState(byId.get(revoked.id)!)).toBe(
      "invitation_revoked",
    );
    expect(memberAccountState(byId.get(acceptedUnlinked.id)!)).toBe(
      "invitation_accepted",
    );
    expect(memberAccountState(byId.get(noSignIn.id)!)).toBe("account_linked");
    expect(memberAccountState(byId.get(active.id)!)).toBe("active_account");
    expect(memberAccountState(byId.get(disabledMember.id)!)).toBe(
      "account_disabled",
    );
  });

  it("membership status stays independent of account state", async () => {
    const org = await createOrganization({ name: uniqueName("org") });
    // An INACTIVE member can hold an ACTIVE account — neither implies
    // the other.
    const identity = await prisma.authIdentity.create({
      data: {
        provider: "firebase",
        providerUid: uniqueName("uid"),
        lastSignInAt: new Date(),
      },
    });
    const member = await prisma.member.create({
      data: {
        organizationId: org.id,
        displayName: uniqueName("inactive"),
        status: "INACTIVE",
        authIdentityId: identity.id,
      },
    });

    const [listed] = await listMembersWithAccount(org.id);
    expect(listed!.status).toBe("INACTIVE");
    expect(memberAccountState(listed!)).toBe("active_account");
    expect(member.id).toBe(listed!.id);
  });
});
