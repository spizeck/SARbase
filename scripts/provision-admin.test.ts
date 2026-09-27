import { describe, expect, it } from "vitest";

import { parseProvisionArgs } from "./provision-admin";

describe("parseProvisionArgs", () => {
  it("requires --org and one identity selector", () => {
    expect(() => parseProvisionArgs([])).toThrow("--org");
    expect(() => parseProvisionArgs(["--org", "Org"])).toThrow("--uid");
  });

  it("accepts --org + --uid", () => {
    expect(parseProvisionArgs(["--org", "Org", "--uid", "abc"])).toEqual({
      org: "Org",
      uid: "abc",
      email: undefined,
      create: false,
    });
  });

  it("accepts --org + --email + --create", () => {
    expect(
      parseProvisionArgs(["--org", "Org", "--email", "a@b.c", "--create"]),
    ).toEqual({ org: "Org", uid: undefined, email: "a@b.c", create: true });
  });

  it("rejects --uid and --email together", () => {
    expect(() =>
      parseProvisionArgs(["--org", "O", "--uid", "u", "--email", "e@e.e"]),
    ).toThrow("not both");
  });

  it("rejects unknown flags", () => {
    expect(() =>
      parseProvisionArgs(["--org", "O", "--uid", "u", "--wat"]),
    ).toThrow("Unknown argument");
  });
});
