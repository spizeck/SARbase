"use client";

import type { PhoneRegionOption } from "@/lib/contact";

/**
 * Shared phone entry — a region selector (defaulting to Caribbean
 * Netherlands, +599) paired with the number input. Numbers typed
 * without a "+" prefix parse against the selected region; "+…"
 * international input ignores it. The server re-validates and
 * normalizes to E.164 — this is presentation only.
 *
 * `regions` is computed server-side (`phoneRegionOptions()`) so the
 * libphonenumber metadata never ships to the client bundle.
 */

const inputClass =
  "mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";
const labelClass = "block text-sm font-medium text-neutral-800";
const errorClass = "mt-1 text-sm text-red-700";

export function PhoneFields({
  idPrefix,
  regions,
  defaultPhone,
  defaultRegion,
  errors,
}: {
  idPrefix: string;
  regions: PhoneRegionOption[];
  defaultPhone?: string | null;
  defaultRegion?: string | null;
  errors?: string[];
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,14rem)_1fr]">
      <div>
        <label htmlFor={`${idPrefix}-phone-region`} className={labelClass}>
          Country / region
        </label>
        <select
          id={`${idPrefix}-phone-region`}
          name="phoneRegion"
          defaultValue={defaultRegion ?? "BQ"}
          className={inputClass}
        >
          {regions.map((r) => (
            <option key={r.region} value={r.region}>
              {r.name} (+{r.callingCode})
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-phone`} className={labelClass}>
          Phone <span className="font-normal text-neutral-500">(optional)</span>
        </label>
        <input
          id={`${idPrefix}-phone`}
          name="phone"
          type="tel"
          maxLength={40}
          defaultValue={defaultPhone ?? undefined}
          placeholder="+599 416 1234"
          aria-invalid={Boolean(errors?.length)}
          aria-describedby={`${idPrefix}-phone-error`}
          className={inputClass}
        />
        {errors?.length ? (
          <p id={`${idPrefix}-phone-error`} className={errorClass} role="alert">
            {errors.join(" ")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
