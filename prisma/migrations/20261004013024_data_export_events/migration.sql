-- CreateTable
CREATE TABLE "DataExportEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorAuthIdentityId" TEXT NOT NULL,
    "exportType" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "filters" JSONB,
    "recordCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataExportEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DataExportEvent_organizationId_createdAt_idx" ON "DataExportEvent"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "DataExportEvent" ADD CONSTRAINT "DataExportEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
