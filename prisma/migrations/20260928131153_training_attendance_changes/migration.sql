-- CreateEnum
CREATE TYPE "TrainingAttendanceAction" AS ENUM ('ADDED', 'REMOVED');

-- CreateTable
CREATE TABLE "TrainingAttendanceChange" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "trainingEventId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "actorAuthIdentityId" TEXT NOT NULL,
    "action" "TrainingAttendanceAction" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingAttendanceChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrainingAttendanceChange_trainingEventId_createdAt_idx" ON "TrainingAttendanceChange"("trainingEventId", "createdAt");

-- CreateIndex
CREATE INDEX "TrainingAttendanceChange_memberId_idx" ON "TrainingAttendanceChange"("memberId");

-- CreateIndex
CREATE INDEX "TrainingAttendanceChange_organizationId_idx" ON "TrainingAttendanceChange"("organizationId");

-- AddForeignKey
ALTER TABLE "TrainingAttendanceChange" ADD CONSTRAINT "TrainingAttendanceChange_trainingEventId_organizationId_fkey" FOREIGN KEY ("trainingEventId", "organizationId") REFERENCES "TrainingEvent"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAttendanceChange" ADD CONSTRAINT "TrainingAttendanceChange_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
