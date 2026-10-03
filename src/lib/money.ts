/**
 * Exact money representation for issue #17 expenses.
 *
 * Amounts are stored and passed around as integer minor units
 * (`amountMinor`) alongside an ISO 4217 currency code — JavaScript
 * floating point is never used for money. "USD 42.15" is `4215`,
 * "JPY 1900" is `1900`, "KWD 1.500" is `1500`.
 *
 * `minorUnits` is a 32-bit integer in storage (Postgres `INTEGER`), so
 * the maximum representable amount is 2,147,483,647 minor units —
 * USD 21,474,836.47 — comfortably beyond any plausible SAR expense.
 *
 * Currencies carry their ISO 4217 minor-unit exponent: JPY has 0,
 * KWD has 3, CLF/UYW have 4, most have 2. Codes with no defined minor
 * unit (XDR — IMF special drawing rights) are not supported. If the
 * organization only ever spends in a few currencies that is fine — the
 * parser still refuses amounts with more fractional digits than the
 * currency permits.
 */

export class MoneyInputError extends Error {}

/** Largest amountMinor Postgres INTEGER can store. */
export const MAX_AMOUNT_MINOR = 2_147_483_647;

// ISO 4217 active currency codes grouped by minor-unit exponent.
// Exponent 2 is the default — only non-2 exponents are listed
// explicitly; the exponent-2 list below exists so unsupported or
// mistyped codes fail validation rather than being silently treated
// as two-decimal currencies.
const EXPONENT_0 = [
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "UYI",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
];
const EXPONENT_3 = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];
const EXPONENT_4 = ["CLF", "UYW"];
const EXPONENT_2 = [
  "AED",
  "AFN",
  "ALL",
  "AMD",
  "ANG",
  "AOA",
  "ARS",
  "AUD",
  "AWG",
  "AZN",
  "BAM",
  "BBD",
  "BDT",
  "BGN",
  "BMD",
  "BND",
  "BOB",
  "BOV",
  "BRL",
  "BSD",
  "BTN",
  "BWP",
  "BYN",
  "BZD",
  "CAD",
  "CDF",
  "CHE",
  "CHF",
  "CHW",
  "CNY",
  "COP",
  "COU",
  "CRC",
  "CUP",
  "CVE",
  "CZK",
  "DKK",
  "DOP",
  "DZD",
  "EGP",
  "ERN",
  "ETB",
  "EUR",
  "FJD",
  "FKP",
  "GBP",
  "GEL",
  "GHS",
  "GIP",
  "GMD",
  "GTQ",
  "GYD",
  "HKD",
  "HNL",
  "HTG",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "IRR",
  "JMD",
  "KES",
  "KGS",
  "KHR",
  "KPW",
  "KYD",
  "KZT",
  "LAK",
  "LBP",
  "LKR",
  "LRD",
  "LSL",
  "MAD",
  "MDL",
  "MKD",
  "MMK",
  "MNT",
  "MOP",
  "MRU",
  "MUR",
  "MVR",
  "MWK",
  "MXN",
  "MXV",
  "MYR",
  "MZN",
  "NAD",
  "NGN",
  "NIO",
  "NOK",
  "NPR",
  "NZD",
  "PAB",
  "PEN",
  "PGK",
  "PHP",
  "PKR",
  "PLN",
  "QAR",
  "RON",
  "RSD",
  "RUB",
  "SAR",
  "SBD",
  "SCR",
  "SDG",
  "SEK",
  "SGD",
  "SHP",
  "SLE",
  "SOS",
  "SRD",
  "SSP",
  "STN",
  "SVC",
  "SYP",
  "SZL",
  "THB",
  "TJS",
  "TMT",
  "TOP",
  "TRY",
  "TTD",
  "TWD",
  "TZS",
  "UAH",
  "USD",
  "USN",
  "UYU",
  "UZS",
  "VED",
  "VES",
  "WST",
  "XCD",
  "XSU",
  "XUA",
  "YER",
  "ZAR",
  "ZMW",
  "ZWG",
  "ZWL",
];

const CURRENCY_EXPONENT = new Map<string, number>([
  ...EXPONENT_0.map((c) => [c, 0] as const),
  ...EXPONENT_2.map((c) => [c, 2] as const),
  ...EXPONENT_3.map((c) => [c, 3] as const),
  ...EXPONENT_4.map((c) => [c, 4] as const),
]);

export function isSupportedCurrency(code: string): boolean {
  return CURRENCY_EXPONENT.has(code);
}

/** ISO 4217 minor-unit exponent — throws for an unsupported code. */
export function currencyExponent(code: string): number {
  const exponent = CURRENCY_EXPONENT.get(code);
  if (exponent === undefined) {
    throw new MoneyInputError(`Unsupported currency "${code}".`);
  }
  return exponent;
}

/**
 * Parse a human-entered amount ("42.15", "1,900", " 12 ") into integer
 * minor units for the given currency. Exactness is the contract: the
 * string is decomposed digit-by-digit, never routed through float
 * division.
 *
 * - Leading/trailing whitespace and `,`/`_` group separators allowed.
 * - A bare minus sign is rejected — expenses are non-negative and zero
 *   is rejected too (a zero-amount record is a data-entry error; record
 *   genuine $0 items as notes/links instead).
 * - More fractional digits than the currency's exponent is rejected
 *   ("1.999" in USD is an error, not a rounding opportunity).
 */
export function parseMoneyAmount(raw: string, currency: string): number {
  const exponent = currencyExponent(currency);
  const cleaned = raw.trim().replace(/[,_]/g, "");
  if (cleaned === "" || cleaned === ".") {
    throw new MoneyInputError("Enter an amount.");
  }
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new MoneyInputError(`Amount "${raw}" is not a number like 42.15.`);
  }
  if (cleaned.startsWith("-")) {
    throw new MoneyInputError("Amount cannot be negative.");
  }
  const [wholePart, fractionPart = ""] = cleaned.split(".");
  if (fractionPart.length > exponent) {
    throw new MoneyInputError(
      `${currency} has ${exponent} decimal place${exponent === 1 ? "" : "s"} — "${raw}" has too many.`,
    );
  }
  const digits = wholePart + fractionPart.padEnd(exponent, "0");
  // Safe: digits ≤ 15 significant chars round-trips exactly through
  // Number; anything bigger is rejected by the minor-unit cap anyway.
  const amountMinor = Number(digits.replace(/^0+(?=\d)/, ""));
  if (!Number.isSafeInteger(amountMinor)) {
    throw new MoneyInputError("Amount is too large.");
  }
  if (amountMinor === 0) {
    throw new MoneyInputError("Amount must be greater than zero.");
  }
  if (amountMinor > MAX_AMOUNT_MINOR) {
    throw new MoneyInputError(
      `Amount exceeds the maximum for ${currency} storage.`,
    );
  }
  return amountMinor;
}

/**
 * Format integer minor units back to a display string —
 * `formatMoney(4215, "USD")` → "USD 42.15". Always exact; always shows
 * the currency's full exponent ("USD 5.00", "JPY 1900", "KWD 1.500").
 */
export function formatMoney(amountMinor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  if (!Number.isSafeInteger(amountMinor)) {
    throw new MoneyInputError("amountMinor must be an integer.");
  }
  const sign = amountMinor < 0 ? "-" : "";
  const digits = Math.abs(amountMinor)
    .toString()
    .padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent) || "0";
  const fraction = exponent > 0 ? `.${digits.slice(-exponent)}` : "";
  // Group the whole part in thousands for readability.
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency} ${sign}${grouped}${fraction}`;
}

/**
 * The bare decimal string for form inputs — `4215, "USD"` → `"42.15"`.
 * Round-trips through parseMoneyAmount exactly.
 */
export function amountMinorToDecimal(
  amountMinor: number,
  currency: string,
): string {
  const exponent = currencyExponent(currency);
  if (!Number.isSafeInteger(amountMinor)) {
    throw new MoneyInputError("amountMinor must be an integer.");
  }
  const digits = Math.abs(amountMinor)
    .toString()
    .padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent) || "0";
  return exponent > 0 ? `${whole}.${digits.slice(-exponent)}` : whole;
}
