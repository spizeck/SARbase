import { describe, expect, it } from "vitest";

import {
  applyTheme,
  parseThemePreference,
  readThemePreference,
  resolveIsDark,
  systemPrefersDark,
  THEME_BOOTSTRAP_JS,
  THEME_STORAGE_KEY,
  writeThemePreference,
} from "./theme";

describe("parseThemePreference", () => {
  it("accepts the two explicit choices", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
  });

  it("falls back to system for anything else", () => {
    for (const raw of [null, undefined, "system", "SYSTEM", "", 0, {}]) {
      expect(parseThemePreference(raw)).toBe("system");
    }
  });
});

describe("resolveIsDark", () => {
  it("honors explicit choices regardless of the OS scheme", () => {
    expect(resolveIsDark("dark", false)).toBe(true);
    expect(resolveIsDark("dark", true)).toBe(true);
    expect(resolveIsDark("light", true)).toBe(false);
    expect(resolveIsDark("light", false)).toBe(false);
  });

  it("follows the OS scheme only under system", () => {
    expect(resolveIsDark("system", true)).toBe(true);
    expect(resolveIsDark("system", false)).toBe(false);
  });
});

describe("DOM-free environment safety", () => {
  // The unit suite runs in node — every browser touch must degrade
  // quietly so server components can import the module.
  it("reads and writes resolve to the system default", () => {
    expect(readThemePreference()).toBe("system");
    expect(systemPrefersDark()).toBe(false);
    expect(() => writeThemePreference("dark")).not.toThrow();
    expect(() => applyTheme(true)).not.toThrow();
  });
});

describe("THEME_BOOTSTRAP_JS", () => {
  // The inline script must mirror readThemePreference + resolveIsDark —
  // these assertions pin the contract, not the minified shape.
  it("reads the same storage key", () => {
    expect(THEME_BOOTSTRAP_JS).toContain(THEME_STORAGE_KEY);
  });

  it("resolves dark explicitly or via prefers-color-scheme", () => {
    expect(THEME_BOOTSTRAP_JS).toContain('p==="dark"');
    expect(THEME_BOOTSTRAP_JS).toContain("prefers-color-scheme: dark");
    expect(THEME_BOOTSTRAP_JS).toContain('classList.toggle("dark",d)');
  });

  it("sets the native widget scheme", () => {
    expect(THEME_BOOTSTRAP_JS).toContain("colorScheme");
  });

  it("fails closed inside try/catch", () => {
    expect(THEME_BOOTSTRAP_JS.startsWith("(function(){try{")).toBe(true);
  });
});
