import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { createOrganization } from "@/lib/domain/organization";
import { createUnit } from "@/lib/domain/unit";
import {
  AssetHierarchyError,
  createAsset,
  createInventoryItem,
  createStorageLocation,
  CrossOrganizationAssetError,
  listStorageLocations,
  updateAsset,
  updateInventoryItem,
  updateStorageLocation,
} from "@/lib/domain/assets";

/**
 * Database-backed asset/inventory tests — `npm run test:db` only.
 * Distinct prefix: files may run on parallel workers, so cleanup must
 * never touch another suite's fixtures.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "assettest-";

let counter = 0;
function uniqueName(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

async function createTestOrg(suffix = "org") {
  return createOrganization({ name: uniqueName(suffix) });
}

describe.skipIf(!hasDb)("assets / inventory / locations", () => {
  afterAll(async () => {
    const orgFilter = { organization: { name: { startsWith: PREFIX } } };
    await prisma.inventoryItem.deleteMany({ where: orgFilter });
    // Break self-referential/container edges before deleting parents.
    await prisma.asset.updateMany({
      where: orgFilter,
      data: {
        parentAssetId: null,
        storageLocationId: null,
        unitId: null,
      },
    });
    // Locations can hang off assets — clear container edges before
    // deleting assets (Restrict would otherwise refuse).
    await prisma.storageLocation.updateMany({
      where: orgFilter,
      data: { parentLocationId: null, containingAssetId: null },
    });
    await prisma.asset.deleteMany({ where: orgFilter });
    await prisma.storageLocation.deleteMany({ where: orgFilter });
    await prisma.unit.deleteMany({ where: orgFilter });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  describe("storage locations", () => {
    it("creates top-level and nested locations", async () => {
      const org = await createTestOrg("loc");
      const building = await createStorageLocation(org.id, {
        name: uniqueName("building"),
        status: "ACTIVE",
      });
      expect(building.parentLocationId).toBeNull();
      expect(building.containingAssetId).toBeNull();

      const shelf = await createStorageLocation(org.id, {
        name: uniqueName("shelf"),
        parentLocationId: building.id,
        status: "ACTIVE",
      });
      expect(shelf.parentLocationId).toBe(building.id);
    });

    it("creates a location inside an asset (a vessel locker)", async () => {
      const org = await createTestOrg("loc-asset");
      const boat = await createAsset(org.id, {
        name: uniqueName("boat"),
        status: "ACTIVE",
        condition: "UNKNOWN",
      });
      const locker = await createStorageLocation(org.id, {
        name: uniqueName("forward-locker"),
        containingAssetId: boat.id,
        status: "ACTIVE",
      });
      expect(locker.containingAssetId).toBe(boat.id);
      expect(locker.parentLocationId).toBeNull();
    });

    it("rejects a location with both a parent location and an asset", async () => {
      const org = await createTestOrg("loc-xor");
      const parent = await createStorageLocation(org.id, {
        name: uniqueName("parent"),
        status: "ACTIVE",
      });
      const asset = await createAsset(org.id, {
        name: uniqueName("container"),
        status: "ACTIVE",
        condition: "UNKNOWN",
      });
      await expect(
        createStorageLocation(org.id, {
          name: uniqueName("dual"),
          parentLocationId: parent.id,
          containingAssetId: asset.id,
          status: "ACTIVE",
        }),
      ).rejects.toThrow(AssetHierarchyError);
    });

    it("rejects a cross-organization parent location", async () => {
      const orgA = await createTestOrg("loc-xa");
      const orgB = await createTestOrg("loc-xb");
      const foreign = await createStorageLocation(orgB.id, {
        name: uniqueName("foreign"),
        status: "ACTIVE",
      });
      await expect(
        createStorageLocation(orgA.id, {
          name: uniqueName("child"),
          parentLocationId: foreign.id,
          status: "ACTIVE",
        }),
      ).rejects.toThrow(CrossOrganizationAssetError);

      // Database backstop: inserting the pair raw violates the
      // composite FK even if application checks were bypassed.
      await expect(
        prisma.storageLocation.create({
          data: {
            organizationId: orgA.id,
            parentLocationId: foreign.id,
            name: uniqueName("raw"),
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("rejects a cross-organization containing asset", async () => {
      const orgA = await createTestOrg("loc-ca");
      const orgB = await createTestOrg("loc-cb");
      const foreignAsset = await createAsset(orgB.id, {
        name: uniqueName("foreign-boat"),
        status: "ACTIVE",
        condition: "UNKNOWN",
      });
      await expect(
        createStorageLocation(orgA.id, {
          name: uniqueName("locker"),
          containingAssetId: foreignAsset.id,
          status: "ACTIVE",
        }),
      ).rejects.toThrow(CrossOrganizationAssetError);
    });

    it("rejects self-parenting and prevents cycles", async () => {
      const org = await createTestOrg("loc-cycle");
      const a = await createStorageLocation(org.id, {
        name: uniqueName("a"),
        status: "ACTIVE",
      });
      const b = await createStorageLocation(org.id, {
        name: uniqueName("b"),
        parentLocationId: a.id,
        status: "ACTIVE",
      });
      const c = await createStorageLocation(org.id, {
        name: uniqueName("c"),
        parentLocationId: b.id,
        status: "ACTIVE",
      });

      // Self-parent
      await expect(
        updateStorageLocation(a.id, {
          name: a.name,
          parentLocationId: a.id,
          status: "ACTIVE",
        }),
      ).rejects.toThrow(AssetHierarchyError);

      // A > B > C exists; putting A under C would close a cycle.
      await expect(
        updateStorageLocation(a.id, {
          name: a.name,
          parentLocationId: c.id,
          status: "ACTIVE",
        }),
      ).rejects.toThrow(AssetHierarchyError);

      // But moving C under A directly is fine (no cycle).
      const moved = await updateStorageLocation(c.id, {
        name: c.name,
        parentLocationId: a.id,
        status: "ACTIVE",
      });
      expect(moved.parentLocationId).toBe(a.id);
    });

    it("rejects a location nested inside an asset it transitively contains", async () => {
      const org = await createTestOrg("loc-union");
      const boat = await createAsset(org.id, {
        name: uniqueName("vessel"),
        status: "ACTIVE",
        condition: "UNKNOWN",
      });
      const locker = await createStorageLocation(org.id, {
        name: uniqueName("locker"),
        containingAssetId: boat.id,
        status: "ACTIVE",
      });
      const toolbox = await createAsset(org.id, {
        name: uniqueName("toolbox"),
        storageLocationId: locker.id,
        status: "ACTIVE",
        condition: "UNKNOWN",
      });

      // Toolbox is inside locker inside boat. Making the boat part of
      // the toolbox (or storing the boat in its own locker) is a cycle
      // across the UNION graph — the domain must reject both.
      await expect(
        updateAsset(boat.id, {
          name: boat.name,
          parentAssetId: toolbox.id,
          status: "ACTIVE",
          condition: "UNKNOWN",
        }),
      ).rejects.toThrow(AssetHierarchyError);
      await expect(
        updateAsset(boat.id, {
          name: boat.name,
          storageLocationId: locker.id,
          status: "ACTIVE",
          condition: "UNKNOWN",
        }),
      ).rejects.toThrow(AssetHierarchyError);
    });

    it("renders deterministic paths including asset containers", async () => {
      const org = await createTestOrg("loc-path");
      const building = await createStorageLocation(org.id, {
        name: "HQ Building",
        status: "ACTIVE",
      });
      const workshop = await createStorageLocation(org.id, {
        name: "Workshop",
        parentLocationId: building.id,
        status: "ACTIVE",
      });
      const shelf = await createStorageLocation(org.id, {
        name: "Shelf A",
        parentLocationId: workshop.id,
        status: "ACTIVE",
      });
      const boat = await createAsset(org.id, {
        name: "Rescue Boat 1",
        storageLocationId: building.id,
        status: "ACTIVE",
        condition: "UNKNOWN",
      });
      const locker = await createStorageLocation(org.id, {
        name: "Forward locker",
        containingAssetId: boat.id,
        status: "ACTIVE",
      });

      const listed = await listStorageLocations(org.id);
      const paths = new Map(listed.map((l) => [l.id, l.path]));
      expect(paths.get(shelf.id)).toBe("HQ Building > Workshop > Shelf A");
      expect(paths.get(locker.id)).toBe(
        "HQ Building > Rescue Boat 1 > Forward locker",
      );
      // Sorted by path: parents precede children deterministically.
      const names = listed.map((l) => l.path);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });

    it("archiving a location preserves it and everything referencing it", async () => {
      const org = await createTestOrg("loc-arch");
      const loc = await createStorageLocation(org.id, {
        name: uniqueName("cage"),
        status: "ACTIVE",
      });
      const asset = await createAsset(org.id, {
        name: uniqueName("stored"),
        storageLocationId: loc.id,
        status: "ACTIVE",
        condition: "UNKNOWN",
      });
      const item = await createInventoryItem(org.id, {
        name: uniqueName("stock"),
        quantity: "4",
        storageLocationId: loc.id,
        status: "ACTIVE",
        condition: "UNKNOWN",
      });

      const archived = await updateStorageLocation(loc.id, {
        name: loc.name,
        status: "ARCHIVED",
      });
      expect(archived.status).toBe("ARCHIVED");

      // References remain — nothing is deleted or re-pointed.
      expect(
        (await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } }))
          .storageLocationId,
      ).toBe(loc.id);
      expect(
        (
          await prisma.inventoryItem.findUniqueOrThrow({
            where: { id: item.id },
          })
        ).storageLocationId,
      ).toBe(loc.id);
    });
  });

  describe("assets", () => {
    it("creates a durable asset with identifiers", async () => {
      const org = await createTestOrg("asset");
      const asset = await createAsset(org.id, {
        name: uniqueName("radio"),
        category: "Radio",
        manufacturer: "Standard Horizon",
        model: "GX1400",
        serialNumber: "SN-1234",
        assetTag: "SAR-0042",
        purchaseDate: new Date("2024-03-15T00:00:00.000Z"),
        vendor: "Chandlery Ltd",
        status: "ACTIVE",
        condition: "GOOD",
        notes: "Fixed mount",
      });
      expect(asset.organizationId).toBe(org.id);
      expect(asset.serialNumber).toBe("SN-1234");
      expect(asset.purchaseDate!.toISOString()).toBe(
        "2024-03-15T00:00:00.000Z",
      );
    });

    it("supports optional same-org unit, location, and parent asset", async () => {
      const org = await createTestOrg("asset-refs");
      const unit = await createUnit(org.id, { name: uniqueName("unit") });
      const loc = await createStorageLocation(org.id, {
        name: uniqueName("bay"),
        status: "ACTIVE",
      });
      const boat = await createAsset(org.id, {
        name: uniqueName("boat"),
        unitId: unit.id,
        storageLocationId: loc.id,
        status: "ACTIVE",
        condition: "UNKNOWN",
      });
      const engine = await createAsset(org.id, {
        name: uniqueName("port-engine"),
        parentAssetId: boat.id,
        status: "ACTIVE",
        condition: "UNKNOWN",
      });
      expect(engine.parentAssetId).toBe(boat.id);
      expect(boat.unitId).toBe(unit.id);
      expect(boat.storageLocationId).toBe(loc.id);
    });

    it("rejects every cross-organization reference", async () => {
      const orgA = await createTestOrg("asset-xa");
      const orgB = await createTestOrg("asset-xb");
      const foreignUnit = await createUnit(orgB.id, {
        name: uniqueName("foreign-unit"),
      });
      const foreignLoc = await createStorageLocation(orgB.id, {
        name: uniqueName("foreign-loc"),
        status: "ACTIVE",
      });
      const foreignAsset = await createAsset(orgB.id, {
        name: uniqueName("foreign-parent"),
        status: "ACTIVE",
        condition: "UNKNOWN",
      });

      for (const bad of [
        { unitId: foreignUnit.id },
        { storageLocationId: foreignLoc.id },
        { parentAssetId: foreignAsset.id },
      ]) {
        await expect(
          createAsset(orgA.id, {
            name: uniqueName("x"),
            status: "ACTIVE",
            condition: "UNKNOWN",
            ...bad,
          }),
        ).rejects.toThrow(CrossOrganizationAssetError);
      }

      // Database backstop — raw insert across orgs violates the
      // composite FKs.
      await expect(
        prisma.asset.create({
          data: {
            organizationId: orgA.id,
            parentAssetId: foreignAsset.id,
            name: uniqueName("raw"),
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("prevents asset parent cycles", async () => {
      const org = await createTestOrg("asset-cycle");
      const boat = await createAsset(org.id, {
        name: uniqueName("boat"),
        status: "ACTIVE",
        condition: "UNKNOWN",
      });
      const engine = await createAsset(org.id, {
        name: uniqueName("engine"),
        parentAssetId: boat.id,
        status: "ACTIVE",
        condition: "UNKNOWN",
      });
      const alternator = await createAsset(org.id, {
        name: uniqueName("alternator"),
        parentAssetId: engine.id,
        status: "ACTIVE",
        condition: "UNKNOWN",
      });

      // Self-parent
      await expect(
        updateAsset(boat.id, {
          name: boat.name,
          parentAssetId: boat.id,
          status: "ACTIVE",
          condition: "UNKNOWN",
        }),
      ).rejects.toThrow(AssetHierarchyError);

      // boat > engine > alternator: parenting boat under alternator
      // closes a cycle.
      await expect(
        updateAsset(boat.id, {
          name: boat.name,
          parentAssetId: alternator.id,
          status: "ACTIVE",
          condition: "UNKNOWN",
        }),
      ).rejects.toThrow(AssetHierarchyError);
    });

    it("enforces the org-scoped asset tag uniquely, with NULLs distinct", async () => {
      const orgA = await createTestOrg("tag-a");
      const orgB = await createTestOrg("tag-b");
      const tag = `TAG-${counter}`;

      await createAsset(orgA.id, {
        name: uniqueName("tagged-1"),
        assetTag: tag,
        status: "ACTIVE",
        condition: "UNKNOWN",
      });
      // Same tag in the same org — rejected (P2002).
      await expect(
        createAsset(orgA.id, {
          name: uniqueName("tagged-2"),
          assetTag: tag,
          status: "ACTIVE",
          condition: "UNKNOWN",
        }),
      ).rejects.toMatchObject({ code: "P2002" });
      // Same tag in another org — fine, orgs are independent.
      await expect(
        createAsset(orgB.id, {
          name: uniqueName("tagged-b"),
          assetTag: tag,
          status: "ACTIVE",
          condition: "UNKNOWN",
        }),
      ).resolves.toMatchObject({ assetTag: tag });
      // Any number of untagged assets coexist — NULLs are distinct.
      for (const n of ["untagged-1", "untagged-2"]) {
        await expect(
          createAsset(orgA.id, {
            name: uniqueName(n),
            status: "ACTIVE",
            condition: "UNKNOWN",
          }),
        ).resolves.toMatchObject({ assetTag: null });
      }
    });

    it("retires an asset without deleting it or its references", async () => {
      const org = await createTestOrg("asset-retire");
      const boat = await createAsset(org.id, {
        name: uniqueName("old-boat"),
        status: "ACTIVE",
        condition: "UNKNOWN",
      });
      const locker = await createStorageLocation(org.id, {
        name: uniqueName("boat-locker"),
        containingAssetId: boat.id,
        status: "ACTIVE",
      });
      const engine = await createAsset(org.id, {
        name: uniqueName("old-engine"),
        parentAssetId: boat.id,
        status: "ACTIVE",
        condition: "UNKNOWN",
      });

      const retired = await updateAsset(boat.id, {
        name: boat.name,
        status: "RETIRED",
        condition: "DAMAGED",
      });
      expect(retired.status).toBe("RETIRED");

      // Child asset and contained location keep their references —
      // history is preserved, not severed.
      expect(
        (await prisma.asset.findUniqueOrThrow({ where: { id: engine.id } }))
          .parentAssetId,
      ).toBe(boat.id);
      expect(
        (
          await prisma.storageLocation.findUniqueOrThrow({
            where: { id: locker.id },
          })
        ).containingAssetId,
      ).toBe(boat.id);
    });
  });

  describe("inventory items", () => {
    it("creates a quantity item with an exact decimal quantity", async () => {
      const org = await createTestOrg("item");
      const loc = await createStorageLocation(org.id, {
        name: uniqueName("shelf"),
        status: "ACTIVE",
      });
      const item = await createInventoryItem(org.id, {
        name: uniqueName("line"),
        category: "Rope",
        quantity: "2.5",
        unitOfMeasure: "rolls",
        vendor: "Ropeworks",
        storageLocationId: loc.id,
        status: "ACTIVE",
        condition: "UNKNOWN",
      });
      expect(item.quantity.toString()).toBe("2.5");
      expect(item.unitOfMeasure).toBe("rolls");
    });

    it("rejects a cross-organization storage location", async () => {
      const orgA = await createTestOrg("item-xa");
      const orgB = await createTestOrg("item-xb");
      const foreignLoc = await createStorageLocation(orgB.id, {
        name: uniqueName("foreign"),
        status: "ACTIVE",
      });
      await expect(
        createInventoryItem(orgA.id, {
          name: uniqueName("item"),
          quantity: "1",
          storageLocationId: foreignLoc.id,
          status: "ACTIVE",
          condition: "UNKNOWN",
        }),
      ).rejects.toThrow(CrossOrganizationAssetError);
      await expect(
        prisma.inventoryItem.create({
          data: {
            organizationId: orgA.id,
            storageLocationId: foreignLoc.id,
            name: uniqueName("raw"),
            quantity: 1,
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("rejects a cross-organization unit", async () => {
      const orgA = await createTestOrg("item-xu-a");
      const orgB = await createTestOrg("item-xu-b");
      const foreignUnit = await createUnit(orgB.id, {
        name: uniqueName("foreign-unit"),
      });
      await expect(
        createInventoryItem(orgA.id, {
          name: uniqueName("item"),
          quantity: "1",
          unitId: foreignUnit.id,
          status: "ACTIVE",
          condition: "UNKNOWN",
        }),
      ).rejects.toThrow(CrossOrganizationAssetError);
    });

    it("updates quantity exactly", async () => {
      const org = await createTestOrg("item-qty");
      const item = await createInventoryItem(org.id, {
        name: uniqueName("flares"),
        quantity: "6",
        unitOfMeasure: "each",
        status: "ACTIVE",
        condition: "UNKNOWN",
      });
      const updated = await updateInventoryItem(item.id, {
        name: item.name,
        quantity: "4",
        unitOfMeasure: "each",
        status: "ACTIVE",
        condition: "UNKNOWN",
      });
      expect(updated.quantity.toString()).toBe("4");
    });

    it("archives an item while preserving the row", async () => {
      const org = await createTestOrg("item-arch");
      const item = await createInventoryItem(org.id, {
        name: uniqueName("batteries"),
        quantity: "12",
        status: "ACTIVE",
        condition: "UNKNOWN",
      });
      const archived = await updateInventoryItem(item.id, {
        name: item.name,
        quantity: "12",
        status: "ARCHIVED",
        condition: "UNKNOWN",
      });
      expect(archived.status).toBe("ARCHIVED");
      expect(
        (
          await prisma.inventoryItem.findUniqueOrThrow({
            where: { id: item.id },
          })
        ).quantity.toString(),
      ).toBe("12");
    });
  });
});
