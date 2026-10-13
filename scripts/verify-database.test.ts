import { describe, expect, it } from "vitest";

import {
  assessBaseline,
  isFictionalEmail,
  isProductionHost,
  type BaselineSnapshot,
} from "./verify-database";

const CLEAN: BaselineSnapshot = {
  members: [
    { id: "seed-member", email: "member@example.test" },
    { id: "seed-member-2", email: null },
  ],
  authIdentities: [
    {
      id: "seed-identity",
      provider: "seed",
      providerUid: "seed-fixture",
      email: "seed@example.test",
    },
  ],
  nonSeedCounts: { incident: 0, callout: 0, expense: 0 },
};

describe("isFictionalEmail", () => {
  it("accepts reserved-TLD and example.* addresses", () => {
    for (const email of [
      "member@example.test",
      "seed@anything.invalid",
      "a@b.example",
      "user@example.com",
      "user@example.org",
      "user@example.net",
      "dev@localhost",
    ]) {
      expect(isFictionalEmail(email), email).toBe(true);
    }
  });

  it("rejects real-looking and malformed addresses", () => {
    for (const email of [
      "person@gmail.com",
      "rescuer@example.test.evil.com",
      "not-an-email",
      "@example.test",
      "",
    ]) {
      expect(isFictionalEmail(email), email).toBe(false);
    }
  });

  it("is case-insensitive on the domain", () => {
    expect(isFictionalEmail("Member@Example.TEST")).toBe(true);
  });
});

describe("assessBaseline", () => {
  it("passes a clean seeded baseline", () => {
    expect(assessBaseline(CLEAN)).toEqual([]);
  });

  it("fails on a non-seed member", () => {
    const findings = assessBaseline({
      ...CLEAN,
      members: [{ id: "cmember-abc", email: null }],
    });
    expect(findings.some((f) => f.severity === "fail")).toBe(true);
  });

  it("fails on a member with a real-looking email", () => {
    const findings = assessBaseline({
      ...CLEAN,
      members: [{ id: "seed-member", email: "chief@real-department.gov" }],
    });
    expect(
      findings.some(
        (f) => f.severity === "fail" && f.message.includes("email"),
      ),
    ).toBe(true);
  });

  it("fails on a non-seed sign-in identity", () => {
    const findings = assessBaseline({
      ...CLEAN,
      authIdentities: [
        {
          id: "cuid-real",
          provider: "firebase",
          providerUid: "firebase-uid-1",
          email: "seed@example.test",
        },
      ],
    });
    expect(findings.some((f) => f.severity === "fail")).toBe(true);
  });

  it("warns when no members exist at all", () => {
    const findings = assessBaseline({ ...CLEAN, members: [] });
    expect(
      findings.some(
        (f) => f.severity === "warn" && /no Member/.test(f.message),
      ),
    ).toBe(true);
  });

  it("warns on non-seed operational history rows", () => {
    const findings = assessBaseline({
      ...CLEAN,
      nonSeedCounts: { incident: 3, callout: 0, expense: 1 },
    });
    expect(findings.every((f) => f.severity === "warn")).toBe(true);
    expect(findings.map((f) => f.message).join(" ")).toContain("incident");
    expect(findings.map((f) => f.message).join(" ")).toContain("expense");
    expect(findings.map((f) => f.message).join(" ")).not.toContain("callout:");
  });
});

describe("isProductionHost", () => {
  it("matches normalized pooled/unpooled production hosts", () => {
    expect(
      isProductionHost(
        "ep-prod-pooler.us-east-2.aws.neon.tech",
        "ep-prod.us-east-2.aws.neon.tech",
      ),
    ).toBe(true);
  });

  it("is case- and trailing-dot-insensitive", () => {
    expect(
      isProductionHost(
        "EP-PROD.US-EAST-2.AWS.NEON.TECH.",
        "ep-prod.us-east-2.aws.neon.tech",
      ),
    ).toBe(true);
  });

  it("never matches when the reference host is unset", () => {
    expect(isProductionHost("ep-prod.example.com", undefined)).toBe(false);
  });

  it("does not match a different host", () => {
    expect(
      isProductionHost(
        "ep-prev.us-east-2.aws.neon.tech",
        "ep-prod.us-east-2.aws.neon.tech",
      ),
    ).toBe(false);
  });
});
