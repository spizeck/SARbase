-- CreateTable
CREATE TABLE "InspectionRecordChange" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "note" TEXT,
    "beforePerformedOn" DATE NOT NULL,
    "beforeInspectorMemberId" TEXT,
    "beforeInspectorName" TEXT,
    "beforeConditionObserved" "ConditionStatus",
    "beforeNextDueOn" DATE,
    "beforeNotes" TEXT,
    "afterPerformedOn" DATE NOT NULL,
    "afterInspectorMemberId" TEXT,
    "afterInspectorName" TEXT,
    "afterConditionObserved" "ConditionStatus",
    "afterNextDueOn" DATE,
    "afterNotes" TEXT,
    "actorAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspectionRecordChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceRecordChange" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "note" TEXT,
    "beforePerformedOn" DATE NOT NULL,
    "beforeTitle" TEXT NOT NULL,
    "beforeWorkPerformed" TEXT,
    "beforeProviderName" TEXT,
    "beforePerformedByMemberId" TEXT,
    "beforeNextDueOn" DATE,
    "beforeNotes" TEXT,
    "afterPerformedOn" DATE NOT NULL,
    "afterTitle" TEXT NOT NULL,
    "afterWorkPerformed" TEXT,
    "afterProviderName" TEXT,
    "afterPerformedByMemberId" TEXT,
    "afterNextDueOn" DATE,
    "afterNotes" TEXT,
    "actorAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceRecordChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InspectionRecordChange_recordId_createdAt_idx" ON "InspectionRecordChange"("recordId", "createdAt");

-- CreateIndex
CREATE INDEX "InspectionRecordChange_organizationId_idx" ON "InspectionRecordChange"("organizationId");

-- CreateIndex
CREATE INDEX "MaintenanceRecordChange_recordId_createdAt_idx" ON "MaintenanceRecordChange"("recordId", "createdAt");

-- CreateIndex
CREATE INDEX "MaintenanceRecordChange_organizationId_idx" ON "MaintenanceRecordChange"("organizationId");

-- AddForeignKey
ALTER TABLE "InspectionRecordChange" ADD CONSTRAINT "InspectionRecordChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionRecordChange" ADD CONSTRAINT "InspectionRecordChange_recordId_organizationId_fkey" FOREIGN KEY ("recordId", "organizationId") REFERENCES "InspectionRecord"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionRecordChange" ADD CONSTRAINT "InspectionRecordChange_actorAuthIdentityId_fkey" FOREIGN KEY ("actorAuthIdentityId") REFERENCES "AuthIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecordChange" ADD CONSTRAINT "MaintenanceRecordChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecordChange" ADD CONSTRAINT "MaintenanceRecordChange_recordId_organizationId_fkey" FOREIGN KEY ("recordId", "organizationId") REFERENCES "MaintenanceRecord"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecordChange" ADD CONSTRAINT "MaintenanceRecordChange_actorAuthIdentityId_fkey" FOREIGN KEY ("actorAuthIdentityId") REFERENCES "AuthIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
