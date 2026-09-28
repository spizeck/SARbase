import { describe, expect, it } from "vitest";

import {
  daysBetween,
  expiryInfo,
  expiryLabel,
  formatDateOnly,
  todayUtc,
} from "./qualification";

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("todayUtc", () => {
  it("pins the current instant to UTC midnight", () => {
    // 23:30 UTC on Nov 14 — must land on Nov 14 00:00Z, not Nov 15.
    const lateUtc = new Date("2027-11-14T23:30:00.000Z");
    expect(todayUtc(lateUtc).toISOString()).toBe("2027-11-14T00:00:00.000Z");
  });
});

describe("daysBetween", () => {
  it("counts whole calendar days ignoring time-of-day", () => {
    expect(daysBetween(D("2027-11-01"), D("2027-11-15"))).toBe(14);
    expect(daysBetween(D("2027-11-15"), D("2027-11-01"))).toBe(-14);
    expect(daysBetween(D("2027-11-15"), D("2027-11-15"))).toBe(0);
  });
});

describe("formatDateOnly", () => {
  it("renders the stored date-only value as YYYY-MM-DD", () => {
    expect(formatDateOnly(D("2027-11-14"))).toBe("2027-11-14");
  });

  it("returns null for absent dates", () => {
    expect(formatDateOnly(null)).toBeNull();
    expect(formatDateOnly(undefined)).toBeNull();
  });
});

describe("expiryInfo", () => {
  const today = D("2027-11-14");

  it("reports no_expiry when no expiry date exists", () => {
    expect(expiryInfo(null, today)).toEqual({
      state: "no_expiry",
      daysUntil: null,
    });
  });

  it("reports expired the day AFTER the expiry date (inclusive expiry)", () => {
    expect(expiryInfo(D("2027-11-13"), today).state).toBe("expired");
    expect(expiryInfo(D("2027-11-13"), today).daysUntil).toBe(-1);
  });

  it("treats expiring today as expiring_soon, not expired", () => {
    const info = expiryInfo(D("2027-11-14"), today);
    expect(info.state).toBe("expiring_soon");
    expect(info.daysUntil).toBe(0);
  });

  it("includes the last day of the window as expiring_soon", () => {
    expect(expiryInfo(D("2027-12-14"), today, 30).state).toBe("expiring_soon");
    expect(expiryInfo(D("2027-12-15"), today, 30).state).toBe("current");
  });

  it("reports current beyond the window", () => {
    const info = expiryInfo(D("2028-05-01"), today, 30);
    expect(info.state).toBe("current");
    expect(info.daysUntil).toBe(169);
  });

  it("is timezone-stable — a UTC-late today does not shift the boundary", () => {
    // Server clock at 23:59 UTC on the expiry day: still not expired.
    const lateSameDay = new Date("2027-11-14T23:59:59.999Z");
    expect(expiryInfo(D("2027-11-14"), todayUtc(lateSameDay)).state).toBe(
      "expiring_soon",
    );
    // One second into the next UTC day: expired.
    const nextDay = new Date("2027-11-15T00:00:00.000Z");
    expect(expiryInfo(D("2027-11-14"), todayUtc(nextDay)).state).toBe(
      "expired",
    );
  });
});

describe("expiryLabel", () => {
  const today = D("2027-11-14");

  it("uses factual, non-evaluative wording", () => {
    expect(expiryLabel(null, today)).toBe("No expiry recorded");
    expect(expiryLabel(D("2027-11-01"), today)).toBe("Expired 2027-11-01");
    expect(expiryLabel(D("2027-11-14"), today)).toBe(
      "Expires today (2027-11-14)",
    );
    expect(expiryLabel(D("2027-11-15"), today)).toBe(
      "Expires in 1 day (2027-11-15)",
    );
    expect(expiryLabel(D("2027-12-01"), today)).toBe(
      "Expires in 17 days (2027-12-01)",
    );
    expect(expiryLabel(D("2028-03-01"), today)).toBe(
      "Current through 2028-03-01",
    );
  });
});
