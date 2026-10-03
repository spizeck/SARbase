-- CreateEnum
CREATE TYPE "VendorStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReimbursementStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'REIMBURSED');

-- CreateEnum
CREATE TYPE "ExpenseEventType" AS ENUM ('EXPENSE_CREATED', 'STATUS_CHANGED', 'REIMBURSEMENT_CHANGED', 'CONTEXT_LINKED', 'CONTEXT_UNLINKED', 'ATTACHMENT_ADDED', 'ATTACHMENT_REMOVED', 'CORRECTION_RECORDED');

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "accountReference" TEXT,
    "notes" TEXT,
    "status" "VendorStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseSequence" (
    "organizationId" TEXT NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ExpenseSequence_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "expenseDate" DATE NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "vendorId" TEXT,
    "category" TEXT,
    "description" TEXT,
    "submittedByMemberId" TEXT,
    "paidByMemberId" TEXT,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'DRAFT',
    "reimbursementStatus" "ReimbursementStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedByAuthIdentityId" TEXT,
    "reviewNote" TEXT,
    "reimbursedAt" TIMESTAMP(3),
    "reimbursedByAuthIdentityId" TEXT,
    "reimbursementNote" TEXT,
    "createdByAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseIncident" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "note" TEXT,
    "recordedByAuthIdentityId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseTrainingEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "trainingEventId" TEXT NOT NULL,
    "note" TEXT,
    "recordedByAuthIdentityId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseTrainingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseAsset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "note" TEXT,
    "recordedByAuthIdentityId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseMaintenanceRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "maintenanceRecordId" TEXT NOT NULL,
    "note" TEXT,
    "recordedByAuthIdentityId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseMaintenanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseInventoryItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "note" TEXT,
    "recordedByAuthIdentityId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseInventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseAttachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "createdByAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "type" "ExpenseEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "actorAuthIdentityId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseChange" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "reason" TEXT,
    "beforeExpenseDate" DATE NOT NULL,
    "beforeAmountMinor" INTEGER NOT NULL,
    "beforeCurrency" TEXT NOT NULL,
    "beforeVendorId" TEXT,
    "beforeCategory" TEXT,
    "beforeDescription" TEXT,
    "beforeSubmittedByMemberId" TEXT,
    "beforePaidByMemberId" TEXT,
    "afterExpenseDate" DATE NOT NULL,
    "afterAmountMinor" INTEGER NOT NULL,
    "afterCurrency" TEXT NOT NULL,
    "afterVendorId" TEXT,
    "afterCategory" TEXT,
    "afterDescription" TEXT,
    "afterSubmittedByMemberId" TEXT,
    "afterPaidByMemberId" TEXT,
    "actorAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Vendor_organizationId_status_idx" ON "Vendor"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Vendor_organizationId_name_idx" ON "Vendor"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_id_organizationId_key" ON "Vendor"("id", "organizationId");

-- CreateIndex
CREATE INDEX "Expense_organizationId_expenseDate_idx" ON "Expense"("organizationId", "expenseDate");

-- CreateIndex
CREATE INDEX "Expense_organizationId_status_idx" ON "Expense"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Expense_organizationId_vendorId_idx" ON "Expense"("organizationId", "vendorId");

-- CreateIndex
CREATE INDEX "Expense_organizationId_category_idx" ON "Expense"("organizationId", "category");

-- CreateIndex
CREATE INDEX "Expense_organizationId_reimbursementStatus_idx" ON "Expense"("organizationId", "reimbursementStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_organizationId_reference_key" ON "Expense"("organizationId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_id_organizationId_key" ON "Expense"("id", "organizationId");

-- CreateIndex
CREATE INDEX "ExpenseIncident_incidentId_idx" ON "ExpenseIncident"("incidentId");

-- CreateIndex
CREATE INDEX "ExpenseIncident_organizationId_incidentId_idx" ON "ExpenseIncident"("organizationId", "incidentId");

-- CreateIndex
CREATE INDEX "ExpenseIncident_organizationId_expenseId_idx" ON "ExpenseIncident"("organizationId", "expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseIncident_expenseId_incidentId_key" ON "ExpenseIncident"("expenseId", "incidentId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseIncident_id_organizationId_key" ON "ExpenseIncident"("id", "organizationId");

-- CreateIndex
CREATE INDEX "ExpenseTrainingEvent_trainingEventId_idx" ON "ExpenseTrainingEvent"("trainingEventId");

-- CreateIndex
CREATE INDEX "ExpenseTrainingEvent_organizationId_trainingEventId_idx" ON "ExpenseTrainingEvent"("organizationId", "trainingEventId");

-- CreateIndex
CREATE INDEX "ExpenseTrainingEvent_organizationId_expenseId_idx" ON "ExpenseTrainingEvent"("organizationId", "expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseTrainingEvent_expenseId_trainingEventId_key" ON "ExpenseTrainingEvent"("expenseId", "trainingEventId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseTrainingEvent_id_organizationId_key" ON "ExpenseTrainingEvent"("id", "organizationId");

-- CreateIndex
CREATE INDEX "ExpenseAsset_assetId_idx" ON "ExpenseAsset"("assetId");

-- CreateIndex
CREATE INDEX "ExpenseAsset_organizationId_assetId_idx" ON "ExpenseAsset"("organizationId", "assetId");

-- CreateIndex
CREATE INDEX "ExpenseAsset_organizationId_expenseId_idx" ON "ExpenseAsset"("organizationId", "expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseAsset_expenseId_assetId_key" ON "ExpenseAsset"("expenseId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseAsset_id_organizationId_key" ON "ExpenseAsset"("id", "organizationId");

-- CreateIndex
CREATE INDEX "ExpenseMaintenanceRecord_maintenanceRecordId_idx" ON "ExpenseMaintenanceRecord"("maintenanceRecordId");

-- CreateIndex
CREATE INDEX "ExpenseMaintenanceRecord_organizationId_maintenanceRecordId_idx" ON "ExpenseMaintenanceRecord"("organizationId", "maintenanceRecordId");

-- CreateIndex
CREATE INDEX "ExpenseMaintenanceRecord_organizationId_expenseId_idx" ON "ExpenseMaintenanceRecord"("organizationId", "expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseMaintenanceRecord_expenseId_maintenanceRecordId_key" ON "ExpenseMaintenanceRecord"("expenseId", "maintenanceRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseMaintenanceRecord_id_organizationId_key" ON "ExpenseMaintenanceRecord"("id", "organizationId");

-- CreateIndex
CREATE INDEX "ExpenseInventoryItem_inventoryItemId_idx" ON "ExpenseInventoryItem"("inventoryItemId");

-- CreateIndex
CREATE INDEX "ExpenseInventoryItem_organizationId_inventoryItemId_idx" ON "ExpenseInventoryItem"("organizationId", "inventoryItemId");

-- CreateIndex
CREATE INDEX "ExpenseInventoryItem_organizationId_expenseId_idx" ON "ExpenseInventoryItem"("organizationId", "expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseInventoryItem_expenseId_inventoryItemId_key" ON "ExpenseInventoryItem"("expenseId", "inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseInventoryItem_id_organizationId_key" ON "ExpenseInventoryItem"("id", "organizationId");

-- CreateIndex
CREATE INDEX "ExpenseAttachment_attachmentId_idx" ON "ExpenseAttachment"("attachmentId");

-- CreateIndex
CREATE INDEX "ExpenseAttachment_organizationId_expenseId_idx" ON "ExpenseAttachment"("organizationId", "expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseAttachment_expenseId_attachmentId_key" ON "ExpenseAttachment"("expenseId", "attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseAttachment_id_organizationId_key" ON "ExpenseAttachment"("id", "organizationId");

-- CreateIndex
CREATE INDEX "ExpenseEvent_expenseId_occurredAt_idx" ON "ExpenseEvent"("expenseId", "occurredAt");

-- CreateIndex
CREATE INDEX "ExpenseEvent_organizationId_occurredAt_idx" ON "ExpenseEvent"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "ExpenseChange_expenseId_createdAt_idx" ON "ExpenseChange"("expenseId", "createdAt");

-- CreateIndex
CREATE INDEX "ExpenseChange_organizationId_createdAt_idx" ON "ExpenseChange"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseSequence" ADD CONSTRAINT "ExpenseSequence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_vendorId_organizationId_fkey" FOREIGN KEY ("vendorId", "organizationId") REFERENCES "Vendor"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_submittedByMemberId_organizationId_fkey" FOREIGN KEY ("submittedByMemberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_paidByMemberId_organizationId_fkey" FOREIGN KEY ("paidByMemberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseIncident" ADD CONSTRAINT "ExpenseIncident_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseIncident" ADD CONSTRAINT "ExpenseIncident_expenseId_organizationId_fkey" FOREIGN KEY ("expenseId", "organizationId") REFERENCES "Expense"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseIncident" ADD CONSTRAINT "ExpenseIncident_incidentId_organizationId_fkey" FOREIGN KEY ("incidentId", "organizationId") REFERENCES "Incident"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseTrainingEvent" ADD CONSTRAINT "ExpenseTrainingEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseTrainingEvent" ADD CONSTRAINT "ExpenseTrainingEvent_expenseId_organizationId_fkey" FOREIGN KEY ("expenseId", "organizationId") REFERENCES "Expense"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseTrainingEvent" ADD CONSTRAINT "ExpenseTrainingEvent_trainingEventId_organizationId_fkey" FOREIGN KEY ("trainingEventId", "organizationId") REFERENCES "TrainingEvent"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseAsset" ADD CONSTRAINT "ExpenseAsset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseAsset" ADD CONSTRAINT "ExpenseAsset_expenseId_organizationId_fkey" FOREIGN KEY ("expenseId", "organizationId") REFERENCES "Expense"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseAsset" ADD CONSTRAINT "ExpenseAsset_assetId_organizationId_fkey" FOREIGN KEY ("assetId", "organizationId") REFERENCES "Asset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseMaintenanceRecord" ADD CONSTRAINT "ExpenseMaintenanceRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseMaintenanceRecord" ADD CONSTRAINT "ExpenseMaintenanceRecord_expenseId_organizationId_fkey" FOREIGN KEY ("expenseId", "organizationId") REFERENCES "Expense"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseMaintenanceRecord" ADD CONSTRAINT "ExpenseMaintenanceRecord_maintenanceRecordId_organizationI_fkey" FOREIGN KEY ("maintenanceRecordId", "organizationId") REFERENCES "MaintenanceRecord"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseInventoryItem" ADD CONSTRAINT "ExpenseInventoryItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseInventoryItem" ADD CONSTRAINT "ExpenseInventoryItem_expenseId_organizationId_fkey" FOREIGN KEY ("expenseId", "organizationId") REFERENCES "Expense"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseInventoryItem" ADD CONSTRAINT "ExpenseInventoryItem_inventoryItemId_organizationId_fkey" FOREIGN KEY ("inventoryItemId", "organizationId") REFERENCES "InventoryItem"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseAttachment" ADD CONSTRAINT "ExpenseAttachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseAttachment" ADD CONSTRAINT "ExpenseAttachment_expenseId_organizationId_fkey" FOREIGN KEY ("expenseId", "organizationId") REFERENCES "Expense"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseAttachment" ADD CONSTRAINT "ExpenseAttachment_attachmentId_organizationId_fkey" FOREIGN KEY ("attachmentId", "organizationId") REFERENCES "Attachment"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseEvent" ADD CONSTRAINT "ExpenseEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseEvent" ADD CONSTRAINT "ExpenseEvent_expenseId_organizationId_fkey" FOREIGN KEY ("expenseId", "organizationId") REFERENCES "Expense"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseChange" ADD CONSTRAINT "ExpenseChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseChange" ADD CONSTRAINT "ExpenseChange_expenseId_organizationId_fkey" FOREIGN KEY ("expenseId", "organizationId") REFERENCES "Expense"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
