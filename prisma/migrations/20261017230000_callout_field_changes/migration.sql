-- Issue #117 — append-only audit of coordinator edits to a callout's
-- title/message. Additive only: one new table, composite same-org FK.

-- CreateTable
CREATE TABLE "CalloutChange" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "calloutId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "beforeValue" TEXT,
    "afterValue" TEXT,
    "actorAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalloutChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalloutChange_id_organizationId_key" ON "CalloutChange"("id", "organizationId");

-- CreateIndex
CREATE INDEX "CalloutChange_calloutId_createdAt_idx" ON "CalloutChange"("calloutId", "createdAt");

-- AddForeignKey
ALTER TABLE "CalloutChange" ADD CONSTRAINT "CalloutChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalloutChange" ADD CONSTRAINT "CalloutChange_calloutId_organizationId_fkey" FOREIGN KEY ("calloutId", "organizationId") REFERENCES "Callout"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
