import { describe, expect, it } from "vitest";

import { resolveSiteUrl } from "./site";

describe("resolveSiteUrl", () => {
  it("falls back to the local default when unset", () => {
    expect(resolveSiteUrl(undefined)).toBe("http://localhost:3000");
  });

  it("strips trailing slashes so callers can append paths", () => {
    expect(resolveSiteUrl("https://example.com/")).toBe("https://example.com");
    expect(resolveSiteUrl("https://example.com///")).toBe(
      "https://example.com",
    );
  });
});
