-- At-most-one provenance source for a meter reading: a reading may be
-- captured on a maintenance record OR an inspection record OR neither
-- (standalone), but never both. Enforced in PostgreSQL so direct writes,
-- import scripts, and future code paths can't violate it; the domain
-- layer keeps its own validation for friendly errors.
ALTER TABLE "AssetMeterReading" ADD CONSTRAINT "AssetMeterReading_single_source"
  CHECK ("maintenanceRecordId" IS NULL OR "inspectionRecordId" IS NULL);
