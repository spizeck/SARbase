# Appearance (light / dark / system)

Issue #72. SARbase offers three appearance choices: **System** (the
default — follows the device/OS `prefers-color-scheme`), **Light**, and
**Dark**. The preference persists in `localStorage` under
`sarbase-theme`; nothing is stored server-side and no external theme
service is involved.

## How it is applied

- A synchronous inline script in the root layout `<head>`
  (`THEME_BOOTSTRAP_JS` in `src/lib/theme.ts`) resolves the stored
  preference — plus the live `prefers-color-scheme` match when the
  choice is System — and toggles `class="dark"` on `<html>` **before
  first paint**, so a stored choice never flashes the wrong theme. The
  `<html>` element carries `suppressHydrationWarning` for the same
  reason.
- `ThemeSync` (mounted once in the root layout) re-applies the resolved
  theme whenever the preference or the OS scheme changes — System mode
  tracks OS changes without a reload — and re-asserts the class after
  React's development Strict-Mode remount.
- The quick control is the **Appearance menu in the workspace header**
  (`ThemeMenu`); the discoverable setting is the **Appearance radio
  group on `/account`** (`AppearanceRadioGroup`). Both write through
  the same store.

## How dark mode styles

The interface is authored against Tailwind's default (light) palette.
Rather than annotate every element with `dark:` variants, the `.dark`
class in `globals.css` **rebinds the palette CSS variables that
Tailwind utilities reference at use time** — each shade maps to its
lightness mirror (`neutral-900` becomes the former `neutral-100`,
`red-700` becomes light red, and so on). Every authored
foreground/background pair keeps its contrast relationship inverted, so
one block themes every existing and future surface consistently.

Two deliberate exceptions:

- `--color-scrim` is a fixed translucent-dark overlay color used for
  drawer/modal backdrops — scrims must stay dark in both themes.
- `global-error.tsx` owns its own `<html>` and cannot load
  `globals.css`; it follows `prefers-color-scheme` with a small media
  query instead (the stored preference is unreachable there).

`color-scheme: dark` is also set under `.dark` so native widgets —
scrollbars, form controls — render dark too.

## Testing

- `src/lib/theme.test.ts` — preference parsing, resolution truth table,
  bootstrap-script contract.
- `smoke-tests/theme.spec.ts` — anonymous end-to-end coverage: system
  tracking (live `prefers-color-scheme` changes without reload),
  explicit-choice override, persistence across reloads, absence of
  hydration errors, and an axe WCAG pass in dark mode.
- `smoke-tests/authenticated.spec.ts` — header menu and account radio
  assertions in the hosted suite.
