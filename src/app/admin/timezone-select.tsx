"use client";

import { useMemo, useRef, useState } from "react";

import type { TimeZoneOption } from "@/lib/timezones";

/**
 * Searchable timezone picker — a combobox over the server-computed IANA
 * option list. The submitted field is always a validated IANA id via a
 * hidden input; the visible input is search text only, so a partial
 * query can never be persisted as the value.
 *
 * Keyboard: ArrowDown/ArrowUp move the highlight, Enter selects,
 * Escape restores the current selection and closes. Pointer selection
 * uses onMouseDown so it wins the input's blur handler.
 */

const inputClass =
  "mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";

const MAX_RENDERED = 80;

export function TimezoneSelect({
  options,
  defaultValue,
  invalid,
}: {
  options: TimeZoneOption[];
  /** IANA id — the organization's current timezone. */
  defaultValue: string;
  invalid?: boolean;
}) {
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const [selectedId, setSelectedId] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = byId.get(selectedId);
  const displayValue = open ? query : (selected?.label ?? selectedId);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? options.filter((o) => o.searchText.includes(q)) : options;
    return list.slice(0, MAX_RENDERED);
  }, [options, query]);

  function choose(option: TimeZoneOption) {
    setSelectedId(option.id);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const next =
        e.key === "ArrowDown"
          ? Math.min(highlight + 1, matches.length - 1)
          : Math.max(highlight - 1, 0);
      setHighlight(next);
      listRef.current
        ?.querySelector(`[data-index="${next}"]`)
        ?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      if (open && matches[highlight]) {
        e.preventDefault();
        choose(matches[highlight]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  }

  return (
    <div className="relative">
      <input
        id="org-timezone"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls="org-timezone-listbox"
        aria-activedescendant={
          open && matches[highlight]
            ? `org-timezone-option-${highlight}`
            : undefined
        }
        aria-autocomplete="list"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby="org-timezone-error org-timezone-hint"
        autoComplete="off"
        required
        value={displayValue}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => {
          setQuery("");
          setOpen(true);
          setHighlight(0);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className={inputClass}
      />
      {/* The submitted value — always a resolved IANA id. */}
      <input type="hidden" name="timezone" value={selectedId} />
      {open && (
        <ul
          id="org-timezone-listbox"
          role="listbox"
          ref={listRef}
          className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border border-neutral-300 bg-white py-1 text-sm shadow-lg"
        >
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-neutral-500">
              No timezone matches — keep typing, or pick one from the list.
            </li>
          ) : (
            matches.map((option, index) => (
              <li
                key={option.id}
                id={`org-timezone-option-${index}`}
                data-index={index}
                role="option"
                aria-selected={option.id === selectedId}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(option);
                }}
                onMouseEnter={() => setHighlight(index)}
                className={`cursor-pointer px-3 py-2 ${
                  index === highlight ? "bg-neutral-100" : "bg-white"
                } ${option.id === selectedId ? "font-medium" : ""}`}
              >
                {option.label}
              </li>
            ))
          )}
          {matches.length === MAX_RENDERED && (
            <li className="px-3 py-1 text-xs text-neutral-400">
              Keep typing to narrow the list.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
