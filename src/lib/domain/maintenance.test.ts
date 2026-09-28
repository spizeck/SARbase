import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";

import { calendarDateInZone } from "@/lib/dates";

import {
  addRecurrence,
  classifyDateDue,
  classifyMeterDue,
  dateDueLabel,
} from "./maintenance";

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const dec = (v: string) => new Prisma.Decimal(v);

describe("addRecurrence", () => {
  it("adds calendar days to the performed date", () => {
    expect(addRecurrence(D("2026-09-15"), "CALENDAR_DAYS", 30)).toEqual(
      D("2026-10-15"),
    );
  });

  it("adds calendar months, preserving the day of month", () => {
    expect(addRecurrence(D("2026-01-15"), "CALENDAR_MONTHS", 12)).toEqual(
      D("2027-01-15"),
    );
  });

  it("clamps month arithmetic to the target month's last day", () => {
    // Jan 31 + 1 month must land on Feb 28, never roll into March.
    expect(addRecurrence(D("2027-01-31"), "CALENDAR_MONTHS", 1)).toEqual(
      D("2027-02-28"),
    );
    // Leap year: Jan 31 2028 + 1 month → Feb 29.
    expect(addRecurrence(D("2028-01-31"), "CALENDAR_MONTHS", 1)).toEqual(
      D("2028-02-29"),
    );
  });

  it("returns null for NONE and METER_INTERVAL", () => {
    expect(addRecurrence(D("2026-09-15"), "NONE", null)).toBeNull();
    expect(addRecurrence(D("2026-09-15"), "METER_INTERVAL", null)).toBeNull();
    expect(addRecurrence(D("2026-09-15"), "CALENDAR_DAYS", null)).toBeNull();
  });
});

describe("classifyDateDue", () => {
  const today = D("2026-10-15");

  it("is overdue starting the day AFTER the due date", () => {
    const info = classifyDateDue(D("2026-10-14"), today);
    expect(info.state).toBe("overdue");
    expect(info.daysUntil).toBe(-1);
  });

  it("is due today for the whole local day — not overdue", () => {
    const info = classifyDateDue(D("2026-10-15"), today);
    expect(info.state).toBe("due_today");
    expect(info.daysUntil).toBe(0);
  });

  it("is due_soon inside the window, scheduled beyond it", () => {
    expect(classifyDateDue(D("2026-10-20"), today).state).toBe("due_soon");
    // Boundary: exactly windowDays ahead is still "due soon".
    expect(classifyDateDue(D("2026-11-14"), today, 30).state).toBe("due_soon");
    expect(classifyDateDue(D("2026-11-15"), today, 30).state).toBe("scheduled");
  });
});

describe("organization-local due boundaries", () => {
  // The same UTC instant lands on different local dates west and east
  // of UTC. A due date must follow the OWNING organization's zone.
  const instant = new Date("2026-10-15T02:00:00.000Z");
  const due = D("2026-10-15");

  it("west of UTC — still the 14th locally, so due tomorrow", () => {
    const today = calendarDateInZone("America/Puerto_Rico", instant);
    expect(today).toEqual(D("2026-10-14"));
    expect(classifyDateDue(due, today).state).toBe("due_soon");
  });

  it("east of UTC — already the 15th locally, due today", () => {
    const today = calendarDateInZone("Pacific/Auckland", instant);
    expect(today).toEqual(D("2026-10-15"));
    expect(classifyDateDue(due, today).state).toBe("due_today");
  });

  it("overdue starts on the next LOCAL day, not at the UTC boundary", () => {
    // UTC has rolled to Oct 16 but Puerto Rico is still on Oct 15 —
    // the asset's org is not yet overdue.
    const instant2 = new Date("2026-10-16T02:00:00.000Z");
    const westToday = calendarDateInZone("America/Puerto_Rico", instant2);
    expect(westToday).toEqual(D("2026-10-15"));
    expect(classifyDateDue(due, westToday).state).toBe("due_today");
    const eastToday = calendarDateInZone("Pacific/Auckland", instant2);
    expect(eastToday).toEqual(D("2026-10-16"));
    expect(classifyDateDue(due, eastToday).state).toBe("overdue");
  });

  it("handles DST zones — America/Puerto_Rico has none, New York does", () => {
    // Around the Nov 1 2026 US fall-back the local calendar date must
    // still resolve correctly.
    const beforeFallback = new Date("2026-11-01T04:30:00.000Z");
    const nyToday = calendarDateInZone("America/New_York", beforeFallback);
    expect(nyToday).toEqual(D("2026-11-01"));
    expect(classifyDateDue(D("2026-11-01"), nyToday).state).toBe("due_today");
  });
});

describe("dateDueLabel", () => {
  const today = D("2026-10-15");

  it("states overdue facts as day counts, never verdicts", () => {
    expect(dateDueLabel(D("2026-10-03"), today)).toBe(
      "Overdue by 12 days (due 2026-10-03)",
    );
    expect(dateDueLabel(D("2026-10-14"), today)).toBe(
      "Overdue by 1 day (due 2026-10-14)",
    );
  });

  it("renders due-today and upcoming factually", () => {
    expect(dateDueLabel(D("2026-10-15"), today)).toBe("Due today (2026-10-15)");
    expect(dateDueLabel(D("2026-10-18"), today)).toBe(
      "Due in 3 days (2026-10-18)",
    );
    expect(dateDueLabel(D("2027-01-01"), today)).toBe("Due 2027-01-01");
  });

  it("renders the absence of a due date honestly", () => {
    expect(dateDueLabel(null, today)).toBe("No due date recorded");
  });
});

describe("classifyMeterDue", () => {
  it("reports a baseline + interval as a due threshold", () => {
    const info = classifyMeterDue(dec("812.4"), dec("100"), dec("850"));
    expect(info.state).toBe("below_threshold");
    expect(info.dueReading?.toString()).toBe("912.4");
    expect(info.remaining?.toString()).toBe("62.4");
    expect(info.overBy).toBeNull();
  });

  it("reaches the threshold exactly at the due reading", () => {
    const info = classifyMeterDue(dec("812.4"), dec("100"), dec("912.4"));
    expect(info.state).toBe("threshold_reached");
    expect(info.overBy?.toString()).toBe("0");
  });

  it("reports the exact amount past the threshold", () => {
    const info = classifyMeterDue(dec("812.4"), dec("100"), dec("934.2"));
    expect(info.state).toBe("threshold_reached");
    expect(info.overBy?.toString()).toBe("21.8");
  });

  it("keeps exact decimal behavior — no float drift", () => {
    const info = classifyMeterDue(dec("0.1"), dec("0.2"), dec("0.3"));
    expect(info.dueReading?.toString()).toBe("0.3");
    expect(info.state).toBe("threshold_reached");
    expect(info.overBy?.toString()).toBe("0");
  });

  it("distinguishes never-performed from a missing current reading", () => {
    expect(classifyMeterDue(null, dec("100"), dec("50")).state).toBe(
      "never_performed",
    );
    expect(classifyMeterDue(dec("800"), dec("100"), null).state).toBe(
      "no_reading",
    );
  });
});
