import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCtxMock, recordMock, redirectMock } = vi.hoisted(() => ({
  getCtxMock: vi.fn(),
  recordMock: vi.fn(),
  redirectMock: vi.fn(),
}));

vi.mock("@/lib/auth/authorize", () => ({
  getAuthContextOrThrow: getCtxMock,
}));

vi.mock("@/lib/auth/context", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/context")>();
  return { ...original, getAuthContext: vi.fn() };
});

vi.mock("@/lib/legal/acceptance", () => ({
  recordTermsAcceptance: recordMock,
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

import { AuthenticationError } from "@/lib/auth/context";
import { acceptTermsAction } from "./actions";

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("acceptTermsAction", () => {
  it("requires an authenticated identity", async () => {
    getCtxMock.mockRejectedValue(new AuthenticationError("unauthenticated"));
    await expect(
      acceptTermsAction({}, form({ accept_terms: "on" })),
    ).resolves.toEqual({ error: expect.stringMatching(/sign in/i) });
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("refuses a submission without the explicit checkbox", async () => {
    getCtxMock.mockResolvedValue({ identity: { id: "ident-1" } });
    // No checkbox value at all, and a forged non-"on" value — both reject.
    await expect(acceptTermsAction({}, form({}))).resolves.toEqual({
      error: expect.stringMatching(/check the box/i),
    });
    await expect(
      acceptTermsAction({}, form({ accept_terms: "yes" })),
    ).resolves.toEqual({ error: expect.stringMatching(/check the box/i) });
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("records acceptance and redirects to /org by default", async () => {
    getCtxMock.mockResolvedValue({ identity: { id: "ident-1" } });
    await acceptTermsAction({}, form({ accept_terms: "on" }));
    expect(recordMock).toHaveBeenCalledWith("ident-1");
    expect(redirectMock).toHaveBeenCalledWith("/org");
  });

  it("honours a safe internal next path and rejects external ones", async () => {
    getCtxMock.mockResolvedValue({ identity: { id: "ident-1" } });

    await acceptTermsAction({}, form({ accept_terms: "on", next: "/org/abc" }));
    expect(redirectMock).toHaveBeenLastCalledWith("/org/abc");

    // "next" failing the safe-path pattern is treated as invalid input.
    const result = await acceptTermsAction(
      {},
      form({ accept_terms: "on", next: "https://evil.example" }),
    );
    expect(result.error).toBeTruthy();

    // Protocol-relative URLs are external — must not redirect.
    const protoRel = await acceptTermsAction(
      {},
      form({ accept_terms: "on", next: "//evil.example" }),
    );
    expect(protoRel.error).toBeTruthy();

    expect(recordMock).toHaveBeenCalledTimes(1); // only the valid call above
  });
});
