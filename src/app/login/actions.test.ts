import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyIdTokenMock,
  createSessionCookieMock,
  revokeRefreshTokensMock,
  cookieSetMock,
  upsertMock,
  isConfiguredMock,
} = vi.hoisted(() => ({
  verifyIdTokenMock: vi.fn(),
  createSessionCookieMock: vi.fn(),
  revokeRefreshTokensMock: vi.fn(),
  cookieSetMock: vi.fn(),
  upsertMock: vi.fn(),
  isConfiguredMock: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  getFirebaseAuth: () => ({
    verifyIdToken: verifyIdTokenMock,
    createSessionCookie: createSessionCookieMock,
    revokeRefreshTokens: revokeRefreshTokensMock,
  }),
}));

vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  isFirebaseAdminConfigured: () => isConfiguredMock(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { authIdentity: { upsert: upsertMock } },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: cookieSetMock, get: vi.fn() }),
}));

vi.mock("@/lib/auth/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/context")>()),
  getAuthContext: vi.fn().mockResolvedValue(null),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

import { createSessionAction, signOutAction } from "./actions";

beforeEach(() => {
  vi.clearAllMocks();
  isConfiguredMock.mockReturnValue(true);
});

describe("createSessionAction", () => {
  it("rejects malformed tokens without contacting Firebase", async () => {
    await expect(createSessionAction("")).resolves.toEqual({
      ok: false,
      error: "invalid_credentials",
    });
    await expect(createSessionAction("x".repeat(9000))).resolves.toEqual({
      ok: false,
      error: "invalid_credentials",
    });
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it("fails closed when server auth is unconfigured", async () => {
    isConfiguredMock.mockReturnValue(false);
    await expect(createSessionAction("token")).resolves.toEqual({
      ok: false,
      error: "not_configured",
    });
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("rejects an unverifiable ID token", async () => {
    verifyIdTokenMock.mockRejectedValue(new Error("bad token"));
    await expect(createSessionAction("token")).resolves.toEqual({
      ok: false,
      error: "invalid_credentials",
    });
    expect(upsertMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("provisions a zero-access identity and sets an HttpOnly cookie", async () => {
    verifyIdTokenMock.mockResolvedValue({
      sub: "uid-1",
      email: "Admin@Example.org",
    });
    upsertMock.mockResolvedValue({ id: "ident-1", status: "ACTIVE" });
    createSessionCookieMock.mockResolvedValue("session-cookie");

    await expect(createSessionAction("token")).resolves.toEqual({ ok: true });

    // Identity keyed on (provider, providerUid); email normalized.
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider_providerUid: {
            provider: "firebase",
            providerUid: "uid-1",
          },
        },
        create: expect.objectContaining({
          provider: "firebase",
          providerUid: "uid-1",
          email: "admin@example.org",
        }),
      }),
    );
    const [name, value, options] = cookieSetMock.mock.calls[0]!;
    expect(name).toBe("sarbase_session");
    expect(value).toBe("session-cookie");
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
  });

  it("refuses a session for a DISABLED identity", async () => {
    verifyIdTokenMock.mockResolvedValue({ sub: "uid-1" });
    upsertMock.mockResolvedValue({ id: "ident-1", status: "DISABLED" });
    await expect(createSessionAction("token")).resolves.toEqual({
      ok: false,
      error: "account_disabled",
    });
    expect(cookieSetMock).not.toHaveBeenCalled();
  });
});

describe("signOutAction", () => {
  it("always clears the session cookie", async () => {
    await signOutAction();
    expect(cookieSetMock).toHaveBeenCalledWith(
      "sarbase_session",
      "",
      expect.objectContaining({ maxAge: 0 }),
    );
  });
});
