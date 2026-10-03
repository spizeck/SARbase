import { describe, expect, it } from "vitest";

import {
  buildSnippet,
  classifyMatch,
  normalizeSearchQuery,
  SEARCH_MAX_QUERY_LENGTH,
  SEARCH_MAX_TOKENS,
} from "./query";

function q(raw: string) {
  return normalizeSearchQuery(raw);
}

describe("normalizeSearchQuery", () => {
  it("trims and collapses whitespace", () => {
    expect(q("  flare   gun \t ").normalized).toBe("flare gun");
  });

  it("lowercases for case-insensitive matching", () => {
    expect(q("Rescue BOAT").normalized).toBe("rescue boat");
  });

  it("marks empty and single-character queries invalid", () => {
    expect(q("").valid).toBe(false);
    expect(q("   ").valid).toBe(false);
    expect(q("x").valid).toBe(false);
    expect(q("x ").valid).toBe(false);
    expect(q("xy").valid).toBe(true);
  });

  it("preserves punctuation that matters (3/8, INC-7, O'Brien)", () => {
    expect(q("3/8 line").tokens).toEqual(["3/8", "line"]);
    expect(q("INC-7").normalized).toBe("inc-7");
    expect(q("O'Brien").normalized).toBe("o'brien");
  });

  it("dedupes tokens", () => {
    expect(q("line line line").tokens).toEqual(["line"]);
  });

  it("truncates overlong input and reports it", () => {
    const result = q("a".repeat(SEARCH_MAX_QUERY_LENGTH + 50));
    expect(result.truncated).toBe(true);
    expect(result.normalized.length).toBe(SEARCH_MAX_QUERY_LENGTH);
  });

  it("collapses queries with too many tokens into one phrase token", () => {
    const result = q(
      Array.from({ length: SEARCH_MAX_TOKENS + 2 }, (_, i) => `w${i}`).join(
        " ",
      ),
    );
    expect(result.tokens).toEqual([result.normalized]);
  });
});

describe("classifyMatch", () => {
  it("classifies exact matches first", () => {
    expect(classifyMatch(["INC-7", "INC-70"], q("inc-7"))?.matchClass).toBe(
      "exact",
    );
  });

  it("classifies prefix matches", () => {
    expect(classifyMatch(["Flare gun"], q("fla"))?.matchClass).toBe("prefix");
    // A whole-word prefix is still a prefix, not an exact match.
    expect(classifyMatch(["Flare gun"], q("flare"))?.matchClass).toBe("prefix");
  });

  it("classifies phrase (substring) matches", () => {
    expect(classifyMatch(["Flares (six)"], q("flares"))?.matchClass).toBe(
      "prefix",
    );
    expect(classifyMatch(["six flares"], q("flares"))?.matchClass).toBe(
      "phrase",
    );
  });

  it("classifies token matches — all tokens in one field, any order", () => {
    const result = classifyMatch(["3/8 double-braid line"], q("line 3/8"));
    expect(result?.matchClass).toBe("tokens");
  });

  it("classifies cross-field token coverage as tokens", () => {
    const result = classifyMatch(
      ["Engine oil change", "West Marine"],
      q("oil marine"),
    );
    expect(result?.matchClass).toBe("tokens");
  });

  it("returns null when nothing matches", () => {
    expect(classifyMatch(["Rescue boat"], q("flares"))).toBeNull();
    expect(classifyMatch([], q("flares"))).toBeNull();
    expect(classifyMatch([null, undefined], q("flares"))).toBeNull();
  });

  it("requires every token — partial token coverage is not a match", () => {
    expect(classifyMatch(["3/8 line"], q("3/8 missing"))).toBeNull();
  });

  it("skips null/empty values", () => {
    const result = classifyMatch([null, "Rescue Boat 1"], q("rescue"));
    expect(result?.matchedValue).toBe("Rescue Boat 1");
  });

  it("handles regex-hostile input literally", () => {
    const hostile = q("%_'\"; DROP TABLE members;--");
    expect(hostile.valid).toBe(true);
    expect(classifyMatch(["safe"], hostile)).toBeNull();
  });
});

describe("buildSnippet", () => {
  it("returns the whole short text when it fits", () => {
    expect(buildSnippet("short text", q("text"))).toBe("short text");
  });

  it("centers the match inside a window with ellipses", () => {
    const body = `${"filler ".repeat(40)}FLARES were stored aft${" more ".repeat(40)}`;
    const snippet = buildSnippet(body, q("flares"), 120);
    expect(snippet.length).toBeLessThanOrEqual(122);
    expect(snippet).toContain("FLARES");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("falls back to the first token when the full phrase is absent", () => {
    const body = `${"x".repeat(100)}needle${"y".repeat(100)}`;
    const snippet = buildSnippet(body, q("needle other"), 80);
    expect(snippet).toContain("needle");
  });
});
