import { describe, expect, it } from "vitest";

import {
  memberInputSchema,
  memberStatusSchema,
  organizationInputSchema,
} from "./schemas";

describe("organizationInputSchema", () => {
  it("trims and accepts a non-empty name", () => {
    const parsed = organizationInputSchema.parse({ name: "  Rescue Org  " });
    expect(parsed.name).toBe("Rescue Org");
  });

  it("rejects empty and whitespace-only names", () => {
    expect(organizationInputSchema.safeParse({ name: "" }).success).toBe(false);
    expect(organizationInputSchema.safeParse({ name: "   " }).success).toBe(
      false,
    );
  });
});

describe("memberInputSchema", () => {
  it("normalizes email to trimmed lowercase", () => {
    const parsed = memberInputSchema.parse({
      displayName: "Pat Example",
      email: "  Pat@Example.COM ",
      phone: undefined,
    });
    expect(parsed.email).toBe("pat@example.com");
  });

  it("treats blank email/phone as absent", () => {
    const parsed = memberInputSchema.parse({
      displayName: "Pat Example",
      email: "",
      phone: "  ",
    });
    expect(parsed.email).toBeUndefined();
    expect(parsed.phone).toBeUndefined();
  });

  it("accepts optional contact fields entirely omitted", () => {
    const parsed = memberInputSchema.parse({ displayName: "Pat Example" });
    expect(parsed.email).toBeUndefined();
    expect(parsed.phone).toBeUndefined();
  });

  it("rejects malformed email", () => {
    expect(
      memberInputSchema.safeParse({
        displayName: "Pat",
        email: "not-an-email",
      }).success,
    ).toBe(false);
  });

  it("rejects a blank display name", () => {
    expect(memberInputSchema.safeParse({ displayName: "   " }).success).toBe(
      false,
    );
  });
});

describe("memberStatusSchema", () => {
  it("accepts only ACTIVE/INACTIVE", () => {
    expect(memberStatusSchema.safeParse("ACTIVE").success).toBe(true);
    expect(memberStatusSchema.safeParse("INACTIVE").success).toBe(true);
    expect(memberStatusSchema.safeParse("SUSPENDED").success).toBe(false);
  });
});
