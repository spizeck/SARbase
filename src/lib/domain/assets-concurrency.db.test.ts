import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { createOrganization } from "@/lib/domain/organization";
import {
  AssetHierarchyError,
  createAsset,
  createStorageLocation,
  updateAsset,
  updateStorageLocation,
  withContainmentLock,
} from "@/lib/domain/assets";

/**
 * Concurrency tests for the containment union graph —
 * `npm run test:db` only. The union-DFS cycle check is read-then-write;
 * these tests prove the per-organization pg_advisory_xact_lock makes
 * that sequence mutually exclusive, so two admins racing inverse
 * placements can never both commit a cycle.
 *
 * Deterministic, not timing-based: a control transaction holds the
 * org's advisory lock while both contenders are launched, and the test
 * waits on pg_locks until both contenders are PROVABLY queued on the
 * lock before releasing. No sleeps, no lucky interleavings.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "assetrace-";

let counter = 0;
function uniqueName(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

const assetInput = (name: string) =>
  ({
    name,
    status: "ACTIVE",
    condition: "UNKNOWN",
  }) as const;

/**
 * Advisory-lock waiters in the current database (granted locks
 * excluded — the control's own lock doesn't count). The test database
 * is dedicated, so the only advisory locks present are this suite's.
 */
async function advisoryWaiterCount(): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND NOT granted
      AND database = (SELECT oid FROM pg_database
                      WHERE datname = current_database())
  `;
  return rows[0]!.count;
}

async function waitForWaiters(count: number, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await advisoryWaiterCount()) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for ${count} advisory-lock waiters`);
}

/**
 * Hold an organization's containment lock until `release()`. Resolves
 * `acquired` once the lock is actually held, so callers can launch
 * contenders knowing they will genuinely queue behind it.
 */
function holdContainmentLock(organizationId: string) {
  let release!: () => void;
  let acquired!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const acquiredGate = new Promise<void>((resolve) => (acquired = resolve));
  const done = withContainmentLock(organizationId, async () => {
    acquired();
    await gate;
  });
  return { acquired: acquiredGate, release, done };
}

describe.skipIf(!hasDb)("containment write concurrency", () => {
  afterAll(async () => {
    const orgFilter = { organization: { name: { startsWith: PREFIX } } };
    await prisma.asset.updateMany({
      where: orgFilter,
      data: { parentAssetId: null, storageLocationId: null, unitId: null },
    });
    await prisma.storageLocation.updateMany({
      where: orgFilter,
      data: { parentLocationId: null, containingAssetId: null },
    });
    await prisma.asset.deleteMany({ where: orgFilter });
    await prisma.storageLocation.deleteMany({ where: orgFilter });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  it(
    "serializes opposing asset parentings — exactly one commits",
    { timeout: 30_000 },
    async () => {
      const org = await createOrganization({ name: uniqueName("org") });
      const a = await createAsset(org.id, assetInput(uniqueName("a")));
      const b = await createAsset(org.id, assetInput(uniqueName("b")));

      const lock = holdContainmentLock(org.id);
      await lock.acquired;

      // Race: A inside B while B inside A. Both contenders provably
      // queued on the org lock before either can proceed.
      const attemptA = updateAsset(a.id, {
        ...assetInput(a.name),
        parentAssetId: b.id,
      });
      const attemptB = updateAsset(b.id, {
        ...assetInput(b.name),
        parentAssetId: a.id,
      });
      try {
        await waitForWaiters(2);
      } finally {
        lock.release();
      }
      const [ra, rb] = await Promise.allSettled([attemptA, attemptB]);
      await lock.done;

      // Exactly one placement wins; the loser re-reads the graph after
      // the winner commits and is rejected as a cycle.
      const statuses = [ra.status, rb.status].sort();
      expect(statuses).toEqual(["fulfilled", "rejected"]);
      const loser = [ra, rb].find((r) => r.status === "rejected");
      expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(
        AssetHierarchyError,
      );

      // Both edges must never be committed simultaneously.
      const [fa, fb] = await Promise.all([
        prisma.asset.findUniqueOrThrow({ where: { id: a.id } }),
        prisma.asset.findUniqueOrThrow({ where: { id: b.id } }),
      ]);
      expect(
        [fa.parentAssetId === b.id, fb.parentAssetId === a.id].filter(Boolean),
      ).toHaveLength(1);
    },
  );

  it(
    "keeps the union graph acyclic across an asset/location race",
    { timeout: 30_000 },
    async () => {
      const org = await createOrganization({ name: uniqueName("org") });
      const boat = await createAsset(org.id, assetInput(uniqueName("boat")));
      // Boat contains the locker; shelf is an unrelated location.
      const locker = await createStorageLocation(org.id, {
        name: uniqueName("locker"),
        containingAssetId: boat.id,
        status: "ACTIVE",
      });
      const shelf = await createStorageLocation(org.id, {
        name: uniqueName("shelf"),
        status: "ACTIVE",
      });

      const lock = holdContainmentLock(org.id);
      await lock.acquired;

      // Race: move the locker out of the boat onto the shelf, and
      // store the boat inside its own locker. If the move commits
      // first, the boat-in-locker placement becomes legal and may
      // succeed; if the placement is checked first it must be rejected
      // as a cycle. Either way the union graph stays acyclic.
      const moveLocker = updateStorageLocation(locker.id, {
        name: locker.name,
        parentLocationId: shelf.id,
        status: "ACTIVE",
      });
      const storeBoat = updateAsset(boat.id, {
        ...assetInput(boat.name),
        storageLocationId: locker.id,
      });
      try {
        await waitForWaiters(2);
      } finally {
        lock.release();
      }
      const [rMove, rStore] = await Promise.allSettled([moveLocker, storeBoat]);
      await lock.done;

      expect(rMove.status).toBe("fulfilled");
      if (rStore.status === "rejected") {
        expect(rStore.reason).toBeInstanceOf(AssetHierarchyError);
      }

      const [fBoat, fLocker] = await Promise.all([
        prisma.asset.findUniqueOrThrow({ where: { id: boat.id } }),
        prisma.storageLocation.findUniqueOrThrow({
          where: { id: locker.id },
        }),
      ]);
      // The locker moved to the shelf in every interleaving.
      expect(fLocker.parentLocationId).toBe(shelf.id);
      expect(fLocker.containingAssetId).toBeNull();
      // The impossible persisted state — boat inside a locker that is
      // still inside the boat — can never exist.
      const cyclic =
        fBoat.storageLocationId === locker.id &&
        fLocker.containingAssetId === boat.id;
      expect(cyclic).toBe(false);
    },
  );

  it(
    "serializes per organization — a held lock blocks only that org",
    { timeout: 30_000 },
    async () => {
      const orgA = await createOrganization({ name: uniqueName("org-a") });
      const orgB = await createOrganization({ name: uniqueName("org-b") });
      const a1 = await createAsset(orgA.id, assetInput(uniqueName("a1")));
      const a2 = await createAsset(orgA.id, assetInput(uniqueName("a2")));
      const b1 = await createAsset(orgB.id, assetInput(uniqueName("b1")));
      const b2 = await createAsset(orgB.id, assetInput(uniqueName("b2")));

      const lock = holdContainmentLock(orgA.id);
      await lock.acquired;

      // Org A's write queues behind the held lock; org B's write on
      // its own lock key must complete while A is still blocked.
      const pendingA = updateAsset(a1.id, {
        ...assetInput(a1.name),
        parentAssetId: a2.id,
      });
      let aSettled = false;
      void pendingA.then(
        () => (aSettled = true),
        () => (aSettled = true),
      );

      try {
        await waitForWaiters(1);
        await updateAsset(b1.id, {
          ...assetInput(b1.name),
          parentAssetId: b2.id,
        });
        // B committed while A was still queued on org A's lock.
        expect(aSettled).toBe(false);
      } finally {
        lock.release();
      }
      await lock.done;
      await pendingA;

      const [fa1, fb1] = await Promise.all([
        prisma.asset.findUniqueOrThrow({ where: { id: a1.id } }),
        prisma.asset.findUniqueOrThrow({ where: { id: b1.id } }),
      ]);
      expect(fa1.parentAssetId).toBe(a2.id);
      expect(fb1.parentAssetId).toBe(b2.id);
    },
  );
});
