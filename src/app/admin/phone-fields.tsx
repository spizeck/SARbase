"use client";

import { useMemo, useRef, useState } from "react";

import {
  DEFAULT_PHONE_REGION,
  splitPhoneForDisplay,
  type PhoneRegionOption,
} from "@/lib/contact";

/**
 * Shared phone entry — one labeled field split into a compact region
 * selector (flag + calling code, e.g. "🇧🇶 +599") and a national-number
 * input ("416 6039"). The region selector is a searchable combobox that
 * lists full territory names; the selected state never truncates a name
 * because it only shows flag + code.
 *
 * Values:
 *   - `defaultPhone` is the stored E.164 value ("+31612345678"). It's
 *     parsed into { region, national } so editing an existing record
 *     selects the right region — BQ (+599) is only the default for
 *     genuinely empty fields. Unparseable legacy values land verbatim in
 *     the input so they're preserved, not silently changed.
 *   - Typing or pasting a number that starts with "+" re-parses it: the
 *     selector updates to the parsed region and the input keeps the
 *     national digits. Shared calling codes resolve by the actual digits
 *     (a "+1 246 …" number selects Barbados, not an arbitrary +1 region).
 *
 * Submitted fields are `phone` (national digits, or the raw "+…" text
 * when the input can't be decomposed) and `phoneRegion` (hidden ISO
 * code) — the server schema and domain layer re-validate and normalize
 * to E.164, so this component is presentation only.
 *
 * Keyboard: the selector button opens on Enter/Space/ArrowDown; in the
 * dropdown ArrowUp/ArrowDown move the highlight, Enter selects, Escape
 * closes and restores focus to the button.
 */

const labelClass = "block text-sm font-medium text-neutral-800";
const errorClass = "mt-1 text-sm text-red-700";

const MAX_RENDERED = 80;

/** ISO alpha-2 → regional-indicator flag glyph (renders as letters on platforms without flag emoji). */
function flagGlyph(region: string): string {
  return String.fromCodePoint(
    ...[...region].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

export function PhoneFields({
  idPrefix,
  regions,
  defaultPhone,
  errors,
  required = false,
  fieldName = "phone",
  regionFieldName = "phoneRegion",
}: {
  idPrefix: string;
  regions: PhoneRegionOption[];
  /** Stored phone value (normally E.164); region + national are derived from it. */
  defaultPhone?: string | null;
  errors?: string[];
  required?: boolean;
  /**
   * Submitted field names — default `phone`/`phoneRegion`; the
   * emergency-contact pair uses `emergencyContactPhone` /
   * `emergencyContactPhoneRegion` (issue #71).
   */
  fieldName?: string;
  regionFieldName?: string;
}) {
  const byRegion = useMemo(
    () => new Map(regions.map((r) => [r.region, r])),
    [regions],
  );

  const [field, setField] = useState(() => {
    const parts = defaultPhone ? splitPhoneForDisplay(defaultPhone) : null;
    if (parts && byRegion.has(parts.region)) return parts;
    return {
      region: DEFAULT_PHONE_REGION as string,
      national: defaultPhone ?? "",
    };
  });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const nationalRef = useRef<HTMLInputElement>(null);

  const selected = byRegion.get(field.region);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return regions.slice(0, MAX_RENDERED);
    const digits = q.replace(/\D/g, "");
    return regions
      .filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (digits.length > 0 && r.callingCode.startsWith(digits)),
      )
      .slice(0, MAX_RENDERED);
  }, [regions, query]);

  function chooseRegion(option: PhoneRegionOption) {
    setField((f) => ({ ...f, region: option.region }));
    setOpen(false);
    setQuery("");
    nationalRef.current?.focus();
  }

  function onNationalChange(value: string) {
    const international = value.trimStart().startsWith("+")
      ? splitPhoneForDisplay(value)
      : null;
    if (international && byRegion.has(international.region)) {
      setField(international);
      return;
    }
    setField((f) => ({ ...f, national: value }));
  }

  function onWrapBlur(e: React.FocusEvent) {
    if (!wrapRef.current?.contains(e.relatedTarget as Node)) {
      setOpen(false);
      setQuery("");
    }
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next =
        e.key === "ArrowDown"
          ? Math.min(highlight + 1, matches.length - 1)
          : Math.max(highlight - 1, 0);
      setHighlight(next);
      listRef.current
        ?.querySelector(`[data-index="${next}"]`)
        ?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const option = matches[highlight];
      if (option) chooseRegion(option);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
      buttonRef.current?.focus();
    }
  }

  return (
    <div>
      <label htmlFor={`${idPrefix}-phone`} className={labelClass}>
        Phone{" "}
        {!required && (
          <span className="font-normal text-neutral-500">(optional)</span>
        )}
      </label>
      <div ref={wrapRef} onBlur={onWrapBlur} className="mt-1 flex">
        <div className="relative shrink-0">
          <button
            ref={buttonRef}
            type="button"
            id={`${idPrefix}-phone-region`}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={`${idPrefix}-phone-region-listbox`}
            aria-label={
              selected
                ? `Phone country or region: ${selected.name} +${selected.callingCode}`
                : "Phone country or region"
            }
            onClick={() => {
              setOpen(true);
              setQuery("");
              setHighlight(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setOpen(true);
                setQuery("");
                setHighlight(0);
              }
            }}
            className="flex h-full items-center gap-1.5 rounded-l-md border border-neutral-300 bg-white px-2.5 text-sm text-neutral-800 hover:bg-neutral-50"
          >
            <span aria-hidden="true">{flagGlyph(field.region)}</span>
            <span>+{selected?.callingCode ?? "?"}</span>
            <svg
              aria-hidden="true"
              viewBox="0 0 8 8"
              className="h-2 w-2 fill-neutral-500"
            >
              <path d="M0 2l4 4 4-4H0z" />
            </svg>
          </button>
          {open && (
            <div className="absolute left-0 z-10 mt-1 w-72 max-w-[85vw] rounded-md border border-neutral-300 bg-white shadow-lg">
              <div className="border-b border-neutral-200 p-2">
                <input
                  type="text"
                  autoFocus
                  role="combobox"
                  aria-expanded="true"
                  aria-controls={`${idPrefix}-phone-region-listbox`}
                  aria-activedescendant={
                    matches[highlight]
                      ? `${idPrefix}-phone-region-option-${highlight}`
                      : undefined
                  }
                  aria-autocomplete="list"
                  aria-label="Search countries or regions"
                  placeholder="Search countries or codes…"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setHighlight(0);
                  }}
                  onKeyDown={onSearchKeyDown}
                  className="block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
                />
              </div>
              <ul
                id={`${idPrefix}-phone-region-listbox`}
                role="listbox"
                aria-label="Countries and regions"
                ref={listRef}
                className="max-h-60 overflow-auto py-1 text-sm"
              >
                {matches.length === 0 ? (
                  <li className="px-3 py-2 text-neutral-500">
                    No country matches — keep typing, or pick one from the list.
                  </li>
                ) : (
                  matches.map((option, index) => (
                    <li
                      key={option.region}
                      id={`${idPrefix}-phone-region-option-${index}`}
                      data-index={index}
                      role="option"
                      aria-selected={option.region === field.region}
                      onMouseDown={(e) => {
                        // Keep focus in the search box; selection happens
                        // on click so assistive-tech activation also works.
                        e.preventDefault();
                      }}
                      onClick={() => chooseRegion(option)}
                      onMouseEnter={() => setHighlight(index)}
                      className={`cursor-pointer px-3 py-2 ${
                        index === highlight ? "bg-neutral-100" : "bg-white"
                      } ${option.region === field.region ? "font-medium" : ""}`}
                    >
                      <span aria-hidden="true" className="mr-2">
                        {flagGlyph(option.region)}
                      </span>
                      {option.name}{" "}
                      <span className="text-neutral-500">
                        (+{option.callingCode})
                      </span>
                    </li>
                  ))
                )}
                {matches.length === MAX_RENDERED && (
                  <li className="px-3 py-1 text-xs text-neutral-400">
                    Keep typing to narrow the list.
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
        <input
          ref={nationalRef}
          id={`${idPrefix}-phone`}
          name={fieldName}
          type="tel"
          inputMode="tel"
          autoComplete="off"
          maxLength={40}
          value={field.national}
          onChange={(e) => onNationalChange(e.target.value)}
          placeholder={selected?.example ?? "416 6039"}
          required={required}
          aria-invalid={Boolean(errors?.length)}
          aria-describedby={`${idPrefix}-phone-error`}
          className="min-w-0 flex-1 rounded-r-md border border-l-0 border-neutral-300 px-3 py-2 text-sm"
        />
      </div>
      <input type="hidden" name={regionFieldName} value={field.region} />
      {errors?.length ? (
        <p id={`${idPrefix}-phone-error`} className={errorClass} role="alert">
          {errors.join(" ")}
        </p>
      ) : null}
    </div>
  );
}
