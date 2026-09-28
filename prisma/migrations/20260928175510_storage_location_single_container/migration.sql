-- At most one container per location: a StorageLocation sits inside a
-- parent location OR inside an asset, never both (top-level locations
-- have neither). The domain layer rejects dual containers for a
-- friendly error; this CHECK is the database backstop so direct writes,
-- import scripts, and future code paths cannot persist the ambiguous
-- state either. Prisma's datamodel cannot express CHECK constraints —
-- this is intentionally SQL-only, and `migrate diff` ignores it.
ALTER TABLE "StorageLocation"
  ADD CONSTRAINT "StorageLocation_single_container"
  CHECK ("parentLocationId" IS NULL OR "containingAssetId" IS NULL);
