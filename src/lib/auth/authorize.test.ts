import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getAuthContextMock,
  memberFindUniqueMock,
  unitFindUniqueMock,
  calloutFindUniqueMock,
  calloutInvitationFindUniqueMock,
  redirectMock,
  notFoundMock,
} = vi.hoisted(() => ({
  getAuthContextMock: vi.fn(),
  memberFindUniqueMock: vi.fn(),
  unitFindUniqueMock: vi.fn(),
  calloutFindUniqueMock: vi.fn(),
  calloutInvitationFindUniqueMock: vi.fn(),
  redirectMock: vi.fn(),
  notFoundMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
  notFound: () => notFoundMock(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: memberFindUniqueMock },
    unit: { findUnique: unitFindUniqueMock },
    callout: { findUnique: calloutFindUniqueMock },
    calloutInvitation: { findUnique: calloutInvitationFindUniqueMock },
  },
}));

vi.mock("./context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./context")>()),
  getAuthContext: getAuthContextMock,
}));

import {
  adminOrganizationIds,
  getAuthContextOrThrow,
  hasOrgAccess,
  isOrgAdmin,
  requireAuth,
  requireOrgAccess,
  requireOrgAdmin,
  requireOrgAdminForMember,
  requireOrgAdminForUnit,
  requireOrgAdminForCallout,
  requireOrgAdminForCalloutInvitation,
  requireOrgAdminOrNotFound,
} from "./authorize";
import {
  AuthenticationError,
  AuthorizationError,
  type AuthContext,
} from "./context";

const ORG_A = "org-a";
const ORG_B = "org-b";

function ctx(role: string | null, orgId = ORG_A): AuthContext {
  return {
    identity: { id: "ident-1", status: "ACTIVE" },
    members: [],
    access: role ? [{ id: "acc-1", organizationId: orgId, role }] : [],
  } as unknown as AuthContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireAuth / getAuthContextOrThrow", () => {
  it("redirects unauthenticated requests to /login", async () => {
    getAuthContextMock.mockResolvedValue(null);
    await requireAuth();
    expect(redirectMock).toHaveBeenCalledWith("/login");
  });

  it("returns the context when authenticated", async () => {
    const c = ctx("ADMIN");
    getAuthContextMock.mockResolvedValue(c);
    await expect(requireAuth()).resolves.toBe(c);
  });

  it("throws AuthenticationError in the non-redirecting variant", async () => {
    getAuthContextMock.mockResolvedValue(null);
    await expect(getAuthContextOrThrow()).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });
});

describe("role predicates", () => {
  it("isOrgAdmin is true only for an ADMIN row on that org", () => {
    expect(isOrgAdmin(ctx("ADMIN"), ORG_A)).toBe(true);
    expect(isOrgAdmin(ctx("MEMBER"), ORG_A)).toBe(false);
    expect(isOrgAdmin(ctx(null), ORG_A)).toBe(false);
    expect(isOrgAdmin(ctx("ADMIN"), ORG_B)).toBe(false);
  });

  it("hasOrgAccess accepts any role on that org", () => {
    expect(hasOrgAccess(ctx("MEMBER"), ORG_A)).toBe(true);
    expect(hasOrgAccess(ctx("MEMBER"), ORG_B)).toBe(false);
  });

  it("adminOrganizationIds lists only ADMIN organizations", () => {
    const c = {
      identity: { id: "i" },
      members: [],
      access: [
        { organizationId: ORG_A, role: "ADMIN" },
        { organizationId: ORG_B, role: "MEMBER" },
      ],
    } as unknown as AuthContext;
    expect(adminOrganizationIds(c)).toEqual([ORG_A]);
  });
});

describe("requireOrgAdmin / requireOrgAccess", () => {
  it("throws a single opaque AuthorizationError for non-admins", () => {
    expect(() => requireOrgAdmin(ctx("MEMBER"), ORG_A)).toThrow(
      AuthorizationError,
    );
    expect(() => requireOrgAdmin(ctx(null), ORG_A)).toThrow(
      "Not found or not permitted.",
    );
  });

  it("passes for an admin of the given org", () => {
    expect(() => requireOrgAdmin(ctx("ADMIN"), ORG_A)).not.toThrow();
  });

  it("requireOrgAccess accepts ordinary members", () => {
    expect(() => requireOrgAccess(ctx("MEMBER"), ORG_A)).not.toThrow();
    expect(() => requireOrgAccess(ctx("ADMIN"), ORG_B)).toThrow(
      AuthorizationError,
    );
  });
});

describe("requireOrgAdminOrNotFound", () => {
  it("notFounds a non-admin rather than revealing the org exists", async () => {
    getAuthContextMock.mockResolvedValue(ctx("MEMBER"));
    await requireOrgAdminOrNotFound(ORG_A);
    expect(notFoundMock).toHaveBeenCalled();
  });
});

describe("requireOrgAdminForMember — scope derived from the record", () => {
  it("throws when the member is in another org, whatever the caller asked", async () => {
    memberFindUniqueMock.mockResolvedValue({
      id: "member-b",
      organizationId: ORG_B,
    });
    await expect(
      requireOrgAdminForMember(ctx("ADMIN", ORG_A), "member-b"),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // The lookup used ONLY the supplied id as a selector.
    expect(memberFindUniqueMock).toHaveBeenCalledWith({
      where: { id: "member-b" },
    });
  });

  it("throws the same error for a nonexistent member (no existence leak)", async () => {
    memberFindUniqueMock.mockResolvedValue(null);
    await expect(
      requireOrgAdminForMember(ctx("ADMIN", ORG_A), "missing"),
    ).rejects.toThrow("Not found or not permitted.");
  });

  it("returns the member when the caller administers its real org", async () => {
    const member = { id: "member-a", organizationId: ORG_A };
    memberFindUniqueMock.mockResolvedValue(member);
    await expect(
      requireOrgAdminForMember(ctx("ADMIN", ORG_A), "member-a"),
    ).resolves.toBe(member);
  });

  it("denies an ordinary MEMBER even for their own org", async () => {
    memberFindUniqueMock.mockResolvedValue({
      id: "member-a",
      organizationId: ORG_A,
    });
    await expect(
      requireOrgAdminForMember(ctx("MEMBER", ORG_A), "member-a"),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("requireOrgAdminForUnit", () => {
  it("derives the org from the unit record, not the caller", async () => {
    unitFindUniqueMock.mockResolvedValue({ id: "u-b", organizationId: ORG_B });
    await expect(
      requireOrgAdminForUnit(ctx("ADMIN", ORG_A), "u-b"),
    ).rejects.toBeInstanceOf(AuthorizationError);

    unitFindUniqueMock.mockResolvedValue({ id: "u-a", organizationId: ORG_A });
    await expect(
      requireOrgAdminForUnit(ctx("ADMIN", ORG_A), "u-a"),
    ).resolves.toMatchObject({ id: "u-a" });
  });
});

describe("requireOrgAdminForCallout — scope derived from the record", () => {
  it("denies a callout in another org, whatever the caller asked", async () => {
    calloutFindUniqueMock.mockResolvedValue({
      id: "co-b",
      organizationId: ORG_B,
    });
    await expect(
      requireOrgAdminForCallout(ctx("ADMIN", ORG_A), "co-b"),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(calloutFindUniqueMock).toHaveBeenCalledWith({
      where: { id: "co-b" },
    });
  });

  it("throws the same error for a nonexistent callout (no existence leak)", async () => {
    calloutFindUniqueMock.mockResolvedValue(null);
    await expect(
      requireOrgAdminForCallout(ctx("ADMIN", ORG_A), "missing"),
    ).rejects.toThrow("Not found or not permitted.");
  });

  it("returns the callout when the caller administers its real org", async () => {
    const callout = { id: "co-a", organizationId: ORG_A };
    calloutFindUniqueMock.mockResolvedValue(callout);
    await expect(
      requireOrgAdminForCallout(ctx("ADMIN", ORG_A), "co-a"),
    ).resolves.toBe(callout);
  });

  it("denies an ordinary MEMBER even for their own org", async () => {
    calloutFindUniqueMock.mockResolvedValue({
      id: "co-a",
      organizationId: ORG_A,
    });
    await expect(
      requireOrgAdminForCallout(ctx("MEMBER", ORG_A), "co-a"),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("requireOrgAdminForCalloutInvitation", () => {
  it("derives the org from the invitation record, not the caller", async () => {
    calloutInvitationFindUniqueMock.mockResolvedValue({
      id: "inv-b",
      organizationId: ORG_B,
    });
    await expect(
      requireOrgAdminForCalloutInvitation(ctx("ADMIN", ORG_A), "inv-b"),
    ).rejects.toBeInstanceOf(AuthorizationError);

    calloutInvitationFindUniqueMock.mockResolvedValue({
      id: "inv-a",
      organizationId: ORG_A,
    });
    await expect(
      requireOrgAdminForCalloutInvitation(ctx("ADMIN", ORG_A), "inv-a"),
    ).resolves.toMatchObject({ id: "inv-a" });
  });

  it("denies an admin of a different org opaquely", async () => {
    // Admin of ORG_B probes an invitation that lives in ORG_A — the
    // record's own organizationId decides; the grant for B is irrelevant.
    calloutInvitationFindUniqueMock.mockResolvedValue({
      id: "inv-a",
      organizationId: ORG_A,
    });
    await expect(
      requireOrgAdminForCalloutInvitation(ctx("ADMIN", ORG_B), "inv-a"),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
