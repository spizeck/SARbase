-- Issue #101 — WhatsApp delivery-status webhooks.
-- Additive only: new enum, one nullable column, two new indexes, one new
-- table. Existing rows are unaffected; nothing is renamed or dropped.

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('OTHER', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- AlterTable
ALTER TABLE "NotificationAttempt" ADD COLUMN     "deliveryStatus" "NotificationDeliveryStatus";

-- CreateTable
CREATE TABLE "NotificationDeliveryEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerErrorCode" TEXT,

    CONSTRAINT "NotificationDeliveryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDeliveryEvent_attemptId_status_occurredAt_key" ON "NotificationDeliveryEvent"("attemptId", "status", "occurredAt");

-- CreateIndex
CREATE INDEX "NotificationDeliveryEvent_organizationId_receivedAt_idx" ON "NotificationDeliveryEvent"("organizationId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationAttempt_id_organizationId_key" ON "NotificationAttempt"("id", "organizationId");

-- CreateIndex
CREATE INDEX "NotificationAttempt_providerMessageId_idx" ON "NotificationAttempt"("providerMessageId");

-- AddForeignKey
ALTER TABLE "NotificationDeliveryEvent" ADD CONSTRAINT "NotificationDeliveryEvent_attemptId_organizationId_fkey" FOREIGN KEY ("attemptId", "organizationId") REFERENCES "NotificationAttempt"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDeliveryEvent" ADD CONSTRAINT "NotificationDeliveryEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
