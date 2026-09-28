-- CreateEnum
CREATE TYPE "TrainingEventStatus" AS ENUM ('COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "TrainingEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "unitId" TEXT,
    "title" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "durationMinutes" INTEGER,
    "location" TEXT,
    "instructorName" TEXT,
    "leadMemberId" TEXT,
    "notes" TEXT,
    "followUp" TEXT,
    "status" "TrainingEventStatus" NOT NULL DEFAULT 'COMPLETED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingTopic" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "trainingEventId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingAttendance" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "trainingEventId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrainingEvent_organizationId_date_idx" ON "TrainingEvent"("organizationId", "date");

-- CreateIndex
CREATE INDEX "TrainingEvent_unitId_idx" ON "TrainingEvent"("unitId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingEvent_id_organizationId_key" ON "TrainingEvent"("id", "organizationId");

-- CreateIndex
CREATE INDEX "TrainingTopic_label_idx" ON "TrainingTopic"("label");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingTopic_trainingEventId_label_key" ON "TrainingTopic"("trainingEventId", "label");

-- CreateIndex
CREATE INDEX "TrainingAttendance_memberId_idx" ON "TrainingAttendance"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAttendance_trainingEventId_memberId_key" ON "TrainingAttendance"("trainingEventId", "memberId");

-- AddForeignKey
ALTER TABLE "TrainingEvent" ADD CONSTRAINT "TrainingEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingEvent" ADD CONSTRAINT "TrainingEvent_unitId_organizationId_fkey" FOREIGN KEY ("unitId", "organizationId") REFERENCES "Unit"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingEvent" ADD CONSTRAINT "TrainingEvent_leadMemberId_organizationId_fkey" FOREIGN KEY ("leadMemberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingTopic" ADD CONSTRAINT "TrainingTopic_trainingEventId_organizationId_fkey" FOREIGN KEY ("trainingEventId", "organizationId") REFERENCES "TrainingEvent"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAttendance" ADD CONSTRAINT "TrainingAttendance_trainingEventId_organizationId_fkey" FOREIGN KEY ("trainingEventId", "organizationId") REFERENCES "TrainingEvent"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAttendance" ADD CONSTRAINT "TrainingAttendance_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

