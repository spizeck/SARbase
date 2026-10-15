-- CreateEnum
CREATE TYPE "MemberInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "MemberInvitationAction" AS ENUM ('CREATED', 'RESENT', 'REVOKED', 'ACCEPTED');

-- CreateTable
CREATE TABLE "MemberInvitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'MEMBER',
    "tokenHash" TEXT NOT NULL,
    "tokenVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "MemberInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "notificationId" TEXT,
    "createdByAuthIdentityId" TEXT,
    "acceptedByAuthIdentityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "MemberInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberInvitationEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invitationId" TEXT NOT NULL,
    "action" "MemberInvitationAction" NOT NULL,
    "actorAuthIdentityId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberInvitationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemberInvitation_memberId_key" ON "MemberInvitation"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberInvitation_tokenHash_key" ON "MemberInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "MemberInvitation_organizationId_status_idx" ON "MemberInvitation"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MemberInvitation_id_organizationId_key" ON "MemberInvitation"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberInvitation_memberId_organizationId_key" ON "MemberInvitation"("memberId", "organizationId");

-- CreateIndex
CREATE INDEX "MemberInvitationEvent_invitationId_createdAt_idx" ON "MemberInvitationEvent"("invitationId", "createdAt");

-- CreateIndex
CREATE INDEX "MemberInvitationEvent_organizationId_createdAt_idx" ON "MemberInvitationEvent"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "MemberInvitation" ADD CONSTRAINT "MemberInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberInvitation" ADD CONSTRAINT "MemberInvitation_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberInvitation" ADD CONSTRAINT "MemberInvitation_notificationId_organizationId_fkey" FOREIGN KEY ("notificationId", "organizationId") REFERENCES "Notification"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberInvitationEvent" ADD CONSTRAINT "MemberInvitationEvent_invitationId_organizationId_fkey" FOREIGN KEY ("invitationId", "organizationId") REFERENCES "MemberInvitation"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberInvitationEvent" ADD CONSTRAINT "MemberInvitationEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- New-organization default timezone (Saba SAR: UTC−04:00, no DST).
-- Changes only the column default — existing rows are untouched.
ALTER TABLE "Organization" ALTER COLUMN "timezone" SET DEFAULT 'America/Kralendijk';
