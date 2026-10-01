-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SUPPRESSED', 'ACCEPTED', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationAttemptStatus" AS ENUM ('DISPATCHING', 'ACCEPTED', 'FAILED');

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT,
    "channel" "NotificationChannel" NOT NULL,
    "template" TEXT NOT NULL,
    "subject" TEXT,
    "bodyText" TEXT,
    "destination" TEXT,
    "metadata" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "intentHash" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "statusReason" TEXT,
    "requestedByAuthIdentityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationAttempt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "NotificationAttemptStatus" NOT NULL DEFAULT 'DISPATCHING',
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    "errorSummary" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "NotificationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_organizationId_createdAt_idx" ON "Notification"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_memberId_createdAt_idx" ON "Notification"("memberId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_organizationId_idempotencyKey_key" ON "Notification"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_id_organizationId_key" ON "Notification"("id", "organizationId");

-- CreateIndex
CREATE INDEX "NotificationAttempt_organizationId_attemptedAt_idx" ON "NotificationAttempt"("organizationId", "attemptedAt");

-- CreateIndex
CREATE INDEX "NotificationAttempt_notificationId_idx" ON "NotificationAttempt"("notificationId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationAttempt_notificationId_attemptNumber_key" ON "NotificationAttempt"("notificationId", "attemptNumber");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationAttempt" ADD CONSTRAINT "NotificationAttempt_notificationId_organizationId_fkey" FOREIGN KEY ("notificationId", "organizationId") REFERENCES "Notification"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationAttempt" ADD CONSTRAINT "NotificationAttempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
