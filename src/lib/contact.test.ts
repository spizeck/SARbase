import { describe, expect, it } from "vitest";

import {
  DEFAULT_PHONE_REGION,
  formatPhoneNumber,
  normalizeEmail,
  normalizePhoneField,
  normalizePhoneNumber,
  phoneRegionOf,
  phoneRegionOptions,
  PhoneNumberInvalidError,
  splitPhoneForDisplay,
} from "./contact";

/**
 * Shared contact-normalization policy tests — email + phone rules that
 * every domain write path enforces (member, vendor, invitation).
 */

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Otto.deVries@Example.ORG \n")).toBe(
      "otto.devries@example.org",
    );
  });

  it("is idempotent on already-normalized input", () => {
    expect(normalizeEmail(normalizeEmail("A@B.Cd"))).toBe("a@b.cd");
  });
});

describe("normalizePhoneNumber", () => {
  it("normalizes a Caribbean Netherlands local number to E.164 by default", () => {
    // Saba/Sint Eustatius/Bonaire numbering: +599 with 7-digit national.
    expect(normalizePhoneNumber("416 1234")).toBe("+5994161234");
    expect(normalizePhoneNumber("416 1234", "BQ")).toBe("+5994161234");
  });

  it("accepts common punctuation and separators", () => {
    expect(normalizePhoneNumber("(416) 123-4", "BQ")).toBe("+5994161234");
    expect(normalizePhoneNumber("599-416-1234", "BQ")).toBe("+5994161234");
  });

  it("accepts international numbers regardless of the selected region", () => {
    expect(normalizePhoneNumber("+31 20 240 2400", "BQ")).toBe("+31202402400");
    expect(normalizePhoneNumber("+1 (415) 555-2671")).toBe("+14155552671");
  });

  it("parses a national number against an explicitly selected region", () => {
    expect(normalizePhoneNumber("20 7946 0958", "GB")).toBe("+442079460958");
  });

  it("rejects garbage input", () => {
    expect(() => normalizePhoneNumber("not a phone")).toThrow(
      PhoneNumberInvalidError,
    );
    expect(() => normalizePhoneNumber("+++")).toThrow(PhoneNumberInvalidError);
    expect(() => normalizePhoneNumber("12")).toThrow(PhoneNumberInvalidError);
  });

  it("rejects a number that is invalid for its region rather than inventing a country", () => {
    // "999 9999" is not a valid BQ national number — it must not be
    // silently rewritten under another country.
    expect(() => normalizePhoneNumber("999 9999", "BQ")).toThrow(
      PhoneNumberInvalidError,
    );
  });

  it("falls back to the default region for an unrecognized region code", () => {
    // Unknown region codes degrade to the documented default rather
    // than throwing on the region itself.
    expect(normalizePhoneNumber("416 1234", "XX")).toBe("+5994161234");
  });
});

describe("normalizePhoneField", () => {
  it("maps absent input to null", () => {
    expect(normalizePhoneField(null)).toBeNull();
    expect(normalizePhoneField(undefined)).toBeNull();
  });

  it("normalizes present input", () => {
    expect(normalizePhoneField("416 1234")).toBe("+5994161234");
  });
});

describe("formatPhoneNumber", () => {
  it("renders E.164 in readable international form", () => {
    expect(formatPhoneNumber("+5994161234")).toBe("+599 416 1234");
  });

  it("passes through values it cannot parse — display never invents", () => {
    expect(formatPhoneNumber("ext. 4 after hours")).toBe("ext. 4 after hours");
  });
});

describe("phoneRegionOf", () => {
  it("resolves the region of a stored E.164 number", () => {
    expect(phoneRegionOf("+5994161234")).toBe("BQ");
    expect(phoneRegionOf("+31202402400")).toBe("NL");
  });

  it("returns null for unparseable input", () => {
    expect(phoneRegionOf("n/a")).toBeNull();
  });
});

describe("splitPhoneForDisplay", () => {
  it("splits a Caribbean Netherlands number for edit-form initialization", () => {
    expect(splitPhoneForDisplay("+5994166039")).toEqual({
      region: "BQ",
      national: "416 6039",
    });
  });

  it("splits US and Netherlands numbers", () => {
    expect(splitPhoneForDisplay("+12025550123")).toEqual({
      region: "US",
      national: "(202) 555-0123",
    });
    expect(splitPhoneForDisplay("+31612345678")).toEqual({
      region: "NL",
      national: "06 12345678",
    });
  });

  it("resolves shared calling codes by the actual digits", () => {
    // +1 246 is Barbados, not an arbitrary NANP region.
    expect(splitPhoneForDisplay("+12462260000")).toMatchObject({
      region: "BB",
    });
    // +39 resolves IT vs VA from the subscriber prefix.
    expect(splitPhoneForDisplay("+390212345678")?.region).toBe("IT");
    expect(splitPhoneForDisplay("+390669820000")?.region).toBe("VA");
    // +47 resolves NO vs SJ.
    expect(splitPhoneForDisplay("+4779070800")?.region).toBe("SJ");
    expect(splitPhoneForDisplay("+4791444455")?.region).toBe("NO");
  });

  it("round-trips: national + region renormalizes to the same E.164", () => {
    for (const e164 of [
      "+5994166039",
      "+12025550123",
      "+31612345678",
      "+442071234567",
      "+390212345678",
      "+12462260000",
      "+525512345678",
    ]) {
      const parts = splitPhoneForDisplay(e164);
      expect(parts, e164).not.toBeNull();
      expect(normalizePhoneNumber(parts!.national, parts!.region)).toBe(e164);
    }
  });

  it("returns null for unparseable or non-geographic input", () => {
    expect(splitPhoneForDisplay("not a number")).toBeNull();
    expect(splitPhoneForDisplay("+++")).toBeNull();
    // +800 international toll-free has no region — callers keep the raw value.
    expect(splitPhoneForDisplay("+80012345678")).toBeNull();
  });
});

describe("phoneRegionOptions", () => {
  it("covers the calling-code regions and includes the default", () => {
    const options = phoneRegionOptions();
    expect(options.length).toBeGreaterThan(200);
    const bq = options.find((o) => o.region === DEFAULT_PHONE_REGION);
    expect(bq).toMatchObject({ region: "BQ", callingCode: "599" });
    expect(bq?.name.toLowerCase()).toContain("caribbean netherlands");
    // National-format example for placeholders — present for common regions.
    expect(bq?.example).toBeTruthy();
    expect(options.find((o) => o.region === "NL")?.example).toBeTruthy();
    // Sorted by human-readable name for scanning.
    const names = options.map((o) => o.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });
});
