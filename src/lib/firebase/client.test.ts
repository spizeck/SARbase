import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAppsMock, getAppMock, initializeAppMock, getAuthMock } = vi.hoisted(
  () => ({
    getAppsMock: vi.fn(),
    getAppMock: vi.fn(),
    initializeAppMock: vi.fn(),
    getAuthMock: vi.fn(),
  }),
);

vi.mock("firebase/app", () => ({
  getApps: getAppsMock,
  getApp: getAppMock,
  initializeApp: initializeAppMock,
}));

vi.mock("firebase/auth", () => ({
  getAuth: getAuthMock,
}));

const FIREBASE_CLIENT_ENV_KEYS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
] as const;

const FIREBASE_CLIENT_ENV = {
  NEXT_PUBLIC_FIREBASE_API_KEY: "test-api-key",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "test.firebaseapp.com",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "test-project",
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:0:web:test",
} as const;

function stubFirebaseClientEnv() {
  for (const key of FIREBASE_CLIENT_ENV_KEYS) {
    vi.stubEnv(key, FIREBASE_CLIENT_ENV[key]);
  }
}

function clearFirebaseClientEnv() {
  for (const key of FIREBASE_CLIENT_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
}

beforeEach(() => {
  // The client module caches its app/auth at module scope; reset the
  // registry so each test re-imports a fresh, uninitialized module.
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("getFirebaseClientAuth", () => {
  it("returns null on the server — the client SDK never runs there", async () => {
    const { getFirebaseClientAuth } = await import("./client");

    expect(getFirebaseClientAuth()).toBeNull();
    expect(initializeAppMock).not.toHaveBeenCalled();
  });

  it("returns null in the browser when public env values are absent", async () => {
    vi.stubGlobal("window", {});
    clearFirebaseClientEnv();
    const { getFirebaseClientAuth } = await import("./client");

    expect(getFirebaseClientAuth()).toBeNull();
    expect(initializeAppMock).not.toHaveBeenCalled();
  });

  it("initializes Firebase Auth from the public env values", async () => {
    vi.stubGlobal("window", {});
    stubFirebaseClientEnv();
    const app = { name: "app" };
    const auth = { name: "auth" };
    getAppsMock.mockReturnValue([]);
    initializeAppMock.mockReturnValue(app);
    getAuthMock.mockReturnValue(auth);
    const { getFirebaseClientAuth } = await import("./client");

    expect(getFirebaseClientAuth()).toBe(auth);
    expect(initializeAppMock).toHaveBeenCalledWith({
      apiKey: FIREBASE_CLIENT_ENV.NEXT_PUBLIC_FIREBASE_API_KEY,
      authDomain: FIREBASE_CLIENT_ENV.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      projectId: FIREBASE_CLIENT_ENV.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      appId: FIREBASE_CLIENT_ENV.NEXT_PUBLIC_FIREBASE_APP_ID,
    });
    expect(getAuthMock).toHaveBeenCalledWith(app);
  });

  it("reuses an existing Firebase app instead of re-initializing", async () => {
    vi.stubGlobal("window", {});
    stubFirebaseClientEnv();
    const app = { name: "existing" };
    const auth = { name: "auth" };
    getAppsMock.mockReturnValue([app]);
    getAppMock.mockReturnValue(app);
    getAuthMock.mockReturnValue(auth);
    const { getFirebaseClientAuth } = await import("./client");

    expect(getFirebaseClientAuth()).toBe(auth);
    expect(initializeAppMock).not.toHaveBeenCalled();
  });

  it("caches the initialized auth across calls", async () => {
    vi.stubGlobal("window", {});
    stubFirebaseClientEnv();
    const app = { name: "app" };
    const auth = { name: "auth" };
    getAppsMock.mockReturnValue([]);
    initializeAppMock.mockReturnValue(app);
    getAuthMock.mockReturnValue(auth);
    const { getFirebaseClientAuth } = await import("./client");

    expect(getFirebaseClientAuth()).toBe(auth);
    expect(getFirebaseClientAuth()).toBe(auth);
    expect(initializeAppMock).toHaveBeenCalledTimes(1);
  });
});
