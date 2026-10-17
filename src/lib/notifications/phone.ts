import { parsePhoneNumberWithError } from "libphonenumber-js";

/**
 * E.164 normalization for messaging channels (issue #100).
 *
 * WhatsApp's Cloud API takes the destination as E.164 digits WITHOUT
 * the leading '+'. Member.phone is already written through the shared
 * E.164 normalizer (src/lib/contact.ts), but older or hand-edited rows
 * can hold anything — so this re-parses with the same library and
 * returns null when the value is not a valid phone number rather than
 * sending an alert to a mangled destination.
 */

/** Digits-only E.164 (e.g. "5994161234"), or null when not a number. */
export function normalizePhoneToE164Digits(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  try {
    const number = parsePhoneNumberWithError(raw.trim());
    // Parsing succeeds for plausible-but-invalid numbers (wrong length
    // for the country) — validity is a separate check.
    if (!number.isValid()) return null;
    return number.number.slice(1); // strip the leading "+"
  } catch {
    return null;
  }
}
