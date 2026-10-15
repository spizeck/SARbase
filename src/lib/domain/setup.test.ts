import { describe, expect, it } from "vitest";

import { computeSetupChecklist } from "./setup";

const base = {
  organizationId: "org_1",
  settingsReviewedAt: null as Date | null,
  dismissedAt: null as Date | null,
  units: 0,
  members: 0,
  storageLocations: 0,
  vendors: 0,
  assets: 0,
  qualificationDefinitions: 0,
};

describe("computeSetupChecklist", () => {
  it("starts a freshly provisioned organization with nothing done", () => {
    const setup = computeSetupChecklist(base);
    expect(setup.complete).toBe(false);
    expect(setup.dismissed).toBe(false);
    expect(setup.doneCount).toBe(0);
    expect(setup.totalCount).toBe(setup.items.length);
  });

  it("marks settings reviewed only after an explicit settings save", () => {
    // The checklist dismissal write bumps updatedAt — it must NOT be
    // readable as "settings reviewed"; only the dedicated column is.
    const saved = computeSetupChecklist({
      ...base,
      settingsReviewedAt: new Date("2026-10-01T00:02:00.000Z"),
    });
    expect(saved.items.find((i) => i.id === "settings")?.done).toBe(true);
    expect(
      computeSetupChecklist(base).items.find((i) => i.id === "settings")?.done,
    ).toBe(false);
  });

  it("marks record-dependent items done from counts", () => {
    const setup = computeSetupChecklist({
      ...base,
      members: 3,
      assets: 1,
      storageLocations: 2,
    });
    const byId = Object.fromEntries(setup.items.map((i) => [i.id, i]));
    expect(byId.members?.done).toBe(true);
    expect(byId.assets?.done).toBe(true);
    expect(byId.locations?.done).toBe(true);
    expect(byId.units?.done).toBe(false);
    expect(byId.vendors?.done).toBe(false);
  });

  it("labels optional structure so nothing demands it", () => {
    const setup = computeSetupChecklist(base);
    const optionalIds = setup.items.filter((i) => i.optional).map((i) => i.id);
    expect(optionalIds.sort()).toEqual(["qualifications", "units", "vendors"]);
  });

  it("reports dismissed and complete states", () => {
    const dismissed = computeSetupChecklist({
      ...base,
      dismissedAt: new Date("2026-10-02T00:00:00.000Z"),
    });
    expect(dismissed.dismissed).toBe(true);

    const complete = computeSetupChecklist({
      ...base,
      settingsReviewedAt: new Date("2026-10-01T01:00:00.000Z"),
      units: 1,
      members: 5,
      storageLocations: 1,
      vendors: 1,
      assets: 2,
      qualificationDefinitions: 2,
    });
    expect(complete.complete).toBe(true);
    expect(complete.doneCount).toBe(complete.totalCount);
  });

  it("links every item to a real admin route or page anchor", () => {
    const setup = computeSetupChecklist(base);
    for (const item of setup.items) {
      expect(item.href).toMatch(/^\/admin\/organizations\/org_1/);
    }
  });
});
