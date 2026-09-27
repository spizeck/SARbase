import { describe, expect, it } from "vitest";

import { buildScopeTags } from "./scope";

describe("buildScopeTags", () => {
  it("emits deployment facts only", () => {
    const tags = buildScopeTags({
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_SHA: "abcdef1234567890",
      VERCEL_REGION: "iad1",
    });
    expect(tags).toEqual({
      environment: "production",
      commit: "abcdef123456",
      region: "iad1",
    });
  });

  it("falls back to NODE_ENV and omits absent deployment facts", () => {
    expect(buildScopeTags({ NODE_ENV: "test" })).toEqual({
      environment: "test",
    });
  });
});
