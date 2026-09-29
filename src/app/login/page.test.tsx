import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  redirectMock,
  getAuthContextMock,
  tryParseFirebaseClientEnvironmentMock,
} = vi.hoisted(() => ({
  redirectMock: vi.fn(),
  getAuthContextMock: vi.fn(),
  tryParseFirebaseClientEnvironmentMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth/context", () => ({
  getAuthContext: getAuthContextMock,
}));

// Wrap the real parser in a spy: the server page may call it, but the
// client component must never read environment configuration itself —
// process.env is not a stable SSR/hydration boundary.
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  tryParseFirebaseClientEnvironmentMock.mockImplementation(
    actual.tryParseFirebaseClientEnvironment,
  );
  return {
    ...actual,
    tryParseFirebaseClientEnvironment: tryParseFirebaseClientEnvironmentMock,
  };
});

// Server actions pull in firebase-admin/prisma — not exercised here.
vi.mock("./actions", () => ({
  createSessionAction: vi.fn(),
  signOutAction: vi.fn(),
}));

vi.mock("@/lib/firebase/client", () => ({
  getFirebaseClientAuth: () => null,
}));

vi.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: vi.fn(),
}));

import LoginPage from "./page";
import { LoginForm } from "./login-form";

const FIREBASE_CLIENT_ENV_KEYS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
] as const;

function stubFirebaseClientEnv() {
  for (const key of FIREBASE_CLIENT_ENV_KEYS) {
    vi.stubEnv(key, "test-value");
  }
}

function clearFirebaseClientEnv() {
  for (const key of FIREBASE_CLIENT_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContextMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("LoginPage", () => {
  it("renders the sign-in form when Firebase client auth is configured", async () => {
    stubFirebaseClientEnv();

    const html = renderToStaticMarkup(await LoginPage());

    expect(html).toContain("<form");
    expect(html).toContain('type="email"');
    expect(html).toContain('type="password"');
    expect(html).toContain("Sign in");
    expect(html).not.toContain("Authentication is not configured");
  });

  it("renders the unconfigured state when Firebase client auth is absent", async () => {
    clearFirebaseClientEnv();

    const html = renderToStaticMarkup(await LoginPage());

    expect(html).toContain(
      "Authentication is not configured for this deployment",
    );
    expect(html).not.toContain("<form");
  });

  it("redirects an authenticated user to /account", async () => {
    getAuthContextMock.mockResolvedValue({
      identity: {},
      members: [],
      access: [],
    });

    await LoginPage();

    expect(redirectMock).toHaveBeenCalledWith("/account");
  });
});

describe("LoginForm", () => {
  it("does not read environment configuration during render", () => {
    tryParseFirebaseClientEnvironmentMock.mockClear();

    renderToStaticMarkup(<LoginForm configured={true} />);
    renderToStaticMarkup(<LoginForm configured={false} />);

    expect(tryParseFirebaseClientEnvironmentMock).not.toHaveBeenCalled();
  });

  it("selects its initial UI from the configured prop", () => {
    const configured = renderToStaticMarkup(<LoginForm configured={true} />);
    expect(configured).toContain("<form");

    const unconfigured = renderToStaticMarkup(<LoginForm configured={false} />);
    expect(unconfigured).toContain(
      "Authentication is not configured for this deployment",
    );
  });
});
