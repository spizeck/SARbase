import { isValidTimeZone } from "@/lib/dates";

/**
 * Searchable timezone option list for the Organization Settings picker.
 *
 * Options come from `Intl.supportedValuesOf("timeZone")` — the runtime's
 * own IANA data, so a valid option is always one `isValidTimeZone`
 * accepts server-side. Labels are human-readable ("Kralendijk —
 * UTC−04:00") and `searchText` folds the id, city, region, and offset
 * into one lowercase string the picker matches against.
 *
 * `offsetMinutes` is the CURRENT UTC offset for the zone at `now` —
 * zones observing daylight saving report their in-effect offset.
 */

export interface TimeZoneOption {
  /** IANA identifier — the value persisted on Organization.timezone. */
  id: string;
  /** Human label: "Kralendijk — UTC−04:00". */
  label: string;
  /** Lowercase haystack the picker matches against. */
  searchText: string;
  /** Minutes east of UTC right now (DST-aware). */
  offsetMinutes: number;
}

/** Default timezone for newly created organizations (Saba SAR). */
export const DEFAULT_ORGANIZATION_TIMEZONE = "America/Kralendijk";

/**
 * Location aliases that are not part of the IANA id but are how people
 * search: the Caribbean Netherlands public entities share the Bonaire
 * zone. Only aliases for regions actually in use are listed — the
 * picker otherwise searches id text.
 */
const SEARCH_ALIASES: Record<string, string[]> = {
  "America/Kralendijk": [
    "saba",
    "bonaire",
    "sint eustatius",
    "caribbean netherlands",
  ],
};

/** "GMT-04:00"/"GMT+05:30" → minutes east of UTC; "GMT" → 0. */
function offsetMinutesFor(timeZone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(now);
  const label = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(label);
  if (!m) return 0;
  const minutes = Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -minutes : minutes;
}

/** minutes east of UTC → "UTC−04:00" / "UTC+05:30" / "UTC". */
export function formatUtcOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes < 0 ? "−" : "+";
  const abs = Math.abs(offsetMinutes);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${h}:${m}`;
}

/** "America/Kralendijk" → "Kralendijk (America)". */
function humanize(id: string): string {
  const segments = id.split("/");
  const city = (segments[segments.length - 1] ?? id).replaceAll("_", " ");
  const region =
    segments.length > 1 ? ` (${segments.slice(0, -1).join("/")})` : "";
  return `${city}${region}`;
}

let cached: { key: number; options: TimeZoneOption[] } | null = null;

/**
 * The full option list — recomputed at most once per UTC hour so a
 * DST transition refreshes the displayed offsets without a rebuild.
 */
export function timeZoneOptions(now: Date = new Date()): TimeZoneOption[] {
  const hourKey = Math.floor(now.getTime() / 3_600_000);
  if (cached && cached.key === hourKey) return cached.options;

  const supported =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  const options = supported
    .filter(isValidTimeZone)
    .map((id) => {
      const offsetMinutes = offsetMinutesFor(id, now);
      const offsetLabel = formatUtcOffset(offsetMinutes);
      const name = humanize(id);
      const aliases = SEARCH_ALIASES[id] ?? [];
      return {
        id,
        label: `${name} — ${offsetLabel}`,
        searchText: [id, name, offsetLabel, ...aliases].join(" ").toLowerCase(),
        offsetMinutes,
      };
    })
    .sort(
      (a, b) =>
        a.offsetMinutes - b.offsetMinutes || a.label.localeCompare(b.label),
    );

  cached = { key: hourKey, options };
  return options;
}
