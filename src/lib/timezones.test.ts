import { describe, expect, it } from "vitest";

import {
  DEFAULT_ORGANIZATION_TIMEZONE,
  formatUtcOffset,
  timeZoneOptions,
} from "./timezones";
import { timeZoneSchema } from "./domain/schemas";

/**
 * Timezone picker option-list and validation tests — the selectable
 * options, current (DST-aware) offsets, search text, and the new-org
 * default.
 */

describe("timeZoneOptions", () => {
  it("covers the IANA database and includes the Saba default", () => {
    const options = timeZoneOptions();
    expect(options.length).toBeGreaterThan(300);
    const saba = options.find((o) => o.id === DEFAULT_ORGANIZATION_TIMEZONE);
    expect(saba).toBeDefined();
    expect(saba!.id).toBe("America/Kralendijk");
    expect(saba!.offsetMinutes).toBe(-240); // UTC−04:00, no DST
    expect(saba!.label).toBe("Kralendijk (America) — UTC−04:00");
  });

  it("reports daylight-saving offsets in effect at the given instant", () => {
    const winter = new Date("2026-01-15T00:00:00Z");
    const summer = new Date("2026-07-15T00:00:00Z");
    // Europe/Amsterdam: CET (+01:00) in January, CEST (+02:00) in July.
    const jan = timeZoneOptions(winter).find(
      (o) => o.id === "Europe/Amsterdam",
    )!;
    const jul = timeZoneOptions(summer).find(
      (o) => o.id === "Europe/Amsterdam",
    )!;
    expect(jan.offsetMinutes).toBe(60);
    expect(jan.label).toContain("UTC+01:00");
    expect(jul.offsetMinutes).toBe(120);
    expect(jul.label).toContain("UTC+02:00");
  });

  it("search text matches location names, ids, offsets, and aliases", () => {
    const options = timeZoneOptions();
    const search = (q: string) =>
      options.filter((o) => o.searchText.includes(q.toLowerCase()));
    expect(search("kralendijk").map((o) => o.id)).toContain(
      "America/Kralendijk",
    );
    expect(search("america/").length).toBeGreaterThan(50);
    // The Saba alias: "saba" finds the shared Caribbean Netherlands zone.
    expect(search("saba").map((o) => o.id)).toContain("America/Kralendijk");
  });

  it("is sorted by offset then label", () => {
    const options = timeZoneOptions();
    for (let i = 1; i < options.length; i += 1) {
      const prev = options[i - 1]!;
      const cur = options[i]!;
      expect(
        cur.offsetMinutes > prev.offsetMinutes ||
          (cur.offsetMinutes === prev.offsetMinutes &&
            cur.label.localeCompare(prev.label) >= 0),
      ).toBe(true);
    }
  });
});

describe("formatUtcOffset", () => {
  it("formats zero, negative, and fractional offsets", () => {
    expect(formatUtcOffset(0)).toBe("UTC");
    expect(formatUtcOffset(-240)).toBe("UTC−04:00");
    expect(formatUtcOffset(330)).toBe("UTC+05:30");
    expect(formatUtcOffset(345)).toBe("UTC+05:45");
  });
});

describe("timeZoneSchema", () => {
  it("defaults blank input to the new-organization default", () => {
    expect(timeZoneSchema.parse("")).toBe(DEFAULT_ORGANIZATION_TIMEZONE);
    expect(timeZoneSchema.parse("   ")).toBe(DEFAULT_ORGANIZATION_TIMEZONE);
    expect(timeZoneSchema.parse(undefined)).toBe(DEFAULT_ORGANIZATION_TIMEZONE);
  });

  it("accepts and preserves valid IANA identifiers", () => {
    expect(timeZoneSchema.parse("America/Puerto_Rico")).toBe(
      "America/Puerto_Rico",
    );
    expect(timeZoneSchema.parse("Europe/Amsterdam")).toBe("Europe/Amsterdam");
  });

  it("rejects invalid timezone values", () => {
    expect(timeZoneSchema.safeParse("Mars/Olympus").success).toBe(false);
    expect(timeZoneSchema.safeParse("UTC-4").success).toBe(false);
    expect(timeZoneSchema.safeParse("Saba").success).toBe(false);
  });
});
