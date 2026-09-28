-- CreateEnum
CREATE TYPE "StorageLocationStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'OUT_OF_SERVICE', 'RETIRED');

-- CreateEnum
CREATE TYPE "ConditionStatus" AS ENUM ('UNKNOWN', 'GOOD', 'FAIR', 'DAMAGED');

-- CreateEnum
CREATE TYPE "InventoryItemStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "StorageLocation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "parentLocationId" TEXT,
    "containingAssetId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "StorageLocationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "unitId" TEXT,
    "parentAssetId" TEXT,
    "storageLocationId" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "assetTag" TEXT,
    "purchaseDate" DATE,
    "vendor" TEXT,
    "status" "AssetStatus" NOT NULL DEFAULT 'ACTIVE',
    "condition" "ConditionStatus" NOT NULL DEFAULT 'UNKNOWN',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "unitId" TEXT,
    "storageLocationId" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitOfMeasure" TEXT,
    "vendor" TEXT,
    "condition" "ConditionStatus" NOT NULL DEFAULT 'UNKNOWN',
    "status" "InventoryItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StorageLocation_organizationId_idx" ON "StorageLocation"("organizationId");

-- CreateIndex
CREATE INDEX "StorageLocation_parentLocationId_idx" ON "StorageLocation"("parentLocationId");

-- CreateIndex
CREATE INDEX "StorageLocation_containingAssetId_idx" ON "StorageLocation"("containingAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "StorageLocation_id_organizationId_key" ON "StorageLocation"("id", "organizationId");

-- CreateIndex
CREATE INDEX "Asset_organizationId_status_idx" ON "Asset"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Asset_organizationId_category_idx" ON "Asset"("organizationId", "category");

-- CreateIndex
CREATE INDEX "Asset_serialNumber_idx" ON "Asset"("serialNumber");

CREATE INDEX "Asset_unitId_idx" ON "Asset"("unitId");

CREATE INDEX "Asset_parentAssetId_idx" ON "Asset"("parentAssetId");

CREATE INDEX "Asset_storageLocationId_idx" ON "Asset"("storageLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_id_organizationId_key" ON "Asset"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_organizationId_assetTag_key" ON "Asset"("organizationId", "assetTag");

-- CreateIndex
CREATE INDEX "InventoryItem_organizationId_status_idx" ON "InventoryItem"("organizationId", "status");

-- CreateIndex
CREATE INDEX "InventoryItem_organizationId_category_idx" ON "InventoryItem"("organizationId", "category");

-- CreateIndex
CREATE INDEX "InventoryItem_storageLocationId_idx" ON "InventoryItem"("storageLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_id_organizationId_key" ON "InventoryItem"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "StorageLocation" ADD CONSTRAINT "StorageLocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageLocation" ADD CONSTRAINT "StorageLocation_parentLocationId_organizationId_fkey" FOREIGN KEY ("parentLocationId", "organizationId") REFERENCES "StorageLocation"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageLocation" ADD CONSTRAINT "StorageLocation_containingAssetId_organizationId_fkey" FOREIGN KEY ("containingAssetId", "organizationId") REFERENCES "Asset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_unitId_organizationId_fkey" FOREIGN KEY ("unitId", "organizationId") REFERENCES "Unit"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_parentAssetId_organizationId_fkey" FOREIGN KEY ("parentAssetId", "organizationId") REFERENCES "Asset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_storageLocationId_organizationId_fkey" FOREIGN KEY ("storageLocationId", "organizationId") REFERENCES "StorageLocation"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_unitId_organizationId_fkey" FOREIGN KEY ("unitId", "organizationId") REFERENCES "Unit"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_storageLocationId_organizationId_fkey" FOREIGN KEY ("storageLocationId", "organizationId") REFERENCES "StorageLocation"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
