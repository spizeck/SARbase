-- CreateEnum
CREATE TYPE "AvailabilityStatus" AS ENUM ('AVAILABLE', 'UNAVAILABLE', 'OFF_ISLAND', 'UNKNOWN');

-- CreateTable
CREATE TABLE "MemberAvailabilityUpdate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "status" "AvailabilityStatus" NOT NULL,
    "until" DATE,
    "note" TEXT,
    "selfReported" BOOLEAN NOT NULL DEFAULT false,
    "actorAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberAvailabilityUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberNotificationPreference" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "notifyEmail" BOOLEAN NOT NULL DEFAULT false,
    "notifySms" BOOLEAN NOT NULL DEFAULT false,
    "notifyWhatsapp" BOOLEAN NOT NULL DEFAULT false,
    "notifyPush" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberNotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemberAvailabilityUpdate_memberId_createdAt_idx" ON "MemberAvailabilityUpdate"("memberId", "createdAt");

-- CreateIndex
CREATE INDEX "MemberAvailabilityUpdate_organizationId_createdAt_idx" ON "MemberAvailabilityUpdate"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "MemberNotificationPreference_organizationId_idx" ON "MemberNotificationPreference"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberNotificationPreference_memberId_organizationId_key" ON "MemberNotificationPreference"("memberId", "organizationId");

-- AddForeignKey
ALTER TABLE "MemberAvailabilityUpdate" ADD CONSTRAINT "MemberAvailabilityUpdate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberAvailabilityUpdate" ADD CONSTRAINT "MemberAvailabilityUpdate_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberAvailabilityUpdate" ADD CONSTRAINT "MemberAvailabilityUpdate_actorAuthIdentityId_fkey" FOREIGN KEY ("actorAuthIdentityId") REFERENCES "AuthIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberNotificationPreference" ADD CONSTRAINT "MemberNotificationPreference_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberNotificationPreference" ADD CONSTRAINT "MemberNotificationPreference_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
