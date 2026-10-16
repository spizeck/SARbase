import { describe, expect, it } from "vitest";
import { OrgCapability } from "@prisma/client";

import {
  CAPABILITY_REGISTRY,
  ORG_CAPABILITIES,
  STANDARD_MANAGER_CAPABILITIES,
  isOrgCapability,
} from "./capabilities";

/**
 * Registry contract tests (issue #84). The registry is the single
 * source every enforcement point and admin UI reads from — these tests
 * fail if a capability is added to the enum but never registered, if
 * the standard Manager set drifts outside the registry, or if a
 * capability that can never be delegated sneaks in.
 */
describe("capability registry", () => {
  it("registers every OrgCapability enum value exactly once", () => {
    const keys = CAPABILITY_REGISTRY.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(Object.values(OrgCapability).sort());
  });

  it("gives every capability a group, label, and description", () => {
    for (const def of CAPABILITY_REGISTRY) {
      expect(def.label.trim().length).toBeGreaterThan(0);
      expect(def.description.trim().length).toBeGreaterThan(0);
      expect(def.group.trim().length).toBeGreaterThan(0);
    }
  });

  it("never exposes an account-administration capability", () => {
    // Invitations, access grants, identity linking, role/capability
    // edits, and organization settings are ADMIN-only forever — any
    // new enum value matching them must not be registered.
    for (const key of ORG_CAPABILITIES) {
      expect(key).not.toMatch(/ACCESS|INVIT|IDENTITY|ROLE|SETTING/);
    }
  });

  it("keeps the standard Manager set inside the registry", () => {
    expect(STANDARD_MANAGER_CAPABILITIES.length).toBeGreaterThan(0);
    for (const cap of STANDARD_MANAGER_CAPABILITIES) {
      expect(ORG_CAPABILITIES).toContain(cap);
    }
  });

  it("excludes authority capabilities from the standard set", () => {
    // Verification and money-approval are explicit grants, never part
    // of the default bundle.
    expect(STANDARD_MANAGER_CAPABILITIES).not.toContain(
      OrgCapability.QUALIFICATIONS_VERIFY,
    );
    expect(STANDARD_MANAGER_CAPABILITIES).not.toContain(
      OrgCapability.FINANCE_MANAGE,
    );
    expect(STANDARD_MANAGER_CAPABILITIES).not.toContain(
      OrgCapability.FINANCE_APPROVE,
    );
  });
});

describe("isOrgCapability", () => {
  it("accepts every registered capability", () => {
    for (const cap of ORG_CAPABILITIES) {
      expect(isOrgCapability(cap)).toBe(true);
    }
  });

  it("rejects unknown and non-string input", () => {
    expect(isOrgCapability("ADMIN")).toBe(false);
    expect(isOrgCapability("operations.manage")).toBe(false);
    expect(isOrgCapability("")).toBe(false);
    expect(isOrgCapability(null)).toBe(false);
    expect(isOrgCapability(42)).toBe(false);
    expect(isOrgCapability({ key: "EQUIPMENT_MANAGE" })).toBe(false);
  });
});
