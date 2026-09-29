-- CreateEnum
CREATE TYPE "InspectionDefinitionStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "RecurrenceType" AS ENUM ('NONE', 'CALENDAR_DAYS', 'CALENDAR_MONTHS', 'METER_INTERVAL');

-- CreateEnum
CREATE TYPE "MaintenancePlanStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "DefectStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "DefectAction" AS ENUM ('REPORTED', 'RESOLVED', 'REOPENED');

-- CreateEnum
CREATE TYPE "AssetMeterStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "InspectionDefinition" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "recurrenceType" "RecurrenceType" NOT NULL DEFAULT 'NONE',
    "intervalValue" INTEGER,
    "status" "InspectionDefinitionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "performedOn" DATE NOT NULL,
    "inspectorMemberId" TEXT,
    "inspectorName" TEXT,
    "conditionObserved" "ConditionStatus",
    "nextDueOn" DATE,
    "meterId" TEXT,
    "meterReading" DECIMAL(14,3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenancePlan" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "intervalType" "RecurrenceType" NOT NULL DEFAULT 'NONE',
    "intervalValue" INTEGER,
    "meterId" TEXT,
    "meterInterval" DECIMAL(14,3),
    "status" "MaintenancePlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenancePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "planId" TEXT,
    "performedOn" DATE NOT NULL,
    "title" TEXT NOT NULL,
    "workPerformed" TEXT,
    "providerName" TEXT,
    "performedByMemberId" TEXT,
    "meterId" TEXT,
    "meterReading" DECIMAL(14,3),
    "nextDueOn" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Defect" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "reportedOn" DATE NOT NULL,
    "reportedByMemberId" TEXT,
    "reporterName" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "DefectStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedOn" DATE,
    "resolutionNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Defect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DefectChange" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "defectId" TEXT NOT NULL,
    "action" "DefectAction" NOT NULL,
    "note" TEXT,
    "actorAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DefectChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetMeter" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "status" "AssetMeterStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetMeter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetMeterReading" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "meterId" TEXT NOT NULL,
    "reading" DECIMAL(14,3) NOT NULL,
    "recordedOn" DATE NOT NULL,
    "recordedByMemberId" TEXT,
    "maintenanceRecordId" TEXT,
    "inspectionRecordId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetMeterReading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InspectionDefinition_organizationId_status_idx" ON "InspectionDefinition"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionDefinition_organizationId_name_key" ON "InspectionDefinition"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionDefinition_id_organizationId_key" ON "InspectionDefinition"("id", "organizationId");

-- CreateIndex
CREATE INDEX "InspectionRecord_organizationId_assetId_performedOn_idx" ON "InspectionRecord"("organizationId", "assetId", "performedOn");

-- CreateIndex
CREATE INDEX "InspectionRecord_organizationId_definitionId_idx" ON "InspectionRecord"("organizationId", "definitionId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionRecord_id_organizationId_key" ON "InspectionRecord"("id", "organizationId");

-- CreateIndex
CREATE INDEX "MaintenancePlan_organizationId_status_idx" ON "MaintenancePlan"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenancePlan_assetId_name_key" ON "MaintenancePlan"("assetId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenancePlan_id_organizationId_key" ON "MaintenancePlan"("id", "organizationId");

-- CreateIndex
CREATE INDEX "MaintenanceRecord_organizationId_assetId_performedOn_idx" ON "MaintenanceRecord"("organizationId", "assetId", "performedOn");

-- CreateIndex
CREATE INDEX "MaintenanceRecord_organizationId_planId_idx" ON "MaintenanceRecord"("organizationId", "planId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceRecord_id_organizationId_key" ON "MaintenanceRecord"("id", "organizationId");

-- CreateIndex
CREATE INDEX "Defect_organizationId_status_idx" ON "Defect"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Defect_organizationId_assetId_idx" ON "Defect"("organizationId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "Defect_id_organizationId_key" ON "Defect"("id", "organizationId");

-- CreateIndex
CREATE INDEX "AssetMeter_organizationId_assetId_idx" ON "AssetMeter"("organizationId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetMeter_assetId_name_key" ON "AssetMeter"("assetId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AssetMeter_id_organizationId_key" ON "AssetMeter"("id", "organizationId");

-- CreateIndex
CREATE INDEX "AssetMeterReading_meterId_recordedOn_idx" ON "AssetMeterReading"("meterId", "recordedOn");

-- AddForeignKey
ALTER TABLE "InspectionDefinition" ADD CONSTRAINT "InspectionDefinition_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionRecord" ADD CONSTRAINT "InspectionRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionRecord" ADD CONSTRAINT "InspectionRecord_assetId_organizationId_fkey" FOREIGN KEY ("assetId", "organizationId") REFERENCES "Asset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionRecord" ADD CONSTRAINT "InspectionRecord_definitionId_organizationId_fkey" FOREIGN KEY ("definitionId", "organizationId") REFERENCES "InspectionDefinition"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionRecord" ADD CONSTRAINT "InspectionRecord_inspectorMemberId_organizationId_fkey" FOREIGN KEY ("inspectorMemberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionRecord" ADD CONSTRAINT "InspectionRecord_meterId_organizationId_fkey" FOREIGN KEY ("meterId", "organizationId") REFERENCES "AssetMeter"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "MaintenancePlan_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "MaintenancePlan_assetId_organizationId_fkey" FOREIGN KEY ("assetId", "organizationId") REFERENCES "Asset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "MaintenancePlan_meterId_organizationId_fkey" FOREIGN KEY ("meterId", "organizationId") REFERENCES "AssetMeter"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "MaintenanceRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "MaintenanceRecord_assetId_organizationId_fkey" FOREIGN KEY ("assetId", "organizationId") REFERENCES "Asset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "MaintenanceRecord_planId_organizationId_fkey" FOREIGN KEY ("planId", "organizationId") REFERENCES "MaintenancePlan"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "MaintenanceRecord_performedByMemberId_organizationId_fkey" FOREIGN KEY ("performedByMemberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "MaintenanceRecord_meterId_organizationId_fkey" FOREIGN KEY ("meterId", "organizationId") REFERENCES "AssetMeter"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_assetId_organizationId_fkey" FOREIGN KEY ("assetId", "organizationId") REFERENCES "Asset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_reportedByMemberId_organizationId_fkey" FOREIGN KEY ("reportedByMemberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DefectChange" ADD CONSTRAINT "DefectChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DefectChange" ADD CONSTRAINT "DefectChange_defectId_organizationId_fkey" FOREIGN KEY ("defectId", "organizationId") REFERENCES "Defect"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DefectChange" ADD CONSTRAINT "DefectChange_actorAuthIdentityId_fkey" FOREIGN KEY ("actorAuthIdentityId") REFERENCES "AuthIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetMeter" ADD CONSTRAINT "AssetMeter_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetMeter" ADD CONSTRAINT "AssetMeter_assetId_organizationId_fkey" FOREIGN KEY ("assetId", "organizationId") REFERENCES "Asset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetMeterReading" ADD CONSTRAINT "AssetMeterReading_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetMeterReading" ADD CONSTRAINT "AssetMeterReading_meterId_organizationId_fkey" FOREIGN KEY ("meterId", "organizationId") REFERENCES "AssetMeter"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetMeterReading" ADD CONSTRAINT "AssetMeterReading_recordedByMemberId_organizationId_fkey" FOREIGN KEY ("recordedByMemberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetMeterReading" ADD CONSTRAINT "AssetMeterReading_maintenanceRecordId_organizationId_fkey" FOREIGN KEY ("maintenanceRecordId", "organizationId") REFERENCES "MaintenanceRecord"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetMeterReading" ADD CONSTRAINT "AssetMeterReading_inspectionRecordId_organizationId_fkey" FOREIGN KEY ("inspectionRecordId", "organizationId") REFERENCES "InspectionRecord"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
