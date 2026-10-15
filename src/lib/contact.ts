import {
  getCountries,
  getCountryCallingCode,
  getExampleNumber,
  parsePhoneNumberWithError,
  type CountryCode,
} from "libphonenumber-js";
import exampleNumbers from "libphonenumber-js/examples.mobile.json";

/**
 * Shared contact normalization (email + phone) — the single policy for
 * how contact values are validated, normalized for storage, and
 * displayed. Server-enforced: form submissions pass through the domain
 * schemas (src/lib/domain/schemas.ts), which call these functions, so
 * normalization is identical everywhere a contact value enters.
 *
 * EMAIL POLICY: trim + lowercase for matching and storage. Stored
 * lowercase; the "email looks like" comparisons (invitation acceptance,
 * identity lookup) normalize the same way. A normalized contact email is
 * never proof of account ownership — AuthIdentity/provider claims are.
 *
 * PHONE POLICY: parse with libphonenumber-js; store the canonical E.164
 * (the library's `number` property); display the international format
 * (`formatInternational`). Numbers typed without a "+" prefix parse
 * against the caller-supplied region — the UI default is Caribbean
 * Netherlands (BQ, +599), Saba SAR's dialing region. Ambiguous or
 * invalid input is rejected with a useful error — a country is never
 * invented silently for an unparseable number.
 */

/** ISO 3166-1 alpha-2 region code for Caribbean Netherlands (+599). */
export const DEFAULT_PHONE_REGION: CountryCode = "BQ";

/** Trim + lowercase — the documented email normalization policy. */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

export class PhoneNumberInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhoneNumberInvalidError";
  }
}

function isRegion(value: string | undefined): value is CountryCode {
  return Boolean(
    value &&
    /^[A-Z]{2}$/.test(value) &&
    (getCountries() as readonly string[]).includes(value),
  );
}

/**
 * Validate + normalize a phone number to E.164.
 *
 * `region` is the ISO alpha-2 default region for numbers WITHOUT a "+"
 * prefix — UI-supplied, defaulting to BQ. A leading "+" makes the
 * number self-describing (E.164 international format) and the region is
 * ignored, so international numbers always work regardless of the
 * selected region.
 */
export function normalizePhoneNumber(
  input: string,
  region: string | undefined = DEFAULT_PHONE_REGION,
): string {
  const trimmed = input.trim();
  const defaultRegion = isRegion(region) ? region : DEFAULT_PHONE_REGION;

  let number;
  try {
    number = trimmed.startsWith("+")
      ? parsePhoneNumberWithError(trimmed)
      : parsePhoneNumberWithError(trimmed, defaultRegion);
  } catch {
    throw new PhoneNumberInvalidError(
      "Enter a valid phone number — international format like +599 416 1234, or a local number with the right region selected.",
    );
  }
  if (!number.isValid()) {
    throw new PhoneNumberInvalidError(
      "That phone number isn't valid for the selected region. Check the number, or select the right country and try again.",
    );
  }
  return number.number; // canonical E.164
}

/**
 * Normalize an optional contact phone field to E.164-or-null — the
 * domain write path's single choke point. `region` is the UI-selected
 * default region for numbers without a "+" prefix.
 */
export function normalizePhoneField(
  phone: string | null | undefined,
  region?: string,
): string | null {
  if (phone == null) return null;
  return normalizePhoneNumber(phone, region);
}

/**
 * Best-effort display formatting: E.164 → readable international form
 * ("+599 416 1234"). Unparseable stored values (predating the
 * normalization policy) pass through verbatim — display never invents.
 */
export function formatPhoneNumber(input: string): string {
  try {
    const number = parsePhoneNumberWithError(input.trim());
    return number.formatInternational();
  } catch {
    return input;
  }
}

/** The ISO region a stored number belongs to, if resolvable. */
export function phoneRegionOf(input: string): string | null {
  try {
    const number = parsePhoneNumberWithError(input.trim());
    return number.country ?? null;
  } catch {
    return null;
  }
}

export interface PhoneDisplayParts {
  /** ISO alpha-2 region, e.g. "BQ". */
  region: string;
  /** Region-local display format, e.g. "416 6039" for a BQ number. */
  national: string;
}

/**
 * Split a "+…" international number into { region, national } for the
 * split phone input — used both to initialize edit forms from a stored
 * E.164 value and to re-decompose a number pasted or typed with a "+"
 * prefix. `region` comes from the library's own numbering-plan data,
 * so shared calling codes resolve by the actual digits (a +1 246 …
 * number is Barbados, not "the first +1 region"). Returns null when the
 * input is unparseable or non-geographic (e.g. +800 toll-free) — callers
 * keep the raw value rather than invent a region.
 */
export function splitPhoneForDisplay(input: string): PhoneDisplayParts | null {
  try {
    const number = parsePhoneNumberWithError(input.trim());
    if (!number.country) return null;
    return { region: number.country, national: number.formatNational() };
  } catch {
    return null;
  }
}

export interface PhoneRegionOption {
  /** ISO alpha-2 code, e.g. "BQ". */
  region: string;
  /** Dialing prefix digits, e.g. "599". */
  callingCode: string;
  /** Human-readable territory name. */
  name: string;
  /**
   * Region-local example mobile number for input placeholders, e.g.
   * "318 1234" for BQ — absent when the library has no example.
   */
  example?: string;
}

let regionNames: Intl.DisplayNames | null = null;

/**
 * The country options for the phone-region selector — every region
 * libphonenumber knows, labeled "Name (+code)" and sorted for scanning.
 * Caribbean Netherlands (+599) is the UI default, not a limit.
 */
export function phoneRegionOptions(): PhoneRegionOption[] {
  const names = (regionNames ??= new Intl.DisplayNames(["en"], {
    type: "region",
  }));
  return getCountries()
    .map((region) => ({
      region,
      callingCode: getCountryCallingCode(region),
      name: names.of(region) ?? region,
      example: getExampleNumber(region, exampleNumbers)?.formatNational(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
