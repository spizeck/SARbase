/**
 * Calendar-date helpers.
 *
 * SARbase stores fact dates (qualification issue/expiry, later training,
 * incidents, reporting) as date-only values — a calendar date, not an
 * instant. Comparisons against "today" must use the OWNING
 * ORGANIZATION's IANA timezone: a certificate expiring 2027-11-14 is
 * covered through the end of Nov 14 in the organization's local date and
 * expired the next local day — regardless of server or UTC time.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** True when `tz` is an IANA timezone the runtime understands. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The calendar date currently in effect in `timeZone`, returned as a
 * UTC-midnight Date so it compares cleanly against stored @db.Date
 * values. "America/Puerto_Rico" at 2027-11-15T02:00Z is still Nov 14
 * locally → this returns the Nov 14 date.
 */
export function calendarDateInZone(
  timeZone: string,
  now: Date = new Date(),
): Date {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}

/** Today's calendar date pinned to UTC midnight (UTC semantics). */
export function todayUtc(now: Date = new Date()): Date {
  return calendarDateInZone("UTC", now);
}

/** Whole days from `from` to `to`, both treated as calendar dates. */
export function daysBetween(from: Date, to: Date): number {
  const utc = (d: Date) =>
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}

/** "YYYY-MM-DD" — the canonical date-only rendering of a stored date. */
export function formatDateOnly(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Compact "how long ago" label for a timestamp ("updated 2 hours ago").
 * Exact instants, not calendar dates — an instant is unambiguous
 * regardless of which organization's zone it is displayed in, so this
 * deliberately takes no timezone. Beyond a month the absolute date is
 * clearer than a large day count.
 */
export function relativeTimeLabel(date: Date, now: Date = new Date()): string {
  const elapsedSeconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (elapsedSeconds < 60) return "just now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 31) return `${days} day${days === 1 ? "" : "s"} ago`;
  return formatDateOnly(date) ?? "";
}
