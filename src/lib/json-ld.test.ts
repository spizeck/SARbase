import { describe, expect, it } from "vitest";

import { serializeJsonLd } from "./json-ld";

describe("serializeJsonLd", () => {
  it("escapes script-terminating sequences inside string values", () => {
    const out = serializeJsonLd({
      "@type": "Thing",
      name: "</script><script>alert(1)</script>",
    });
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c/script\\u003e");
    // Round-trip: the escaped output parses to the original value.
    expect(JSON.parse(out).name).toBe("</script><script>alert(1)</script>");
  });

  it("serializes ordinary objects identically to JSON.stringify", () => {
    const data = { "@context": "https://schema.org", "@type": "WebSite" };
    expect(JSON.parse(serializeJsonLd(data))).toEqual(data);
  });

  it("throws for values JSON cannot represent", () => {
    expect(() => serializeJsonLd(undefined)).toThrow(TypeError);
  });
});
