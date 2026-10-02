import { describe, expect, it } from "vitest";

import {
  calendarDateInZone,
  daysBetween,
  formatDateOnly,
  formatInstantInZone,
  instantInZone,
  isValidTimeZone,
  localDateTimeString,
  relativeTimeLabel,
  todayUtc,
} from "./dates";
import { expiryInfo, expiryLabel } from "./domain/qualification";

const INSTANT = (iso: string) => new Date(iso);
const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("isValidTimeZone", () => {
  it("accepts real IANA zones and rejects junk", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/Puerto_Rico")).toBe(true);
    expect(isValidTimeZone("Europe/Amsterdam")).toBe(true);
    expect(isValidTimeZone("Pacific/Auckland")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("calendarDateInZone", () => {
  // 2027-11-15T02:00Z: Nov 15 in UTC and Auckland, still Nov 14 in Puerto Rico.
  const t = INSTANT("2027-11-15T02:00:00.000Z");

  it("UTC organization sees the UTC date", () => {
    expect(calendarDateInZone("UTC", t)).toEqual(D("2027-11-15"));
  });

  it("west of UTC: UTC crossed midnight, local date has not", () => {
    // Puerto Rico is UTC-4 year-round: 02:00Z = 22:00 Nov 14 local.
    expect(calendarDateInZone("America/Puerto_Rico", t)).toEqual(
      D("2027-11-14"),
    );
  });

  it("east of UTC: local date crosses midnight before UTC", () => {
    // Auckland is UTC+13 (NZDT in November): 2027-11-14T11:00Z is already
    // Nov 15 local while UTC still shows Nov 14.
    const beforeUtcMidnight = INSTANT("2027-11-14T11:00:00.000Z");
    expect(calendarDateInZone("UTC", beforeUtcMidnight)).toEqual(
      D("2027-11-14"),
    );
    expect(calendarDateInZone("Pacific/Auckland", beforeUtcMidnight)).toEqual(
      D("2027-11-15"),
    );
  });

  it("handles a DST transition correctly (America/New_York)", () => {
    // US DST ends 2027-11-07 at 02:00 local. At 06:30Z Nov 7 the zone is
    // still EDT (UTC-4, 02:30 local); the date must not wobble.
    expect(
      calendarDateInZone("America/New_York", INSTANT("2027-11-07T06:30:00Z")),
    ).toEqual(D("2027-11-07"));
    // 08:30Z Nov 7 is EST (UTC-5, 03:30 local) — still Nov 7.
    expect(
      calendarDateInZone("America/New_York", INSTANT("2027-11-07T08:30:00Z")),
    ).toEqual(D("2027-11-07"));
    // Spring forward 2027-03-14: 07:30Z is already EDT — still Mar 14.
    expect(
      calendarDateInZone("America/New_York", INSTANT("2027-03-14T07:30:00Z")),
    ).toEqual(D("2027-03-14"));
  });
});

describe("organization-local expiry semantics", () => {
  it("expires today vs expired next local day — west of UTC", () => {
    const expires = D("2027-11-14");
    // 02:00Z Nov 15: Puerto Rico is still on Nov 14 → NOT expired.
    const now = INSTANT("2027-11-15T02:00:00.000Z");
    const prToday = calendarDateInZone("America/Puerto_Rico", now);
    expect(expiryInfo(expires, prToday).state).toBe("expiring_soon");
    // A UTC org IS on Nov 15 → expired.
    expect(expiryInfo(expires, calendarDateInZone("UTC", now)).state).toBe(
      "expired",
    );
    // Hours later both agree it expired.
    const later = calendarDateInZone(
      "America/Puerto_Rico",
      INSTANT("2027-11-15T05:00:00.000Z"),
    );
    expect(expiryInfo(expires, later).state).toBe("expired");
  });

  it("expires today vs expired next local day — east of UTC", () => {
    const expires = D("2027-11-15");
    // 11:00Z Nov 14: Auckland is already Nov 15 → expires today.
    const now = INSTANT("2027-11-14T11:00:00.000Z");
    const nzToday = calendarDateInZone("Pacific/Auckland", now);
    expect(expiryInfo(expires, nzToday).state).toBe("expiring_soon");
    expect(expiryLabel(expires, nzToday)).toBe("Expires today (2027-11-15)");
    // UTC org still on Nov 14 → expiry is tomorrow, not today.
    expect(expiryInfo(expires, calendarDateInZone("UTC", now)).state).toBe(
      "expiring_soon",
    );
    expect(expiryInfo(expires, calendarDateInZone("UTC", now)).daysUntil).toBe(
      1,
    );
  });

  it("window boundaries are unchanged under local-date semantics", () => {
    const today = D("2027-11-14");
    expect(expiryInfo(D("2027-12-14"), today, 30).state).toBe("expiring_soon");
    expect(expiryInfo(D("2027-12-15"), today, 30).state).toBe("current");
    expect(expiryInfo(D("2028-02-12"), today, 90).state).toBe("expiring_soon");
    expect(expiryInfo(D("2028-02-13"), today, 90).state).toBe("current");
    expect(expiryInfo(D("2028-01-13"), today, 60).state).toBe("expiring_soon");
    expect(expiryInfo(D("2028-01-14"), today, 60).state).toBe("current");
  });
});

describe("todayUtc / daysBetween / formatDateOnly", () => {
  it("todayUtc is calendarDateInZone('UTC')", () => {
    const now = INSTANT("2027-11-14T23:59:00.000Z");
    expect(todayUtc(now)).toEqual(D("2027-11-14"));
  });

  it("daysBetween and formatDateOnly behave as before", () => {
    expect(daysBetween(D("2027-11-01"), D("2027-11-15"))).toBe(14);
    expect(formatDateOnly(D("2027-11-14"))).toBe("2027-11-14");
    expect(formatDateOnly(null)).toBeNull();
  });
});

describe("relativeTimeLabel", () => {
  const now = INSTANT("2027-11-14T12:00:00.000Z");

  it("describes recent timestamps as minutes/hours/days ago", () => {
    expect(relativeTimeLabel(INSTANT("2027-11-14T11:59:30.000Z"), now)).toBe(
      "just now",
    );
    expect(relativeTimeLabel(INSTANT("2027-11-14T11:45:00.000Z"), now)).toBe(
      "15 minutes ago",
    );
    expect(relativeTimeLabel(INSTANT("2027-11-14T06:00:00.000Z"), now)).toBe(
      "6 hours ago",
    );
    expect(relativeTimeLabel(INSTANT("2027-10-30T12:00:00.000Z"), now)).toBe(
      "15 days ago",
    );
  });

  it("uses singular units and falls back to the date past a month", () => {
    expect(relativeTimeLabel(INSTANT("2027-11-14T11:59:00.000Z"), now)).toBe(
      "1 minute ago",
    );
    expect(relativeTimeLabel(INSTANT("2027-11-13T12:00:00.000Z"), now)).toBe(
      "1 day ago",
    );
    expect(relativeTimeLabel(INSTANT("2027-09-01T12:00:00.000Z"), now)).toBe(
      "2027-09-01",
    );
  });
});

describe("instantInZone / localDateTimeString (incident wall times)", () => {
  it("interprets the input as wall time in the named zone", () => {
    // September is NZST (UTC+12) in Auckland — 14:00 local is 02:00Z.
    expect(
      instantInZone("Pacific/Auckland", "2026-09-15T14:00")?.toISOString(),
    ).toBe("2026-09-15T02:00:00.000Z");
    // November is NZDT (UTC+13) — the same wall time maps to 01:00Z.
    expect(
      instantInZone("Pacific/Auckland", "2026-11-15T14:00")?.toISOString(),
    ).toBe("2026-11-15T01:00:00.000Z");
    // Puerto Rico is UTC-4 year-round.
    expect(
      instantInZone("America/Puerto_Rico", "2026-11-15T14:00")?.toISOString(),
    ).toBe("2026-11-15T18:00:00.000Z");
    expect(instantInZone("UTC", "2026-11-15T14:00")?.toISOString()).toBe(
      "2026-11-15T14:00:00.000Z",
    );
  });

  it("rejects impossible dates, malformed input, and unknown zones", () => {
    expect(instantInZone("UTC", "2027-02-30T12:00")).toBeNull();
    expect(instantInZone("UTC", "2027-11-15T25:00")).toBeNull();
    expect(instantInZone("UTC", "2027-13-01T12:00")).toBeNull();
    expect(instantInZone("UTC", "not a date")).toBeNull();
    expect(instantInZone("UTC", "2027-11-15")).toBeNull();
    expect(instantInZone("Not/AZone", "2027-11-15T12:00")).toBeNull();
  });

  it("resolves a spring-forward gap to the nearest real instant", () => {
    // America/New_York springs forward 2027-03-14 at 02:00 — 02:30 never
    // exists locally. The result must still be a real instant displaying
    // within one DST step of the typed wall time.
    const instant = instantInZone("America/New_York", "2027-03-14T02:30");
    expect(instant).not.toBeNull();
    const shown = localDateTimeString(instant, "America/New_York");
    expect(["2027-03-14T01:30", "2027-03-14T03:30"]).toContain(shown);
  });

  it("round-trips instant ↔ datetime-local in the same zone", () => {
    const instant = instantInZone("Pacific/Auckland", "2026-09-15T14:00")!;
    expect(localDateTimeString(instant, "Pacific/Auckland")).toBe(
      "2026-09-15T14:00",
    );
    // Displayed in a different zone the wall time shifts honestly.
    expect(localDateTimeString(instant, "UTC")).toBe("2026-09-15T02:00");
    expect(localDateTimeString(null, "UTC")).toBeNull();
    expect(
      formatInstantInZone(INSTANT("2026-09-15T02:00:00.000Z"), "UTC"),
    ).toBe("Sep 15, 2026, 2:00 AM");
    expect(formatInstantInZone(null, "UTC")).toBeNull();
  });
});
