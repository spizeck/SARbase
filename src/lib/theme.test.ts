import { readFileSync } from "node:fs";
import { join } from "node:path";

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

/**
 * Native form-control theming (follow-up to issue #72). The expanded
 * option list of a <select> is painted from each option's computed
 * colors once the element carries an author-set background — which
 * Tailwind's preflight supplies (`background-color: transparent`).
 * Without explicit palette-bound colors on option/optgroup, the popup
 * renders light-on-white in dark mode. This block pins the shared rule
 * to the theme variables so a hardcoded color cannot silently regress
 * it.
 */
describe("native form-control theming (globals.css)", () => {
  const css = readFileSync(join(__dirname, "../app/globals.css"), "utf8");

  const ruleFor = (selector: string) => {
    const match = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
    return match?.[1] ?? null;
  };

  it("binds select, option, and optgroup surfaces to the palette", () => {
    const rule = ruleFor("select,\\s*\\n?\\s*option,\\s*\\n?\\s*optgroup");
    expect(rule).not.toBeNull();
    expect(rule).toContain("background-color: var(--color-white)");
    expect(rule).toContain("color: var(--color-neutral-900)");
  });

  it("keeps disabled options distinguishable with a palette color", () => {
    const rule = ruleFor("option:disabled,\\s*\\n?\\s*optgroup:disabled");
    expect(rule).toContain("var(--color-neutral-");
  });

  it("gives the checked option a themed highlight", () => {
    const rule = ruleFor("option:checked");
    expect(rule).toContain("background-color: var(--color-neutral-");
  });

  it("themes checkbox and radio accents", () => {
    const rule = ruleFor(
      'input\\[type="checkbox"\\],\\s*\\n?\\s*input\\[type="radio"\\]',
    );
    expect(rule).toContain("accent-color: var(--color-neutral-900)");
  });

  it("uses no hardcoded colors in the form-control rules", () => {
    for (const selector of [
      "select,\\s*\\n?\\s*option,\\s*\\n?\\s*optgroup",
      "option:disabled,\\s*\\n?\\s*optgroup:disabled",
      "option:checked",
      'input\\[type="checkbox"\\],\\s*\\n?\\s*input\\[type="radio"\\]',
    ]) {
      const rule = ruleFor(selector);
      expect(rule).not.toBeNull();
      expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    }
  });
});
