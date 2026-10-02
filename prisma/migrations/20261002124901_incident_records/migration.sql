-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "IncidentTimelineEventType" AS ENUM ('INCIDENT_CREATED', 'STATUS_CHANGED', 'CALLOUT_LINKED', 'MEMBER_ADDED', 'MEMBER_REMOVED', 'ASSET_ADDED', 'ASSET_REMOVED', 'CORRECTION_RECORDED');

-- CreateEnum
CREATE TYPE "IncidentNoteKind" AS ENUM ('GENERAL', 'AFTER_ACTION', 'CLOSING');

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "calloutId" TEXT,
    "sequence" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "status" "IncidentStatus" NOT NULL DEFAULT 'DRAFT',
    "reportedAt" TIMESTAMP(3),
    "departedAt" TIMESTAMP(3),
    "onSceneAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdByAuthIdentityId" TEXT NOT NULL,
    "closedByAuthIdentityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentSequence" (
    "organizationId" TEXT NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "IncidentSequence_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "IncidentMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "roleNote" TEXT,
    "recordedByAuthIdentityId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentAsset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "note" TEXT,
    "recordedByAuthIdentityId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentTimelineEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "type" "IncidentTimelineEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "actorAuthIdentityId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentTimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentNote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "authorAuthIdentityId" TEXT NOT NULL,
    "kind" "IncidentNoteKind" NOT NULL DEFAULT 'GENERAL',
    "body" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncidentNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentNoteCorrection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "beforeBody" TEXT NOT NULL,
    "afterBody" TEXT NOT NULL,
    "reason" TEXT,
    "actorAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentNoteCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentChange" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "reason" TEXT,
    "beforeTitle" TEXT NOT NULL,
    "beforeSummary" TEXT,
    "beforeReportedAt" TIMESTAMP(3),
    "beforeDepartedAt" TIMESTAMP(3),
    "beforeOnSceneAt" TIMESTAMP(3),
    "beforeReturnedAt" TIMESTAMP(3),
    "afterTitle" TEXT NOT NULL,
    "afterSummary" TEXT,
    "afterReportedAt" TIMESTAMP(3),
    "afterDepartedAt" TIMESTAMP(3),
    "afterOnSceneAt" TIMESTAMP(3),
    "afterReturnedAt" TIMESTAMP(3),
    "actorAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Incident_organizationId_status_idx" ON "Incident"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Incident_organizationId_createdAt_idx" ON "Incident"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_calloutId_organizationId_key" ON "Incident"("calloutId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_organizationId_reference_key" ON "Incident"("organizationId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_id_organizationId_key" ON "Incident"("id", "organizationId");

-- CreateIndex
CREATE INDEX "IncidentMember_organizationId_incidentId_idx" ON "IncidentMember"("organizationId", "incidentId");

-- CreateIndex
CREATE INDEX "IncidentMember_memberId_idx" ON "IncidentMember"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentMember_incidentId_memberId_key" ON "IncidentMember"("incidentId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentMember_id_organizationId_key" ON "IncidentMember"("id", "organizationId");

-- CreateIndex
CREATE INDEX "IncidentAsset_organizationId_incidentId_idx" ON "IncidentAsset"("organizationId", "incidentId");

-- CreateIndex
CREATE INDEX "IncidentAsset_assetId_idx" ON "IncidentAsset"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentAsset_incidentId_assetId_key" ON "IncidentAsset"("incidentId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentAsset_id_organizationId_key" ON "IncidentAsset"("id", "organizationId");

-- CreateIndex
CREATE INDEX "IncidentTimelineEvent_incidentId_occurredAt_idx" ON "IncidentTimelineEvent"("incidentId", "occurredAt");

-- CreateIndex
CREATE INDEX "IncidentTimelineEvent_organizationId_occurredAt_idx" ON "IncidentTimelineEvent"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "IncidentNote_incidentId_createdAt_idx" ON "IncidentNote"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "IncidentNote_organizationId_createdAt_idx" ON "IncidentNote"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentNote_id_organizationId_key" ON "IncidentNote"("id", "organizationId");

-- CreateIndex
CREATE INDEX "IncidentNoteCorrection_noteId_createdAt_idx" ON "IncidentNoteCorrection"("noteId", "createdAt");

-- CreateIndex
CREATE INDEX "IncidentNoteCorrection_incidentId_createdAt_idx" ON "IncidentNoteCorrection"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "IncidentNoteCorrection_organizationId_createdAt_idx" ON "IncidentNoteCorrection"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "IncidentChange_incidentId_createdAt_idx" ON "IncidentChange"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "IncidentChange_organizationId_createdAt_idx" ON "IncidentChange"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_calloutId_organizationId_fkey" FOREIGN KEY ("calloutId", "organizationId") REFERENCES "Callout"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentSequence" ADD CONSTRAINT "IncidentSequence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentMember" ADD CONSTRAINT "IncidentMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentMember" ADD CONSTRAINT "IncidentMember_incidentId_organizationId_fkey" FOREIGN KEY ("incidentId", "organizationId") REFERENCES "Incident"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentMember" ADD CONSTRAINT "IncidentMember_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentAsset" ADD CONSTRAINT "IncidentAsset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentAsset" ADD CONSTRAINT "IncidentAsset_incidentId_organizationId_fkey" FOREIGN KEY ("incidentId", "organizationId") REFERENCES "Incident"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentAsset" ADD CONSTRAINT "IncidentAsset_assetId_organizationId_fkey" FOREIGN KEY ("assetId", "organizationId") REFERENCES "Asset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentTimelineEvent" ADD CONSTRAINT "IncidentTimelineEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentTimelineEvent" ADD CONSTRAINT "IncidentTimelineEvent_incidentId_organizationId_fkey" FOREIGN KEY ("incidentId", "organizationId") REFERENCES "Incident"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentNote" ADD CONSTRAINT "IncidentNote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentNote" ADD CONSTRAINT "IncidentNote_incidentId_organizationId_fkey" FOREIGN KEY ("incidentId", "organizationId") REFERENCES "Incident"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentNoteCorrection" ADD CONSTRAINT "IncidentNoteCorrection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentNoteCorrection" ADD CONSTRAINT "IncidentNoteCorrection_noteId_organizationId_fkey" FOREIGN KEY ("noteId", "organizationId") REFERENCES "IncidentNote"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentChange" ADD CONSTRAINT "IncidentChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentChange" ADD CONSTRAINT "IncidentChange_incidentId_organizationId_fkey" FOREIGN KEY ("incidentId", "organizationId") REFERENCES "Incident"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
