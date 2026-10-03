-- DropForeignKey
ALTER TABLE "DefectChange" DROP CONSTRAINT "DefectChange_actorAuthIdentityId_fkey";

-- DropForeignKey
ALTER TABLE "InspectionRecordChange" DROP CONSTRAINT "InspectionRecordChange_actorAuthIdentityId_fkey";

-- DropForeignKey
ALTER TABLE "MaintenanceRecordChange" DROP CONSTRAINT "MaintenanceRecordChange_actorAuthIdentityId_fkey";

-- DropForeignKey
ALTER TABLE "TrainingEvent" DROP CONSTRAINT "TrainingEvent_leadMemberId_organizationId_fkey";

-- AddForeignKey
ALTER TABLE "TrainingEvent" ADD CONSTRAINT "TrainingEvent_leadMemberId_organizationId_fkey" FOREIGN KEY ("leadMemberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
