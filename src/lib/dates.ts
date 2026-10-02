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

/* ------------------------------------------------------------------ */
/* Wall-time ↔ instant conversion in a named zone (incident timestamps) */
/* ------------------------------------------------------------------ */

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * The wall-clock components an instant displays as in `timeZone`,
 * expressed as a fake UTC timestamp so wall times compare numerically.
 */
function wallAsUtcMs(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
}

/**
 * Interpret a `datetime-local` string ("YYYY-MM-DDTHH:mm") as wall time
 * in `timeZone` and return the corresponding UTC instant. The zone's
 * offset is measured iteratively so results stay correct across DST
 * transitions; a wall time in a spring-forward gap (or a repeated
 * fall-back hour) resolves to the nearest converged instant — the input
 * is never shifted silently to a different displayed minute.
 *
 * Returns null for malformed input or an impossible calendar date.
 */
export function instantInZone(timeZone: string, local: string): Date | null {
  const m = WALL_RE.exec(local.trim());
  if (!m || !isValidTimeZone(timeZone)) return null;
  const [y, mo, d, h, mi, s] = [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  ];
  const target = Date.UTC(y, mo - 1, d, h, mi, s);
  // Reject impossible wall times directly — Date.UTC normalizes values
  // like 2027-02-30 or 25:70 instead of producing NaN, so compare the
  // typed components against what the timestamp actually encodes.
  const probe = new Date(target);
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== mo - 1 ||
    probe.getUTCDate() !== d ||
    probe.getUTCHours() !== h ||
    probe.getUTCMinutes() !== mi ||
    probe.getUTCSeconds() !== s
  ) {
    return null;
  }
  let instant = target;
  for (let i = 0; i < 3; i += 1) {
    const offset = wallAsUtcMs(timeZone, new Date(instant)) - instant;
    const next = target - offset;
    if (next === instant) break;
    instant = next;
  }
  const result = new Date(instant);
  // In a spring-forward gap the typed wall time does not exist: the
  // converged instant displays a shifted wall time one DST step away
  // (max 2 hours). Anything further means the input was garbage.
  if (Math.abs(wallAsUtcMs(timeZone, result) - target) > 2 * 60 * 60 * 1000) {
    return null;
  }
  return result;
}

/**
 * Render an instant as a `datetime-local` value ("YYYY-MM-DDTHH:mm") in
 * `timeZone` — the inverse of instantInZone, for prefilling edit forms.
 */
export function localDateTimeString(
  date: Date | null | undefined,
  timeZone: string,
): string | null {
  if (!date) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/**
 * Render an instant for display in `timeZone` — incident instants are
 * org-local facts, so they display in the organization's own zone.
 */
export function formatInstantInZone(
  date: Date | null | undefined,
  timeZone: string,
): string | null {
  if (!date) return null;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date);
}
