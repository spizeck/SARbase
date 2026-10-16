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

import type { OrgCapability } from "@prisma/client";

import {
  adminOrganizationIds,
  getAuthContextOrThrow,
  hasOrgAccess,
  hasOrgCapability,
  isOrgAdmin,
  isOrgStaff,
  orgCapabilities,
  requireAuth,
  requireOrgAccess,
  requireOrgAdmin,
  requireOrgAdminForMember,
  requireOrgAdminForUnit,
  requireOrgAdminForCallout,
  requireOrgAdminForCalloutInvitation,
  requireOrgAdminOrNotFound,
  requireOrgCapability,
  requireOrgCapabilityOrNotFound,
  requireOrgStaffOrNotFound,
} from "./authorize";
import {
  AuthenticationError,
  AuthorizationError,
  type AuthContext,
} from "./context";

const ORG_A = "org-a";
const ORG_B = "org-b";

function ctx(
  role: string | null,
  orgId = ORG_A,
  capabilities: OrgCapability[] = [],
): AuthContext {
  return {
    identity: { id: "ident-1", status: "ACTIVE" },
    members: [],
    access: role
      ? [{ id: "acc-1", organizationId: orgId, role, capabilities }]
      : [],
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

describe("capability authorization (issue #84)", () => {
  const CAP = "EQUIPMENT_MANAGE" as OrgCapability;
  const OTHER_CAP = "FINANCE_APPROVE" as OrgCapability;

  it("ADMIN holds every capability implicitly", () => {
    expect(hasOrgCapability(ctx("ADMIN"), ORG_A, CAP)).toBe(true);
    expect(hasOrgCapability(ctx("ADMIN"), ORG_A, OTHER_CAP)).toBe(true);
  });

  it("MANAGER holds exactly the granted capabilities", () => {
    const manager = ctx("MANAGER", ORG_A, [CAP]);
    expect(hasOrgCapability(manager, ORG_A, CAP)).toBe(true);
    expect(hasOrgCapability(manager, ORG_A, OTHER_CAP)).toBe(false);
  });

  it("a MANAGER with no grants holds nothing", () => {
    expect(hasOrgCapability(ctx("MANAGER"), ORG_A, CAP)).toBe(false);
  });

  it("MEMBER never holds capabilities", () => {
    expect(hasOrgCapability(ctx("MEMBER"), ORG_A, CAP)).toBe(false);
    expect(hasOrgCapability(ctx(null), ORG_A, CAP)).toBe(false);
  });

  it("stale capabilities on a non-MANAGER row grant nothing", () => {
    // Domain logic clears grants on role change; even if a row were
    // left inconsistent, a MEMBER/ADMIN row's stored capabilities are
    // never consulted for MEMBER (deny-by-default).
    const member = ctx("MEMBER", ORG_A, [CAP]);
    expect(hasOrgCapability(member, ORG_A, CAP)).toBe(false);
  });

  it("capabilities are scoped to one organization", () => {
    const manager = ctx("MANAGER", ORG_A, [CAP]);
    expect(hasOrgCapability(manager, ORG_B, CAP)).toBe(false);
    expect(() => requireOrgCapability(manager, ORG_B, CAP)).toThrow(
      AuthorizationError,
    );
  });

  it("requireOrgCapability throws the opaque AuthorizationError", () => {
    expect(() => requireOrgCapability(ctx("MANAGER"), ORG_A, CAP)).toThrow(
      AuthorizationError,
    );
    expect(() =>
      requireOrgCapability(ctx("MANAGER", ORG_A, [CAP]), ORG_A, CAP),
    ).not.toThrow();
    expect(() => requireOrgCapability(ctx("ADMIN"), ORG_A, CAP)).not.toThrow();
  });

  it("isOrgStaff accepts ADMIN and MANAGER only", () => {
    expect(isOrgStaff(ctx("ADMIN"), ORG_A)).toBe(true);
    expect(isOrgStaff(ctx("MANAGER"), ORG_A)).toBe(true);
    expect(isOrgStaff(ctx("MEMBER"), ORG_A)).toBe(false);
    expect(isOrgStaff(ctx(null), ORG_A)).toBe(false);
  });

  it("orgCapabilities reports the effective set per role", () => {
    expect(orgCapabilities(ctx("ADMIN"), ORG_A).length).toBeGreaterThan(0);
    expect(orgCapabilities(ctx("MANAGER", ORG_A, [CAP]), ORG_A)).toEqual([CAP]);
    expect(orgCapabilities(ctx("MEMBER"), ORG_A)).toEqual([]);
    expect(orgCapabilities(ctx("ADMIN"), ORG_B)).toEqual([]);
  });

  it("requireOrgCapabilityOrNotFound 404s denied access", async () => {
    getAuthContextMock.mockResolvedValue(ctx("MANAGER"));
    await requireOrgCapabilityOrNotFound(ORG_A, CAP);
    expect(notFoundMock).toHaveBeenCalled();

    vi.clearAllMocks();
    getAuthContextMock.mockResolvedValue(ctx("MANAGER", ORG_A, [CAP]));
    await requireOrgCapabilityOrNotFound(ORG_A, CAP);
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("requireOrgStaffOrNotFound admits staff and rejects members", async () => {
    getAuthContextMock.mockResolvedValue(ctx("MANAGER"));
    await requireOrgStaffOrNotFound(ORG_A);
    expect(notFoundMock).not.toHaveBeenCalled();

    getAuthContextMock.mockResolvedValue(ctx("MEMBER"));
    await requireOrgStaffOrNotFound(ORG_A);
    expect(notFoundMock).toHaveBeenCalled();
  });
});
