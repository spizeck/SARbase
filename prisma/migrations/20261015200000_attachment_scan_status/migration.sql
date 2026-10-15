-- CreateEnum
CREATE TYPE "AttachmentScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'SCAN_FAILED', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "scanEventId" TEXT,
ADD COLUMN     "scanResultStatus" TEXT,
ADD COLUMN     "scanStatus" "AttachmentScanStatus" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "scanStatusReason" TEXT,
ADD COLUMN     "scannedAt" TIMESTAMP(3),
ADD COLUMN     "storageETag" TEXT,
ADD COLUMN     "storageVersionId" TEXT;

-- CreateTable
CREATE TABLE "AttachmentScanEvent" (
    "id" TEXT NOT NULL,
    "awsEventId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "objectVersionId" TEXT,
    "objectETag" TEXT,
    "scanStatus" TEXT NOT NULL,
    "scanResultStatus" TEXT,
    "statusReasons" TEXT[],
    "threats" JSONB,
    "attachmentId" TEXT,
    "outcome" TEXT NOT NULL,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttachmentScanEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttachmentScanEvent_awsEventId_key" ON "AttachmentScanEvent"("awsEventId");

-- CreateIndex
CREATE INDEX "AttachmentScanEvent_objectKey_idx" ON "AttachmentScanEvent"("objectKey");

-- CreateIndex
CREATE INDEX "AttachmentScanEvent_attachmentId_idx" ON "AttachmentScanEvent"("attachmentId");

-- AddForeignKey
ALTER TABLE "AttachmentScanEvent" ADD CONSTRAINT "AttachmentScanEvent_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
