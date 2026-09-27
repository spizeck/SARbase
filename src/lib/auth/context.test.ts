import { beforeEach, describe, expect, it, vi } from "vitest";

const { cookiesGetMock, verifySessionCookieMock, authIdentityFindUniqueMock } =
  vi.hoisted(() => ({
    cookiesGetMock: vi.fn(),
    verifySessionCookieMock: vi.fn(),
    authIdentityFindUniqueMock: vi.fn(),
  }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: cookiesGetMock }),
}));

vi.mock("./session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session")>()),
  verifySessionCookie: verifySessionCookieMock,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    authIdentity: { findUnique: authIdentityFindUniqueMock },
  },
}));

import { getAuthContext, loadAuthContext } from "./context";

function setCookie(value?: string) {
  cookiesGetMock.mockReturnValue(value ? { value } : undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getAuthContext", () => {
  it("returns null when no session cookie is present", async () => {
    setCookie(undefined);
    await expect(getAuthContext()).resolves.toBeNull();
    expect(verifySessionCookieMock).not.toHaveBeenCalled();
  });

  it("returns null when the session cookie fails verification", async () => {
    setCookie("cookie");
    verifySessionCookieMock.mockResolvedValue(null);
    await expect(getAuthContext()).resolves.toBeNull();
    expect(authIdentityFindUniqueMock).not.toHaveBeenCalled();
  });

  it("returns null for a verified session with no provisioned identity", async () => {
    setCookie("cookie");
    verifySessionCookieMock.mockResolvedValue({ sub: "uid-x" });
    authIdentityFindUniqueMock.mockResolvedValue(null);
    await expect(getAuthContext()).resolves.toBeNull();
  });

  it("resolves provider+uid to the identity record", async () => {
    setCookie("cookie");
    verifySessionCookieMock.mockResolvedValue({ sub: "uid-9" });
    authIdentityFindUniqueMock.mockResolvedValueOnce({ id: "ident-9" });
    authIdentityFindUniqueMock.mockResolvedValueOnce({
      id: "ident-9",
      status: "ACTIVE",
      members: [],
      organizationAccesses: [],
    });
    await expect(getAuthContext()).resolves.toMatchObject({
      identity: { id: "ident-9" },
    });
    expect(authIdentityFindUniqueMock).toHaveBeenNthCalledWith(1, {
      where: {
        provider_providerUid: { provider: "firebase", providerUid: "uid-9" },
      },
    });
  });
});

describe("loadAuthContext", () => {
  it("returns null for a DISABLED identity — disabled accounts fail closed", async () => {
    authIdentityFindUniqueMock.mockResolvedValue({
      id: "ident-1",
      status: "DISABLED",
      members: [],
      organizationAccesses: [{ organizationId: "org-1", role: "ADMIN" }],
    });
    await expect(loadAuthContext("ident-1")).resolves.toBeNull();
  });

  it("returns null for an unknown identity id", async () => {
    authIdentityFindUniqueMock.mockResolvedValue(null);
    await expect(loadAuthContext("missing")).resolves.toBeNull();
  });

  it("returns members and access rows for an ACTIVE identity", async () => {
    authIdentityFindUniqueMock.mockResolvedValue({
      id: "ident-1",
      status: "ACTIVE",
      members: [{ id: "m-1", organizationId: "org-1" }],
      organizationAccesses: [
        { id: "a-1", organizationId: "org-1", role: "ADMIN" },
      ],
    });
    const ctx = await loadAuthContext("ident-1");
    expect(ctx?.members).toHaveLength(1);
    expect(ctx?.access[0]?.role).toBe("ADMIN");
  });
});
