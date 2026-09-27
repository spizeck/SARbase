import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdminDisabledError,
  adminSurfaceEnabled,
  assertAdminEnabled,
} from "./admin-gate";

/**
 * The temporary admin gate is enabled anywhere NODE_ENV isn't
 * "production" — `next dev` and the test runner — and disabled under
 * every production build, which is what all deployed environments run.
 * Issue #6 replaces this module with real authz.
 */
describe("admin-gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("enables the surface outside production (test env)", () => {
    expect(adminSurfaceEnabled()).toBe(true);
    expect(() => assertAdminEnabled()).not.toThrow();
  });

  it("enables the surface under next dev", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(adminSurfaceEnabled()).toBe(true);
    expect(() => assertAdminEnabled()).not.toThrow();
  });

  it("disables the surface under a production build", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(adminSurfaceEnabled()).toBe(false);
    expect(() => assertAdminEnabled()).toThrow(AdminDisabledError);
  });
});
