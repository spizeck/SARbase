import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { log } from "@/lib/logging";

import type {
  AssetInput,
  InventoryItemInput,
  StorageLocationInput,
} from "./schemas";

/**
 * Assets, inventory, and storage locations (issue #10).
 *
 * PRODUCT BOUNDARY: these are factual administrative records only.
 * "Radio serial 1234 in the forward locker", "3 rolls of line in
 * Workshop > Shelf A", "human recorded condition: damaged". Nothing
 * here infers seaworthiness, unit readiness, inventory sufficiency, or
 * launch decisions — humans decide operational meaning.
 *
 * Two record families, deliberately not unified:
 * - Asset — a durable, individually identifiable item (boat, engine,
 *   AED). Optional serial/tag/manufacturer/model, lifecycle status,
 *   condition, storage location, and physical parent-child containment
 *   (an engine is part of a boat; both keep independent identities).
 * - InventoryItem — a quantity-tracked stock item (rope, flares,
 *   gloves). Exact DECIMAL quantity + free-text unit of measure; no
 *   lot tracking, reorder points, or stock transactions.
 * - StorageLocation — an arbitrarily nested place. A location has ONE
 *   container: a parent location OR an asset it sits inside ("Forward
 *   locker" inside "Rescue Boat 1"), never both.
 *
 * Same-organization integrity uses the established pattern —
 * denormalized organizationId + composite foreign keys — so a
 * cross-org parent/location/unit pairing is impossible at the database
 * level. The location-container XOR is enforced at both layers: the
 * "StorageLocation_single_container" CHECK constraint rejects a
 * dual-container row outright, and the domain rejects it first for a
 * friendly error. Hierarchy cycles cannot be expressed as constraints;
 * the domain enforces them via a union-DFS ancestor walk over the
 * container graph (location→parentLocation|containingAsset,
 * asset→storageLocation|parentAsset), and every containment-edge write
 * runs under a per-organization advisory lock (withContainmentLock) so
 * concurrent writers serialize instead of racing the read-then-write
 * check.
 */

export class CrossOrganizationAssetError extends Error {
  constructor() {
    super("Asset records can only reference same-organization records.");
    this.name = "CrossOrganizationAssetError";
  }
}

export class AssetHierarchyError extends Error {
  constructor(message = "That placement would create a cycle.") {
    super(message);
    this.name = "AssetHierarchyError";
  }
}

/* ------------------------------------------------------------------ */
/* Container graph — paths and cycle safety                            */
/* ------------------------------------------------------------------ */

type LocationNode = {
  id: string;
  name: string;
  parentLocationId: string | null;
  containingAssetId: string | null;
};
type AssetNode = {
  id: string;
  name: string;
  storageLocationId: string | null;
  parentAssetId: string | null;
};

interface ContainerIndex {
  locations: Map<string, LocationNode>;
  assets: Map<string, AssetNode>;
}

type NodeKey = `location:${string}` | `asset:${string}`;

const locationKey = (id: string): NodeKey => `location:${id}`;
const assetKey = (id: string): NodeKey => `asset:${id}`;

/** Out-edges of a node in the "is inside / is part of" graph. */
function outEdges(index: ContainerIndex, node: NodeKey): NodeKey[] {
  if (node.startsWith("location:")) {
    const loc = index.locations.get(node.slice(9));
    if (!loc) return [];
    return [
      ...(loc.parentLocationId ? [locationKey(loc.parentLocationId)] : []),
      ...(loc.containingAssetId ? [assetKey(loc.containingAssetId)] : []),
    ];
  }
  const asset = index.assets.get(node.slice(6));
  if (!asset) return [];
  return [
    ...(asset.storageLocationId ? [locationKey(asset.storageLocationId)] : []),
    ...(asset.parentAssetId ? [assetKey(asset.parentAssetId)] : []),
  ];
}

/**
 * Every node reachable from `start` by following containment edges —
 * i.e. everything `start` is transitively inside or part of. Union DFS
 * over both edge kinds is deliberately conservative: it rejects any
 * placement that could create a cycle in EITHER the location-nesting
 * or the asset-parenting relation, and the visited set makes the walk
 * itself immune to pre-existing bad data.
 */
function collectAncestors(index: ContainerIndex, start: NodeKey) {
  const seen = new Set<NodeKey>([start]);
  const stack = [start];
  while (stack.length) {
    for (const next of outEdges(index, stack.pop()!)) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

async function loadContainerIndex(
  organizationId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<ContainerIndex> {
  const [locations, assets] = await Promise.all([
    db.storageLocation.findMany({
      where: { organizationId },
      select: {
        id: true,
        name: true,
        parentLocationId: true,
        containingAssetId: true,
      },
    }),
    db.asset.findMany({
      where: { organizationId },
      select: {
        id: true,
        name: true,
        storageLocationId: true,
        parentAssetId: true,
      },
    }),
  ]);
  return {
    locations: new Map(locations.map((l) => [l.id, l])),
    assets: new Map(assets.map((a) => [a.id, a])),
  };
}

/**
 * Render "SAR Building > Workshop > Shelf A > Cabinet 2" — or, for a
 * location inside an asset, "... > Rescue Boat 1 > Forward locker".
 * Deterministic and cycle-safe: the visited set terminates the walk
 * even if bad data exists; a broken ancestor simply ends the path.
 */
export function locationPathFromIndex(
  index: ContainerIndex,
  locationId: string,
): string {
  const parts: string[] = [];
  const seen = new Set<NodeKey>();
  let node: NodeKey | undefined = locationKey(locationId);
  while (node && !seen.has(node)) {
    seen.add(node);
    if (node.startsWith("location:")) {
      const loc = index.locations.get(node.slice(9));
      if (!loc) break;
      parts.unshift(loc.name);
      node = loc.parentLocationId
        ? locationKey(loc.parentLocationId)
        : loc.containingAssetId
          ? assetKey(loc.containingAssetId)
          : undefined;
    } else {
      const asset = index.assets.get(node.slice(6));
      if (!asset) break;
      parts.unshift(asset.name);
      node = asset.storageLocationId
        ? locationKey(asset.storageLocationId)
        : asset.parentAssetId
          ? assetKey(asset.parentAssetId)
          : undefined;
    }
  }
  return parts.join(" > ");
}

/* ------------------------------------------------------------------ */
/* Containment-graph write serialization                               */
/* ------------------------------------------------------------------ */

/**
 * Run a containment-graph mutation while holding this organization's
 * transaction-scoped PostgreSQL advisory lock. The union-DFS cycle
 * check is read-then-write: without serialization, two concurrent
 * admins could each validate against the same stale graph and commit a
 * cycle (A placed inside B while B is placed inside A).
 *
 * pg_advisory_xact_lock serializes the graph read + cycle check +
 * write per organization — hashtextextended maps the org id to a
 * stable bigint key (collisions merely over-serialize, never
 * under-serialize) — is released automatically on commit or rollback,
 * and holds across serverless/server instances where an in-process
 * mutex would not. It is deliberately org-scoped: writers in other
 * organizations never wait. Reads and InventoryItem writes stay
 * unlocked — items are graph leaves, never containers.
 */
export async function withContainmentLock<T>(
  organizationId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // pg_advisory_xact_lock returns void — $executeRaw avoids the
    // $queryRaw deserialization that void would break.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${"sarbase:containment:" + organizationId}, 0)
      )
    `;
    return fn(tx);
  });
}

/* ------------------------------------------------------------------ */
/* Reference validation                                                */
/* ------------------------------------------------------------------ */

async function assertSameOrgRefs(
  organizationId: string,
  input: {
    unitId?: string;
    storageLocationId?: string;
    parentAssetId?: string;
    parentLocationId?: string;
    containingAssetId?: string;
  },
  db: Prisma.TransactionClient = prisma,
) {
  const checks: [string | undefined, () => Promise<boolean>][] = [
    [
      input.unitId,
      async () =>
        (await db.unit.count({
          where: { id: input.unitId, organizationId },
        })) === 1,
    ],
    [
      input.storageLocationId,
      async () =>
        (await db.storageLocation.count({
          where: { id: input.storageLocationId, organizationId },
        })) === 1,
    ],
    [
      input.parentAssetId,
      async () =>
        (await db.asset.count({
          where: { id: input.parentAssetId, organizationId },
        })) === 1,
    ],
    [
      input.parentLocationId,
      async () =>
        (await db.storageLocation.count({
          where: { id: input.parentLocationId, organizationId },
        })) === 1,
    ],
    [
      input.containingAssetId,
      async () =>
        (await db.asset.count({
          where: { id: input.containingAssetId, organizationId },
        })) === 1,
    ],
  ];
  for (const [id, check] of checks) {
    if (id && !(await check())) throw new CrossOrganizationAssetError();
  }
}

/**
 * Reject a placement if `nodeKey` (the record being placed) would end
 * up inside itself: for each proposed container, its transitive
 * ancestors must not include the record being moved.
 */
function assertNoContainmentCycle(
  index: ContainerIndex,
  nodeKey: NodeKey,
  containers: NodeKey[],
) {
  for (const target of containers) {
    if (target === nodeKey || collectAncestors(index, target).has(nodeKey)) {
      throw new AssetHierarchyError();
    }
  }
}

/* ------------------------------------------------------------------ */
/* StorageLocation                                                     */
/* ------------------------------------------------------------------ */

const locationInclude = {
  parentLocation: { select: { id: true, name: true } },
  containingAsset: { select: { id: true, name: true } },
  _count: {
    select: {
      childLocations: true,
      storedAssets: true,
      inventoryItems: true,
    },
  },
} satisfies Prisma.StorageLocationInclude;

/**
 * All locations of an organization with a computed display path
 * ("SAR Building > Workshop > Shelf A"), sorted by path so parents
 * precede children deterministically.
 */
export async function listStorageLocations(organizationId: string) {
  const [index, locations] = await Promise.all([
    loadContainerIndex(organizationId),
    prisma.storageLocation.findMany({
      where: { organizationId },
      include: locationInclude,
    }),
  ]);
  return locations
    .map((loc) => ({ ...loc, path: locationPathFromIndex(index, loc.id) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Paths keyed by location id — shared by asset/inventory lists so each
 * row can show where it lives without N+1 queries.
 */
export async function locationPathMap(organizationId: string) {
  const index = await loadContainerIndex(organizationId);
  const map = new Map<string, string>();
  for (const id of index.locations.keys()) {
    map.set(id, locationPathFromIndex(index, id));
  }
  return map;
}

export function getStorageLocation(id: string) {
  return prisma.storageLocation.findUnique({
    where: { id },
    include: locationInclude,
  });
}

export async function createStorageLocation(
  organizationId: string,
  input: StorageLocationInput,
) {
  // Fast-fail before locking — the XOR is also backed by the
  // StorageLocation_single_container CHECK constraint, so a dual
  // container can never be persisted even if this check is bypassed.
  if (input.parentLocationId && input.containingAssetId) {
    throw new AssetHierarchyError(
      "A location sits inside either a parent location or an asset — not both.",
    );
  }
  return withContainmentLock(organizationId, async (tx) => {
    await assertSameOrgRefs(organizationId, input, tx);
    const location = await tx.storageLocation.create({
      data: {
        organizationId,
        parentLocationId: input.parentLocationId ?? null,
        containingAssetId: input.containingAssetId ?? null,
        name: input.name,
        description: input.description ?? null,
        status: input.status,
      },
    });
    log({
      event: "asset.location_created",
      subsystem: "domain",
      entityType: "StorageLocation",
      entityId: location.id,
      organizationId,
    });
    return location;
  });
}

export async function updateStorageLocation(
  id: string,
  input: StorageLocationInput,
) {
  const existing = await prisma.storageLocation.findUniqueOrThrow({
    where: { id },
    select: { organizationId: true },
  });
  if (input.parentLocationId && input.containingAssetId) {
    throw new AssetHierarchyError(
      "A location sits inside either a parent location or an asset — not both.",
    );
  }
  if (input.parentLocationId === id) {
    throw new AssetHierarchyError("A location cannot contain itself.");
  }
  const organizationId = existing.organizationId;
  // Validate + check + write under the org's advisory lock: a
  // concurrent placement re-reads the graph only after the earlier
  // writer commits, so a second placement that would close a cycle
  // always sees the committed edge and rejects cleanly.
  return withContainmentLock(organizationId, async (tx) => {
    await assertSameOrgRefs(organizationId, input, tx);

    const index = await loadContainerIndex(organizationId, tx);
    assertNoContainmentCycle(
      index,
      locationKey(id),
      [
        input.parentLocationId && locationKey(input.parentLocationId),
        input.containingAssetId && assetKey(input.containingAssetId),
      ].filter(Boolean) as NodeKey[],
    );

    const location = await tx.storageLocation.update({
      where: { id },
      data: {
        parentLocationId: input.parentLocationId ?? null,
        containingAssetId: input.containingAssetId ?? null,
        name: input.name,
        description: input.description ?? null,
        status: input.status,
      },
    });
    log({
      event: "asset.location_updated",
      subsystem: "domain",
      entityType: "StorageLocation",
      entityId: location.id,
      organizationId,
    });
    return location;
  });
}

/* ------------------------------------------------------------------ */
/* Asset                                                               */
/* ------------------------------------------------------------------ */

const assetInclude = {
  unit: { select: { id: true, name: true } },
  storageLocation: { select: { id: true, name: true } },
  parentAsset: { select: { id: true, name: true } },
  _count: { select: { childAssets: true, containedLocations: true } },
} satisfies Prisma.AssetInclude;

export function listAssets(
  organizationId: string,
  options: {
    unitId?: string | null;
    storageLocationId?: string;
    status?: "ACTIVE" | "INACTIVE" | "OUT_OF_SERVICE" | "RETIRED";
    includeRetired?: boolean;
  } = {},
) {
  return prisma.asset.findMany({
    where: {
      organizationId,
      ...(options.status
        ? { status: options.status }
        : options.includeRetired
          ? {}
          : { status: { not: "RETIRED" } }),
      ...(options.unitId === undefined ? {} : { unitId: options.unitId }),
      ...(options.storageLocationId
        ? { storageLocationId: options.storageLocationId }
        : {}),
    },
    orderBy: { name: "asc" },
    include: assetInclude,
  });
}

export function getAsset(id: string) {
  return prisma.asset.findUnique({
    where: { id },
    include: {
      ...assetInclude,
      childAssets: { orderBy: { name: "asc" }, include: assetInclude },
      containedLocations: {
        orderBy: { name: "asc" },
        select: { id: true, name: true, status: true },
      },
    },
  });
}

export async function createAsset(organizationId: string, input: AssetInput) {
  // A fresh node can't close a cycle (nothing references it yet), but
  // the create still writes containment edges — keep every edge write
  // under the same per-organization serialization.
  return withContainmentLock(organizationId, async (tx) => {
    await assertSameOrgRefs(organizationId, input, tx);
    const asset = await tx.asset.create({
      data: {
        organizationId,
        unitId: input.unitId ?? null,
        parentAssetId: input.parentAssetId ?? null,
        storageLocationId: input.storageLocationId ?? null,
        name: input.name,
        category: input.category ?? null,
        manufacturer: input.manufacturer ?? null,
        model: input.model ?? null,
        serialNumber: input.serialNumber ?? null,
        assetTag: input.assetTag ?? null,
        purchaseDate: input.purchaseDate ?? null,
        vendor: input.vendor ?? null,
        status: input.status,
        condition: input.condition,
        notes: input.notes ?? null,
      },
    });
    log({
      event: "asset.created",
      subsystem: "domain",
      entityType: "Asset",
      entityId: asset.id,
      organizationId,
    });
    return asset;
  });
}

export async function updateAsset(id: string, input: AssetInput) {
  const existing = await prisma.asset.findUniqueOrThrow({
    where: { id },
    select: { organizationId: true },
  });
  if (input.parentAssetId === id) {
    throw new AssetHierarchyError("An asset cannot be its own parent.");
  }
  const organizationId = existing.organizationId;
  return withContainmentLock(organizationId, async (tx) => {
    await assertSameOrgRefs(organizationId, input, tx);

    // Cycle check: the new storage location / parent asset must not
    // already sit inside this asset (transitively). Runs under the
    // org lock, so the graph read reflects every committed placement.
    const index = await loadContainerIndex(organizationId, tx);
    assertNoContainmentCycle(
      index,
      assetKey(id),
      [
        input.storageLocationId && locationKey(input.storageLocationId),
        input.parentAssetId && assetKey(input.parentAssetId),
      ].filter(Boolean) as NodeKey[],
    );

    const asset = await tx.asset.update({
      where: { id },
      data: {
        unitId: input.unitId ?? null,
        parentAssetId: input.parentAssetId ?? null,
        storageLocationId: input.storageLocationId ?? null,
        name: input.name,
        category: input.category ?? null,
        manufacturer: input.manufacturer ?? null,
        model: input.model ?? null,
        serialNumber: input.serialNumber ?? null,
        assetTag: input.assetTag ?? null,
        purchaseDate: input.purchaseDate ?? null,
        vendor: input.vendor ?? null,
        status: input.status,
        condition: input.condition,
        notes: input.notes ?? null,
      },
    });
    log({
      event: "asset.updated",
      subsystem: "domain",
      entityType: "Asset",
      entityId: asset.id,
      organizationId,
    });
    return asset;
  });
}

/* ------------------------------------------------------------------ */
/* InventoryItem                                                       */
/* ------------------------------------------------------------------ */

const itemInclude = {
  unit: { select: { id: true, name: true } },
  storageLocation: { select: { id: true, name: true } },
} satisfies Prisma.InventoryItemInclude;

export function listInventoryItems(
  organizationId: string,
  options: {
    storageLocationId?: string;
    status?: "ACTIVE" | "ARCHIVED";
    includeArchived?: boolean;
  } = {},
) {
  return prisma.inventoryItem.findMany({
    where: {
      organizationId,
      ...(options.status
        ? { status: options.status }
        : options.includeArchived
          ? {}
          : { status: "ACTIVE" }),
      ...(options.storageLocationId
        ? { storageLocationId: options.storageLocationId }
        : {}),
    },
    orderBy: { name: "asc" },
    include: itemInclude,
  });
}

export function getInventoryItem(id: string) {
  return prisma.inventoryItem.findUnique({
    where: { id },
    include: itemInclude,
  });
}

export async function createInventoryItem(
  organizationId: string,
  input: InventoryItemInput,
) {
  await assertSameOrgRefs(organizationId, input);
  const item = await prisma.inventoryItem.create({
    data: {
      organizationId,
      unitId: input.unitId ?? null,
      storageLocationId: input.storageLocationId ?? null,
      name: input.name,
      category: input.category ?? null,
      // Exact decimal — never a float; validated to ≤3 decimal places.
      quantity: new Prisma.Decimal(input.quantity),
      unitOfMeasure: input.unitOfMeasure ?? null,
      vendor: input.vendor ?? null,
      condition: input.condition,
      status: input.status,
      notes: input.notes ?? null,
    },
  });
  log({
    event: "asset.item_created",
    subsystem: "domain",
    entityType: "InventoryItem",
    entityId: item.id,
    organizationId,
  });
  return item;
}

export async function updateInventoryItem(
  id: string,
  input: InventoryItemInput,
) {
  const existing = await prisma.inventoryItem.findUniqueOrThrow({
    where: { id },
    select: { organizationId: true },
  });
  await assertSameOrgRefs(existing.organizationId, input);
  const item = await prisma.inventoryItem.update({
    where: { id },
    data: {
      unitId: input.unitId ?? null,
      storageLocationId: input.storageLocationId ?? null,
      name: input.name,
      category: input.category ?? null,
      quantity: new Prisma.Decimal(input.quantity),
      unitOfMeasure: input.unitOfMeasure ?? null,
      vendor: input.vendor ?? null,
      condition: input.condition,
      status: input.status,
      notes: input.notes ?? null,
    },
  });
  log({
    event: "asset.item_updated",
    subsystem: "domain",
    entityType: "InventoryItem",
    entityId: item.id,
    organizationId: existing.organizationId,
  });
  return item;
}
