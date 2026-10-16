"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  applyTheme,
  DARK_SCHEME_QUERY,
  readThemePreference,
  resolveIsDark,
  systemPrefersDark,
  THEME_CHANGE_EVENT,
  THEME_OPTIONS,
  writeThemePreference,
  type ThemePreference,
} from "@/lib/theme";

/**
 * Current preference, read reactively (storage event across tabs,
 * change event within this tab). Server snapshot is always "system" —
 * the bootstrap script already applied the real value to the DOM, so
 * hydration stays consistent.
 */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(
    useCallback((notify) => {
      window.addEventListener(THEME_CHANGE_EVENT, notify);
      window.addEventListener("storage", notify);
      return () => {
        window.removeEventListener(THEME_CHANGE_EVENT, notify);
        window.removeEventListener("storage", notify);
      };
    }, []),
    () => readThemePreference(),
    () => "system" as ThemePreference,
  );
}

/** Whether the OS currently prefers dark — live-updating. */
function useSystemDark(): boolean {
  return useSyncExternalStore(
    useCallback((notify) => {
      const mq = window.matchMedia(DARK_SCHEME_QUERY);
      mq.addEventListener("change", notify);
      return () => mq.removeEventListener("change", notify);
    }, []),
    () => systemPrefersDark(),
    () => false,
  );
}

function selectTheme(preference: ThemePreference) {
  writeThemePreference(preference);
  applyTheme(resolveIsDark(preference, systemPrefersDark()));
}

/**
 * Mounted once in the root layout. Re-applies the resolved theme when
 * the preference or the OS scheme changes — including system tracking
 * without a reload — and re-asserts it after React's dev-mode remount
 * clears script-set attributes.
 */
export function ThemeSync() {
  const preference = useThemePreference();
  const systemDark = useSystemDark();
  useLayoutEffect(() => {
    applyTheme(resolveIsDark(preference, systemDark));
  }, [preference, systemDark]);
  return null;
}

/**
 * Bootstrap <script> for the root layout <head>. Per the Next.js
 * pre-paint guide it renders as javascript on the server (executes
 * while parsing, before first paint) and as inert text on the client
 * so re-renders do not re-run it.
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const optionLabel: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-4 w-4"
    >
      <path d="M4 10.5l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The quick header control — a menu-button listing the three
 * appearance choices, following the same keyboard/dismissal pattern as
 * the organization switcher in the shell.
 */
export function ThemeMenu() {
  const preference = useThemePreference();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Appearance: ${optionLabel[preference]}`}
        className="rounded-md px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
      >
        <span aria-hidden="true">{optionLabel[preference]}</span>
        <span className="sr-only">theme</span>
      </button>
      {open && (
        <ul
          role="menu"
          aria-label="Appearance"
          className="absolute right-0 top-full z-40 mt-1 w-44 rounded-md border border-neutral-200 bg-white py-1 shadow-lg"
        >
          {THEME_OPTIONS.map((option) => {
            const selected = option.value === preference;
            return (
              <li key={option.value} role="none">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    selectTheme(option.value);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-50"
                >
                  <span>{option.label}</span>
                  {selected && <CheckIcon />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The discoverable setting on /account — a plain radio group so it
 * works with keyboard and screen readers without menu semantics.
 */
export function AppearanceRadioGroup() {
  const preference = useThemePreference();
  return (
    <fieldset className="mt-2">
      <legend className="sr-only">Appearance</legend>
      <div className="space-y-2">
        {THEME_OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex items-baseline gap-2 text-sm text-neutral-700"
          >
            <input
              type="radio"
              name="appearance"
              value={option.value}
              checked={preference === option.value}
              onChange={() => selectTheme(option.value)}
              className="translate-y-[-1px]"
            />
            <span>
              <span className="font-medium text-neutral-900">
                {option.label}
              </span>
              <span className="ml-2 text-neutral-500">
                {option.description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
