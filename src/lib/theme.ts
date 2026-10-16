/**
 * Appearance preference (issue #72): System / Light / Dark.
 *
 * The preference persists in localStorage and is applied by toggling a
 * `.dark` class on <html>; globals.css remaps the palette variables
 * under that class, so one class themes every surface. This module is
 * dependency-free and safe to import from server components — every
 * window touch is guarded.
 *
 * Three places cooperate:
 * - THEME_BOOTSTRAP_JS runs synchronously in <head> before first paint
 *   so a stored/explicit choice never flashes the wrong theme.
 * - ThemeSync (src/components/theme.tsx) keeps the class applied across
 *   client navigations, dev Strict Mode remounts, and live
 *   prefers-color-scheme changes when the preference is "system".
 * - Theme controls (header menu, account radios) write the preference.
 */

export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "sarbase-theme";
export const THEME_CHANGE_EVENT = "sarbase-theme-change";
export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export const THEME_OPTIONS: {
  value: ThemePreference;
  label: string;
  description: string;
}[] = [
  {
    value: "system",
    label: "System",
    description: "Follow the device light/dark setting",
  },
  { value: "light", label: "Light", description: "Always light" },
  { value: "dark", label: "Dark", description: "Always dark" },
];

/** Anything unrecognized — missing, mistyped, or stale — means system. */
export function parseThemePreference(raw: unknown): ThemePreference {
  return raw === "light" || raw === "dark" ? raw : "system";
}

/** The single resolver: explicit choice wins, otherwise follow the OS. */
export function resolveIsDark(
  preference: ThemePreference,
  systemDark: boolean,
): boolean {
  return preference === "dark" || (preference === "system" && systemDark);
}

export function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/** Persist and broadcast — subscribers re-apply through ThemeSync. */
export function writeThemePreference(preference: ThemePreference): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage can be unavailable (private mode, policy); the class
    // still applies for this session via the change event below.
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia(DARK_SCHEME_QUERY).matches;
  } catch {
    return false;
  }
}

/** Flip the document class + native widget scheme in one place. */
export function applyTheme(isDark: boolean): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
}

/**
 * The pre-paint bootstrap inlined into <head> by the root layout. It
 * must stay a static string (nothing imported is available that early)
 * and must mirror readThemePreference + resolveIsDark exactly — keep
 * them in sync when editing.
 */
export const THEME_BOOTSTRAP_JS = `(function(){try{var p=null;try{p=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})}catch(e){}var d=p==="dark"||((p!=="light"&&p!=="dark")&&window.matchMedia(${JSON.stringify(DARK_SCHEME_QUERY)}).matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light"}catch(e){}})()`;
