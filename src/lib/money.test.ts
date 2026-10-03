import { describe, expect, it } from "vitest";

/**
 * Pure tests for the exact-money helpers used by issue #17 expenses.
 * The contract: integer minor units only, never floating point, and
 * currency-aware decimal places per ISO 4217.
 */

import {
  MAX_AMOUNT_MINOR,
  MoneyInputError,
  currencyExponent,
  formatMoney,
  isSupportedCurrency,
  parseMoneyAmount,
} from "./money";

describe("isSupportedCurrency / currencyExponent", () => {
  it("recognizes common ISO 4217 currencies with correct exponents", () => {
    expect(isSupportedCurrency("USD")).toBe(true);
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("EUR")).toBe(2);
    expect(currencyExponent("GBP")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
    expect(currencyExponent("CLF")).toBe(4);
  });

  it("rejects unknown or malformed currency codes", () => {
    for (const code of ["", "US", "USDD", "usd", "12A", "XXX", "XDR"]) {
      expect(isSupportedCurrency(code)).toBe(false);
      expect(() => currencyExponent(code)).toThrow(MoneyInputError);
    }
  });
});

describe("parseMoneyAmount", () => {
  it("parses two-decimal currencies exactly", () => {
    expect(parseMoneyAmount("42.15", "USD")).toBe(4215);
    expect(parseMoneyAmount("19.00", "EUR")).toBe(1900);
    expect(parseMoneyAmount("0.01", "USD")).toBe(1);
    expect(parseMoneyAmount("1234", "USD")).toBe(123400);
    // The classic float trap: 42.15 * 100 = 4214.999999999999 in IEEE-754.
    // The parser must land on 4215 exactly, not round to 4214.
    expect(parseMoneyAmount("42.15", "USD")).not.toBe(4214);
    expect(parseMoneyAmount("19.99", "USD")).toBe(1999);
  });

  it("respects non-2 exponents", () => {
    expect(parseMoneyAmount("1900", "JPY")).toBe(1900);
    expect(parseMoneyAmount("1.500", "KWD")).toBe(1500);
    expect(parseMoneyAmount("0.0001", "CLF")).toBe(1);
  });

  it("accepts whitespace and group separators, then strips them", () => {
    expect(parseMoneyAmount("  42.15 ", "USD")).toBe(4215);
    expect(parseMoneyAmount("1,234.56", "USD")).toBe(123456);
    expect(parseMoneyAmount("12,34,567.89", "USD")).toBe(123456789);
  });

  it("rejects too many fractional digits instead of rounding", () => {
    expect(() => parseMoneyAmount("1.999", "USD")).toThrow(MoneyInputError);
    expect(() => parseMoneyAmount("1.005", "USD")).toThrow(MoneyInputError);
    expect(() => parseMoneyAmount("1900.5", "JPY")).toThrow(MoneyInputError);
    expect(() => parseMoneyAmount("1.5000", "KWD")).toThrow(MoneyInputError);
  });

  it("rejects zero and negative amounts", () => {
    for (const raw of ["0", "0.00", "-1", "-0.01", "0.0"]) {
      expect(() => parseMoneyAmount(raw, "USD")).toThrow(MoneyInputError);
    }
    // JPY "0" too — zero is invalid regardless of exponent.
    expect(() => parseMoneyAmount("0", "JPY")).toThrow(MoneyInputError);
  });

  it("rejects empty, malformed, and non-numeric input", () => {
    for (const raw of ["", "   ", ".", "abc", "4.2.1", "$42.15", "4x", "--1"]) {
      expect(() => parseMoneyAmount(raw, "USD")).toThrow(MoneyInputError);
    }
  });

  it("rejects amounts beyond the 32-bit minor-unit ceiling", () => {
    expect(parseMoneyAmount("21474836.47", "USD")).toBe(MAX_AMOUNT_MINOR);
    expect(() => parseMoneyAmount("21474836.48", "USD")).toThrow(
      MoneyInputError,
    );
    expect(() => parseMoneyAmount("99999999999", "USD")).toThrow(
      MoneyInputError,
    );
  });

  it("round-trips exactly through formatMoney", () => {
    for (const [raw, currency] of [
      ["42.15", "USD"],
      ["1900", "JPY"],
      ["1.500", "KWD"],
      ["0.99", "EUR"],
      ["123456.78", "USD"],
    ] as const) {
      const minor = parseMoneyAmount(raw, currency);
      // Display strips nothing significant — parse the formatted major
      // part back and get identical minor units.
      const [code, display] = formatMoney(minor, currency).split(" ");
      expect(code).toBe(currency);
      expect(parseMoneyAmount(display!, currency)).toBe(minor);
    }
  });
});

describe("formatMoney", () => {
  it("renders the currency code with exact decimal places", () => {
    expect(formatMoney(4215, "USD")).toBe("USD 42.15");
    expect(formatMoney(1900, "EUR")).toBe("EUR 19.00");
    expect(formatMoney(1, "USD")).toBe("USD 0.01");
    expect(formatMoney(500, "USD")).toBe("USD 5.00");
    expect(formatMoney(1900, "JPY")).toBe("JPY 1,900");
    expect(formatMoney(1500, "KWD")).toBe("KWD 1.500");
    expect(formatMoney(123456789, "USD")).toBe("USD 1,234,567.89");
  });

  it("never loses precision for large amounts", () => {
    expect(formatMoney(MAX_AMOUNT_MINOR, "USD")).toBe("USD 21,474,836.47");
    expect(formatMoney(9999999, "USD")).toBe("USD 99,999.99");
  });

  it("rejects non-integer minor units", () => {
    expect(() => formatMoney(42.15 as number, "USD")).toThrow(MoneyInputError);
  });
});
