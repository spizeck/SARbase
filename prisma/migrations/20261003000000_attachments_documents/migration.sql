-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('ACTIVE', 'DELETED');

-- CreateEnum
CREATE TYPE "AttachmentEventAction" AS ENUM ('UPLOADED', 'LINKED', 'UNLINKED', 'DELETED');

-- CreateEnum
CREATE TYPE "OrganizationDocumentStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IncidentTimelineEventType" ADD VALUE 'ATTACHMENT_ADDED';
ALTER TYPE "IncidentTimelineEventType" ADD VALUE 'ATTACHMENT_REMOVED';

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "displayFilename" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageProvider" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "description" TEXT,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "deletedAt" TIMESTAMP(3),
    "deletedByAuthIdentityId" TEXT,
    "uploadedByAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttachmentEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "action" "AttachmentEventAction" NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "reason" TEXT,
    "storageDeleted" BOOLEAN,
    "actorAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttachmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationDocument" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "effectiveOn" DATE,
    "expiresOn" DATE,
    "notes" TEXT,
    "status" "OrganizationDocumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationDocumentVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "note" TEXT,
    "createdByAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationDocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentAttachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "createdByAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentNoteAttachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "createdByAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentNoteAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberQualificationAttachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberQualificationId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "createdByAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberQualificationAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingEventAttachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "trainingEventId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "createdByAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingEventAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetAttachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "createdByAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionRecordAttachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "inspectionRecordId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "createdByAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspectionRecordAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceRecordAttachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "maintenanceRecordId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "createdByAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceRecordAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DefectAttachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "defectId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "createdByAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DefectAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Attachment_organizationId_createdAt_idx" ON "Attachment"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Attachment_organizationId_checksumSha256_idx" ON "Attachment"("organizationId", "checksumSha256");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_id_organizationId_key" ON "Attachment"("id", "organizationId");

-- CreateIndex
CREATE INDEX "AttachmentEvent_attachmentId_createdAt_idx" ON "AttachmentEvent"("attachmentId", "createdAt");

-- CreateIndex
CREATE INDEX "AttachmentEvent_organizationId_createdAt_idx" ON "AttachmentEvent"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "OrganizationDocument_organizationId_status_idx" ON "OrganizationDocument"("organizationId", "status");

-- CreateIndex
CREATE INDEX "OrganizationDocument_organizationId_expiresOn_idx" ON "OrganizationDocument"("organizationId", "expiresOn");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationDocument_id_organizationId_key" ON "OrganizationDocument"("id", "organizationId");

-- CreateIndex
CREATE INDEX "OrganizationDocumentVersion_attachmentId_idx" ON "OrganizationDocumentVersion"("attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationDocumentVersion_documentId_versionNumber_key" ON "OrganizationDocumentVersion"("documentId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationDocumentVersion_documentId_attachmentId_key" ON "OrganizationDocumentVersion"("documentId", "attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationDocumentVersion_id_organizationId_key" ON "OrganizationDocumentVersion"("id", "organizationId");

-- CreateIndex
CREATE INDEX "IncidentAttachment_attachmentId_idx" ON "IncidentAttachment"("attachmentId");

-- CreateIndex
CREATE INDEX "IncidentAttachment_organizationId_incidentId_idx" ON "IncidentAttachment"("organizationId", "incidentId");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentAttachment_incidentId_attachmentId_key" ON "IncidentAttachment"("incidentId", "attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentAttachment_id_organizationId_key" ON "IncidentAttachment"("id", "organizationId");

-- CreateIndex
CREATE INDEX "IncidentNoteAttachment_attachmentId_idx" ON "IncidentNoteAttachment"("attachmentId");

-- CreateIndex
CREATE INDEX "IncidentNoteAttachment_organizationId_incidentId_idx" ON "IncidentNoteAttachment"("organizationId", "incidentId");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentNoteAttachment_noteId_attachmentId_key" ON "IncidentNoteAttachment"("noteId", "attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentNoteAttachment_id_organizationId_key" ON "IncidentNoteAttachment"("id", "organizationId");

-- CreateIndex
CREATE INDEX "MemberQualificationAttachment_attachmentId_idx" ON "MemberQualificationAttachment"("attachmentId");

-- CreateIndex
CREATE INDEX "MemberQualificationAttachment_organizationId_memberQualific_idx" ON "MemberQualificationAttachment"("organizationId", "memberQualificationId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberQualificationAttachment_memberQualificationId_attachm_key" ON "MemberQualificationAttachment"("memberQualificationId", "attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberQualificationAttachment_id_organizationId_key" ON "MemberQualificationAttachment"("id", "organizationId");

-- CreateIndex
CREATE INDEX "TrainingEventAttachment_attachmentId_idx" ON "TrainingEventAttachment"("attachmentId");

-- CreateIndex
CREATE INDEX "TrainingEventAttachment_organizationId_trainingEventId_idx" ON "TrainingEventAttachment"("organizationId", "trainingEventId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingEventAttachment_trainingEventId_attachmentId_key" ON "TrainingEventAttachment"("trainingEventId", "attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingEventAttachment_id_organizationId_key" ON "TrainingEventAttachment"("id", "organizationId");

-- CreateIndex
CREATE INDEX "AssetAttachment_attachmentId_idx" ON "AssetAttachment"("attachmentId");

-- CreateIndex
CREATE INDEX "AssetAttachment_organizationId_assetId_idx" ON "AssetAttachment"("organizationId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetAttachment_assetId_attachmentId_key" ON "AssetAttachment"("assetId", "attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetAttachment_id_organizationId_key" ON "AssetAttachment"("id", "organizationId");

-- CreateIndex
CREATE INDEX "InspectionRecordAttachment_attachmentId_idx" ON "InspectionRecordAttachment"("attachmentId");

-- CreateIndex
CREATE INDEX "InspectionRecordAttachment_organizationId_inspectionRecordI_idx" ON "InspectionRecordAttachment"("organizationId", "inspectionRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionRecordAttachment_inspectionRecordId_attachmentId_key" ON "InspectionRecordAttachment"("inspectionRecordId", "attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionRecordAttachment_id_organizationId_key" ON "InspectionRecordAttachment"("id", "organizationId");

-- CreateIndex
CREATE INDEX "MaintenanceRecordAttachment_attachmentId_idx" ON "MaintenanceRecordAttachment"("attachmentId");

-- CreateIndex
CREATE INDEX "MaintenanceRecordAttachment_organizationId_maintenanceRecor_idx" ON "MaintenanceRecordAttachment"("organizationId", "maintenanceRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceRecordAttachment_maintenanceRecordId_attachmentI_key" ON "MaintenanceRecordAttachment"("maintenanceRecordId", "attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceRecordAttachment_id_organizationId_key" ON "MaintenanceRecordAttachment"("id", "organizationId");

-- CreateIndex
CREATE INDEX "DefectAttachment_attachmentId_idx" ON "DefectAttachment"("attachmentId");

-- CreateIndex
CREATE INDEX "DefectAttachment_organizationId_defectId_idx" ON "DefectAttachment"("organizationId", "defectId");

-- CreateIndex
CREATE UNIQUE INDEX "DefectAttachment_defectId_attachmentId_key" ON "DefectAttachment"("defectId", "attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "DefectAttachment_id_organizationId_key" ON "DefectAttachment"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberQualification_id_organizationId_key" ON "MemberQualification"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttachmentEvent" ADD CONSTRAINT "AttachmentEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttachmentEvent" ADD CONSTRAINT "AttachmentEvent_attachmentId_organizationId_fkey" FOREIGN KEY ("attachmentId", "organizationId") REFERENCES "Attachment"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationDocument" ADD CONSTRAINT "OrganizationDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationDocumentVersion" ADD CONSTRAINT "OrganizationDocumentVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationDocumentVersion" ADD CONSTRAINT "OrganizationDocumentVersion_documentId_organizationId_fkey" FOREIGN KEY ("documentId", "organizationId") REFERENCES "OrganizationDocument"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationDocumentVersion" ADD CONSTRAINT "OrganizationDocumentVersion_attachmentId_organizationId_fkey" FOREIGN KEY ("attachmentId", "organizationId") REFERENCES "Attachment"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentAttachment" ADD CONSTRAINT "IncidentAttachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentAttachment" ADD CONSTRAINT "IncidentAttachment_incidentId_organizationId_fkey" FOREIGN KEY ("incidentId", "organizationId") REFERENCES "Incident"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentAttachment" ADD CONSTRAINT "IncidentAttachment_attachmentId_organizationId_fkey" FOREIGN KEY ("attachmentId", "organizationId") REFERENCES "Attachment"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentNoteAttachment" ADD CONSTRAINT "IncidentNoteAttachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentNoteAttachment" ADD CONSTRAINT "IncidentNoteAttachment_noteId_incidentId_organizationId_fkey" FOREIGN KEY ("noteId", "incidentId", "organizationId") REFERENCES "IncidentNote"("id", "incidentId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentNoteAttachment" ADD CONSTRAINT "IncidentNoteAttachment_attachmentId_organizationId_fkey" FOREIGN KEY ("attachmentId", "organizationId") REFERENCES "Attachment"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberQualificationAttachment" ADD CONSTRAINT "MemberQualificationAttachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberQualificationAttachment" ADD CONSTRAINT "MemberQualificationAttachment_memberQualificationId_organi_fkey" FOREIGN KEY ("memberQualificationId", "organizationId") REFERENCES "MemberQualification"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberQualificationAttachment" ADD CONSTRAINT "MemberQualificationAttachment_attachmentId_organizationId_fkey" FOREIGN KEY ("attachmentId", "organizationId") REFERENCES "Attachment"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingEventAttachment" ADD CONSTRAINT "TrainingEventAttachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingEventAttachment" ADD CONSTRAINT "TrainingEventAttachment_trainingEventId_organizationId_fkey" FOREIGN KEY ("trainingEventId", "organizationId") REFERENCES "TrainingEvent"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingEventAttachment" ADD CONSTRAINT "TrainingEventAttachment_attachmentId_organizationId_fkey" FOREIGN KEY ("attachmentId", "organizationId") REFERENCES "Attachment"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAttachment" ADD CONSTRAINT "AssetAttachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAttachment" ADD CONSTRAINT "AssetAttachment_assetId_organizationId_fkey" FOREIGN KEY ("assetId", "organizationId") REFERENCES "Asset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAttachment" ADD CONSTRAINT "AssetAttachment_attachmentId_organizationId_fkey" FOREIGN KEY ("attachmentId", "organizationId") REFERENCES "Attachment"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionRecordAttachment" ADD CONSTRAINT "InspectionRecordAttachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionRecordAttachment" ADD CONSTRAINT "InspectionRecordAttachment_inspectionRecordId_organization_fkey" FOREIGN KEY ("inspectionRecordId", "organizationId") REFERENCES "InspectionRecord"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionRecordAttachment" ADD CONSTRAINT "InspectionRecordAttachment_attachmentId_organizationId_fkey" FOREIGN KEY ("attachmentId", "organizationId") REFERENCES "Attachment"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecordAttachment" ADD CONSTRAINT "MaintenanceRecordAttachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecordAttachment" ADD CONSTRAINT "MaintenanceRecordAttachment_maintenanceRecordId_organizati_fkey" FOREIGN KEY ("maintenanceRecordId", "organizationId") REFERENCES "MaintenanceRecord"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecordAttachment" ADD CONSTRAINT "MaintenanceRecordAttachment_attachmentId_organizationId_fkey" FOREIGN KEY ("attachmentId", "organizationId") REFERENCES "Attachment"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DefectAttachment" ADD CONSTRAINT "DefectAttachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DefectAttachment" ADD CONSTRAINT "DefectAttachment_defectId_organizationId_fkey" FOREIGN KEY ("defectId", "organizationId") REFERENCES "Defect"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DefectAttachment" ADD CONSTRAINT "DefectAttachment_attachmentId_organizationId_fkey" FOREIGN KEY ("attachmentId", "organizationId") REFERENCES "Attachment"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

