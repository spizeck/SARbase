import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const verifySessionCookieMock = vi.fn();
const createSessionCookieMock = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  getFirebaseAuth: () => ({
    verifySessionCookie: verifySessionCookieMock,
    createSessionCookie: createSessionCookieMock,
  }),
}));

import {
  createSessionCookie,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  sessionCookieOptions,
  shouldUseSecureCookies,
  verifySessionCookie,
} from "./session";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("session cookie verification", () => {
  it("verifies with revocation checking enabled", async () => {
    verifySessionCookieMock.mockResolvedValue({ sub: "uid-1" });
    await expect(verifySessionCookie("cookie-value")).resolves.toEqual({
      sub: "uid-1",
    });
    expect(verifySessionCookieMock).toHaveBeenCalledWith("cookie-value", true);
  });

  it("fails closed on invalid/expired/revoked cookies", async () => {
    verifySessionCookieMock.mockRejectedValue(new Error("expired"));
    await expect(verifySessionCookie("bad")).resolves.toBeNull();
  });

  it("fails closed when the admin SDK itself throws", async () => {
    verifySessionCookieMock.mockImplementation(() => {
      throw new Error("unconfigured");
    });
    await expect(verifySessionCookie("x")).resolves.toBeNull();
  });
});

describe("createSessionCookie", () => {
  it("mints with the configured max age", async () => {
    createSessionCookieMock.mockResolvedValue("minted-cookie");
    await expect(createSessionCookie("id-token")).resolves.toBe(
      "minted-cookie",
    );
    expect(createSessionCookieMock).toHaveBeenCalledWith("id-token", {
      expiresIn: SESSION_MAX_AGE_SECONDS * 1000,
    });
  });
});

describe("sessionCookieOptions", () => {
  it("is HttpOnly, SameSite=Lax, root path, bounded lifetime", () => {
    delete process.env.VERCEL_ENV;
    delete process.env.APP_BASE_URL;
    const options = sessionCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    expect(options.maxAge).toBe(SESSION_MAX_AGE_SECONDS);
  });
});

describe("shouldUseSecureCookies", () => {
  it("is secure on Vercel production and preview", () => {
    process.env.VERCEL_ENV = "production";
    expect(shouldUseSecureCookies()).toBe(true);
    process.env.VERCEL_ENV = "preview";
    expect(shouldUseSecureCookies()).toBe(true);
  });

  it("is secure when APP_BASE_URL is https", () => {
    delete process.env.VERCEL_ENV;
    process.env.APP_BASE_URL = "https://sarbase.example.org";
    expect(shouldUseSecureCookies()).toBe(true);
  });

  it("is insecure only for plain-http local development", () => {
    delete process.env.VERCEL_ENV;
    process.env.APP_BASE_URL = "http://localhost:3000";
    expect(shouldUseSecureCookies()).toBe(false);
    delete process.env.APP_BASE_URL;
    expect(shouldUseSecureCookies()).toBe(false);
  });
});

describe("SESSION_COOKIE_NAME", () => {
  it("is an app-scoped, non-generic name", () => {
    expect(SESSION_COOKIE_NAME).toBe("sarbase_session");
  });
});
