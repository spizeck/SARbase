import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Production-gate tests for the /admin surface. Domain modules are
 * mocked so no database is touched — the point is proving the
 * fail-closed boundary: in production mode every action throws before
 * reaching a mutation, and pages 404.
 */

const { redirectMock, notFoundMock, revalidatePathMock, domainMocks } =
  vi.hoisted(() => ({
    redirectMock: vi.fn((url: string) => {
      throw new Error(`REDIRECT:${url}`);
    }),
    notFoundMock: vi.fn(() => {
      throw new Error("NEXT_NOT_FOUND");
    }),
    revalidatePathMock: vi.fn(),
    domainMocks: {
      createOrganization: vi.fn(async (input: { name: string }) => ({
        id: "org-1",
        ...input,
      })),
      updateOrganization: vi.fn(async () => ({ id: "org-1" })),
      listOrganizations: vi.fn(async () => []),
      getOrganization: vi.fn(async () => null),
      createUnit: vi.fn(async () => ({ id: "unit-1" })),
      updateUnit: vi.fn(async () => ({ id: "unit-1" })),
      listUnits: vi.fn(async () => []),
      createMember: vi.fn(async () => ({ id: "member-1" })),
      updateMember: vi.fn(async () => ({ id: "member-1" })),
      setMemberStatus: vi.fn(async () => ({ id: "member-1" })),
      setMemberUnits: vi.fn(async () => undefined),
      getMember: vi.fn(async () => null),
      listMembers: vi.fn(async () => []),
    },
  }));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
  notFound: notFoundMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/domain/organization", () => ({
  createOrganization: domainMocks.createOrganization,
  updateOrganization: domainMocks.updateOrganization,
  listOrganizations: domainMocks.listOrganizations,
  getOrganization: domainMocks.getOrganization,
}));
vi.mock("@/lib/domain/unit", () => ({
  createUnit: domainMocks.createUnit,
  updateUnit: domainMocks.updateUnit,
  listUnits: domainMocks.listUnits,
}));
vi.mock("@/lib/domain/member", () => ({
  createMember: domainMocks.createMember,
  updateMember: domainMocks.updateMember,
  setMemberStatus: domainMocks.setMemberStatus,
  setMemberUnits: domainMocks.setMemberUnits,
  getMember: domainMocks.getMember,
  listMembers: domainMocks.listMembers,
  CrossOrganizationAssignmentError: class CrossOrganizationAssignmentError extends Error {},
}));

import {
  createOrganizationAction,
  updateOrganizationAction,
  createUnitAction,
  updateUnitAction,
  createMemberAction,
  updateMemberAction,
  setMemberStatusAction,
  setMemberUnitsAction,
} from "./actions";
import AdminPage from "./page";
import OrganizationPage from "./organizations/[orgId]/page";
import MemberPage from "./members/[memberId]/page";
import { AdminDisabledError } from "@/lib/admin-gate";

const emptyForm = new FormData();

function memberForm() {
  const fd = new FormData();
  fd.set("displayName", "Pat Example");
  return fd;
}

describe("admin surface in production mode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("pages render the not-found boundary", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(AdminPage()).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(
      OrganizationPage({
        params: Promise.resolve({ orgId: "org-1" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(
      MemberPage({ params: Promise.resolve({ memberId: "member-1" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    // No domain reads happened — the gate precedes data access.
    expect(domainMocks.listOrganizations).not.toHaveBeenCalled();
    expect(domainMocks.getOrganization).not.toHaveBeenCalled();
    expect(domainMocks.getMember).not.toHaveBeenCalled();
  });

  it("every mutation action fails closed before touching the domain", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(createOrganizationAction({}, emptyForm)).rejects.toThrow(
      AdminDisabledError,
    );
    await expect(
      updateOrganizationAction("org-1", {}, emptyForm),
    ).rejects.toThrow(AdminDisabledError);
    await expect(createUnitAction("org-1", {}, emptyForm)).rejects.toThrow(
      AdminDisabledError,
    );
    await expect(
      updateUnitAction("unit-1", "org-1", {}, emptyForm),
    ).rejects.toThrow(AdminDisabledError);
    await expect(createMemberAction("org-1", {}, memberForm())).rejects.toThrow(
      AdminDisabledError,
    );
    await expect(
      updateMemberAction("member-1", "org-1", {}, memberForm()),
    ).rejects.toThrow(AdminDisabledError);
    await expect(
      setMemberStatusAction("member-1", "org-1", "INACTIVE"),
    ).rejects.toThrow(AdminDisabledError);
    await expect(
      setMemberUnitsAction("member-1", "org-1", {}, emptyForm),
    ).rejects.toThrow(AdminDisabledError);

    for (const mock of Object.values(domainMocks)) {
      expect(mock).not.toHaveBeenCalled();
    }
  });
});

describe("admin surface in development/test mode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("the /admin page renders", async () => {
    const tree = await AdminPage();
    expect(tree).toBeTruthy();
    expect(domainMocks.listOrganizations).toHaveBeenCalled();
  });

  it("a mutation action reaches the domain and redirects", async () => {
    const fd = new FormData();
    fd.set("name", "Example Org");

    await expect(createOrganizationAction({}, fd)).rejects.toThrow(
      "REDIRECT:/admin/organizations/org-1",
    );
    expect(domainMocks.createOrganization).toHaveBeenCalledWith({
      name: "Example Org",
    });
  });
});
