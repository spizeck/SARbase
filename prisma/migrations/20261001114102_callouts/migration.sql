-- CreateEnum
CREATE TYPE "CalloutStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "CalloutAudience" AS ENUM ('ORGANIZATION', 'UNIT', 'MEMBERS');

-- CreateEnum
CREATE TYPE "CalloutResponse" AS ENUM ('COMING', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "CalloutResponseSource" AS ENUM ('TOKEN_LINK', 'ACCOUNT', 'ADMIN');

-- CreateTable
CREATE TABLE "Callout" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdByAuthIdentityId" TEXT NOT NULL,
    "audience" "CalloutAudience" NOT NULL,
    "unitId" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT,
    "activationKey" TEXT NOT NULL,
    "intentHash" TEXT NOT NULL,
    "status" "CalloutStatus" NOT NULL DEFAULT 'ACTIVE',
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedByAuthIdentityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Callout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalloutInvitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "calloutId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "notificationId" TEXT,
    "responseTokenHash" TEXT NOT NULL,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "response" "CalloutResponse",
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalloutInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalloutResponseChange" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invitationId" TEXT NOT NULL,
    "previousResponse" "CalloutResponse",
    "response" "CalloutResponse" NOT NULL,
    "source" "CalloutResponseSource" NOT NULL,
    "actorAuthIdentityId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalloutResponseChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Callout_organizationId_activatedAt_idx" ON "Callout"("organizationId", "activatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Callout_organizationId_activationKey_key" ON "Callout"("organizationId", "activationKey");

-- CreateIndex
CREATE UNIQUE INDEX "Callout_id_organizationId_key" ON "Callout"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CalloutInvitation_responseTokenHash_key" ON "CalloutInvitation"("responseTokenHash");

-- CreateIndex
CREATE INDEX "CalloutInvitation_organizationId_invitedAt_idx" ON "CalloutInvitation"("organizationId", "invitedAt");

-- CreateIndex
CREATE INDEX "CalloutInvitation_calloutId_response_idx" ON "CalloutInvitation"("calloutId", "response");

-- CreateIndex
CREATE UNIQUE INDEX "CalloutInvitation_calloutId_memberId_key" ON "CalloutInvitation"("calloutId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "CalloutInvitation_id_organizationId_key" ON "CalloutInvitation"("id", "organizationId");

-- CreateIndex
CREATE INDEX "CalloutResponseChange_organizationId_createdAt_idx" ON "CalloutResponseChange"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "CalloutResponseChange_invitationId_createdAt_idx" ON "CalloutResponseChange"("invitationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Callout" ADD CONSTRAINT "Callout_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Callout" ADD CONSTRAINT "Callout_unitId_organizationId_fkey" FOREIGN KEY ("unitId", "organizationId") REFERENCES "Unit"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalloutInvitation" ADD CONSTRAINT "CalloutInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalloutInvitation" ADD CONSTRAINT "CalloutInvitation_calloutId_organizationId_fkey" FOREIGN KEY ("calloutId", "organizationId") REFERENCES "Callout"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalloutInvitation" ADD CONSTRAINT "CalloutInvitation_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalloutInvitation" ADD CONSTRAINT "CalloutInvitation_notificationId_organizationId_fkey" FOREIGN KEY ("notificationId", "organizationId") REFERENCES "Notification"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalloutResponseChange" ADD CONSTRAINT "CalloutResponseChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalloutResponseChange" ADD CONSTRAINT "CalloutResponseChange_invitationId_organizationId_fkey" FOREIGN KEY ("invitationId", "organizationId") REFERENCES "CalloutInvitation"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
