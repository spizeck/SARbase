/**
 * Query normalization, match classification, and snippet extraction for
 * global organization search. Pure functions — no I/O — so the matching
 * semantics are unit-testable without a database.
 *
 * Matching is deliberately explainable, not a magic score: every hit is
 * classified into one of four deterministic classes (exact → prefix →
 * phrase → token coverage) and results sort by class, then title, then
 * id. Nothing here ranks people by attributes — a member name match is
 * a text match like any other.
 */

export const SEARCH_MIN_QUERY_LENGTH = 2;
export const SEARCH_MAX_QUERY_LENGTH = 100;
/** Token cap guards the generated WHERE size — each token multiplies
 * the field-OR clause. Over the cap the whole normalized string is
 * matched as one phrase instead of silently dropping terms. */
export const SEARCH_MAX_TOKENS = 8;

export interface NormalizedQuery {
  /** Whitespace-collapsed, lowercased, length-capped query. */
  normalized: string;
  /** Deduped tokens used for AND-across-tokens matching. */
  tokens: string[];
  /** normalized meets the minimum length. */
  valid: boolean;
  /** Input was truncated to SEARCH_MAX_QUERY_LENGTH. */
  truncated: boolean;
}

const WHITESPACE = /\s+/g;

export function normalizeSearchQuery(
  raw: string | null | undefined,
): NormalizedQuery {
  const collapsed = (raw ?? "").trim().replace(WHITESPACE, " ");
  const truncated = collapsed.length > SEARCH_MAX_QUERY_LENGTH;
  const normalized = (
    truncated ? collapsed.slice(0, SEARCH_MAX_QUERY_LENGTH) : collapsed
  ).toLowerCase();

  let tokens = normalized.length > 0 ? normalized.split(" ") : [];
  tokens = [...new Set(tokens)];
  if (tokens.length > SEARCH_MAX_TOKENS) {
    tokens = normalized ? [normalized] : [];
  }

  return {
    normalized,
    tokens,
    valid: normalized.length >= SEARCH_MIN_QUERY_LENGTH,
    truncated,
  };
}

export type SearchMatchClass = "exact" | "prefix" | "phrase" | "tokens";

/** Lower number sorts first. Exported for deterministic ordering. */
export const MATCH_CLASS_RANK: Record<SearchMatchClass, number> = {
  exact: 0,
  prefix: 1,
  phrase: 2,
  tokens: 3,
};

export interface MatchResult {
  matchClass: SearchMatchClass;
  /** The raw field value that produced the winning class — the value a
   * snippet should be drawn from. */
  matchedValue: string;
}

function normalizeValue(value: string): string {
  return value.replace(WHITESPACE, " ").toLowerCase();
}

function valueCoversAllTokens(value: string, tokens: string[]): boolean {
  return tokens.every((token) => value.includes(token));
}

/**
 * Classify how well a record's searchable field values match the query.
 * Field order does not matter — the best class across all fields wins,
 * and `matchedValue` is the value that produced it.
 */
export function classifyMatch(
  values: (string | null | undefined)[],
  query: NormalizedQuery,
): MatchResult | null {
  const present = values.filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (present.length === 0) return null;
  const normalized = present.map((v) => ({ raw: v, norm: normalizeValue(v) }));

  for (const v of normalized) {
    if (v.norm === query.normalized) {
      return { matchClass: "exact", matchedValue: v.raw };
    }
  }
  for (const v of normalized) {
    if (v.norm.startsWith(query.normalized)) {
      return { matchClass: "prefix", matchedValue: v.raw };
    }
  }
  for (const v of normalized) {
    if (v.norm.includes(query.normalized)) {
      return { matchClass: "phrase", matchedValue: v.raw };
    }
  }
  for (const v of normalized) {
    if (valueCoversAllTokens(v.norm, query.tokens)) {
      return { matchClass: "tokens", matchedValue: v.raw };
    }
  }
  // Cross-field token coverage — the SQL WHERE accepts tokens spread
  // across fields, so classification must too. matchedValue is the
  // field covering the most tokens, as the least-bad snippet source.
  if (query.tokens.length > 0) {
    const covered = query.tokens.every((token) =>
      normalized.some((v) => v.norm.includes(token)),
    );
    if (covered) {
      let best: { raw: string; norm: string } | undefined;
      let bestCount = -1;
      for (const v of normalized) {
        const count = query.tokens.filter((t) => v.norm.includes(t)).length;
        if (count > bestCount) {
          bestCount = count;
          best = v;
        }
      }
      if (best) return { matchClass: "tokens", matchedValue: best.raw };
    }
  }
  return null;
}

/**
 * Extract a short display window around the match inside `text`.
 * Prefers the full normalized query; falls back to the first token
 * found. Output is plain text — callers render it as text, never HTML.
 */
export function buildSnippet(
  text: string,
  query: NormalizedQuery,
  maxLength = 160,
): string {
  const normalized = normalizeValue(text);
  let index = normalized.indexOf(query.normalized);
  if (index < 0) {
    for (const token of query.tokens) {
      const at = normalized.indexOf(token);
      if (at >= 0 && (index < 0 || at < index)) index = at;
    }
  }
  if (index < 0 || text.length <= maxLength) {
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  }

  // Center the match inside the window, preferring a little more
  // context before the match than after.
  const before = Math.floor((maxLength - query.normalized.length) / 3);
  const start = Math.max(0, index - before);
  const end = Math.min(text.length, start + maxLength);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${
    end < text.length ? "…" : ""
  }`;
}
