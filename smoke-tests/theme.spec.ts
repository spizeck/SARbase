import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

/**
 * Appearance theming (issue #72). The preference is a client-side
 * concern — a `sarbase-theme` localStorage value resolved by the
 * pre-paint bootstrap script — so every behavior is verifiable
 * anonymously on /login: no authenticated session needed.
 *
 * Playwright's emulateMedia drives prefers-color-scheme changes that
 * real matchMedia listeners observe, so "system tracks the OS without
 * reload" is tested end to end.
 */

const html = (page: import("@playwright/test").Page) => page.locator("html");

test.describe("appearance theme", () => {
  test("system preference follows the emulated OS scheme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/login");
    await expect(html(page)).toHaveClass(/dark/);
    // color-scheme must follow so native widgets (scrollbars,
    // form controls) render dark too.
    await expect(html(page)).toHaveCSS("color-scheme", "dark");
  });

  test("system stays light under a light OS scheme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/login");
    await expect(html(page)).not.toHaveClass(/\bdark\b/);
  });

  test("an explicit dark choice wins over a light OS scheme", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => {
      window.localStorage.setItem("sarbase-theme", "dark");
    });
    await page.goto("/login");
    await expect(html(page)).toHaveClass(/dark/);
  });

  test("an explicit light choice wins over a dark OS scheme", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => {
      window.localStorage.setItem("sarbase-theme", "light");
    });
    await page.goto("/login");
    await expect(html(page)).not.toHaveClass(/\bdark\b/);
  });

  test("the explicit choice persists across reloads", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/login");
    await page.evaluate(() => {
      window.localStorage.setItem("sarbase-theme", "dark");
      // The in-page listener applies immediately — no reload needed.
      window.dispatchEvent(new Event("sarbase-theme-change"));
    });
    await expect(html(page)).toHaveClass(/dark/);

    await page.reload();
    await expect(html(page)).toHaveClass(/dark/);
  });

  test("system mode tracks a live OS change without reload", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/login");
    await expect(html(page)).not.toHaveClass(/\bdark\b/);

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html(page)).toHaveClass(/dark/);
    await expect(html(page)).toHaveCSS("color-scheme", "dark");
  });

  test("an explicit choice does NOT track a live OS change", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/login");
    await page.evaluate(() => {
      window.localStorage.setItem("sarbase-theme", "light");
      window.dispatchEvent(new Event("sarbase-theme-change"));
    });

    await page.emulateMedia({ colorScheme: "dark" });
    // Give the media listener a beat to fire; the class must stay off.
    await page.waitForTimeout(100);
    await expect(html(page)).not.toHaveClass(/\bdark\b/);
  });

  test("applying dark produces no hydration errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.addInitScript(() => {
      window.localStorage.setItem("sarbase-theme", "dark");
    });
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    expect(
      errors.filter((e) => /hydrat/i.test(e)),
      "hydration errors",
    ).toEqual([]);
  });

  test("dark theme keeps the page free of detectable WCAG violations", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/login");
    await expect(html(page)).toHaveClass(/dark/);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  /**
   * Native form-control theming. The expanded <select> popup cannot be
   * captured by Playwright (it is painted outside the page surface),
   * but Chromium paints its rows from each <option>'s computed colors —
   * so the computed style IS the contract: dark text on a light row in
   * light mode, light text on a dark row in dark mode, and a
   * distinguishable-but-readable disabled color in both.
   */
  async function probeControlColors(page: import("@playwright/test").Page) {
    return page.evaluate(() => {
      // Tailwind's palette is declared in oklch — computed colors may
      // serialize as lab()/oklch(). Paint a pixel and read it back so
      // assertions compare resolved srgb channels in any notation.
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d")!;
      const norm = (color: string) => {
        ctx.fillStyle = color;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return `rgb(${r}, ${g}, ${b})`;
      };
      const select = document.createElement("select");
      const selected = document.createElement("option");
      const enabled = document.createElement("option");
      const disabled = document.createElement("option");
      disabled.disabled = true;
      select.append(selected, enabled, disabled);
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      document.body.append(select, checkbox);
      const read = (el: Element) => {
        const s = getComputedStyle(el);
        return {
          color: norm(s.color),
          backgroundColor: norm(s.backgroundColor),
          colorScheme: s.colorScheme,
          accentColor: norm(s.accentColor),
        };
      };
      const out = {
        select: read(select),
        option: read(enabled),
        selected: read(selected),
        disabled: read(disabled),
        checkbox: read(checkbox),
      };
      select.remove();
      checkbox.remove();
      return out;
    });
  }

  /** WCAG relative-luminance contrast ratio between two rgb()/#rrggbb colors. */
  function contrast(a: string, b: string): number {
    const lum = (color: string) => {
      const channel = color.startsWith("#")
        ? [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)].map(
            (h) => parseInt(h, 16) / 255,
          )
        : (color.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).map(
            (v) => Number(v) / 255,
          );
      const [r = 0, g = 0, bl = 0] = channel;
      const lin = (c: number) =>
        c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bl);
    };
    const la = lum(a);
    const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  test("native select/options resolve dark-theme colors", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("sarbase-theme", "dark");
    });
    await page.goto("/login");
    await expect(html(page)).toHaveClass(/dark/);

    const probe = await probeControlColors(page);
    expect(probe.select.colorScheme).toBe("dark");
    // Option rows: light text on a dark surface.
    expect(probe.option.color).toBe("rgb(245, 245, 245)");
    expect(probe.option.backgroundColor).toBe("rgb(10, 10, 10)");
    expect(
      contrast(probe.option.color, probe.option.backgroundColor),
    ).toBeGreaterThanOrEqual(4.5);
    // The checked row is highlighted by the theme, not the UA blue.
    expect(probe.selected.backgroundColor).toBe("rgb(38, 38, 38)");
    expect(
      contrast(probe.selected.color, probe.selected.backgroundColor),
    ).toBeGreaterThanOrEqual(4.5);
    // Disabled stays distinguishable yet readable (>= 3:1).
    expect(probe.disabled.color).not.toBe(probe.option.color);
    expect(
      contrast(probe.disabled.color, probe.option.backgroundColor),
    ).toBeGreaterThanOrEqual(3);
    // The closed select matches the themed surface.
    expect(probe.select.backgroundColor).toBe("rgb(10, 10, 10)");
    expect(
      contrast(probe.select.color, probe.select.backgroundColor),
    ).toBeGreaterThanOrEqual(4.5);
    // Checkbox/radio accent is palette-bound, not the UA blue.
    expect(probe.checkbox.accentColor).toBe("rgb(245, 245, 245)");
  });

  test("native select/options resolve light-theme colors", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("sarbase-theme", "light");
    });
    await page.goto("/login");
    await expect(html(page)).not.toHaveClass(/\bdark\b/);

    const probe = await probeControlColors(page);
    expect(probe.select.colorScheme).toBe("light");
    expect(probe.option.color).toBe("rgb(23, 23, 23)");
    expect(probe.option.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(probe.selected.backgroundColor).toBe("rgb(229, 229, 229)");
    expect(
      contrast(probe.option.color, probe.option.backgroundColor),
    ).toBeGreaterThanOrEqual(4.5);
    expect(probe.disabled.color).not.toBe(probe.option.color);
    expect(
      contrast(probe.disabled.color, probe.option.backgroundColor),
    ).toBeGreaterThanOrEqual(3);
    expect(probe.checkbox.accentColor).toBe("rgb(23, 23, 23)");
  });

  test("control colors follow a theme switch without reload", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("sarbase-theme", "dark");
    });
    await page.goto("/login");
    const before = await probeControlColors(page);
    expect(before.option.backgroundColor).toBe("rgb(10, 10, 10)");

    await page.evaluate(() => {
      window.localStorage.setItem("sarbase-theme", "light");
      window.dispatchEvent(new Event("sarbase-theme-change"));
    });
    const after = await probeControlColors(page);
    expect(after.option.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(after.option.color).toBe("rgb(23, 23, 23)");
    expect(after.select.colorScheme).toBe("light");
  });
});
