-- CreateTable
CREATE TABLE "BootstrapItem" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BootstrapItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BootstrapItem_createdAt_idx" ON "BootstrapItem"("createdAt");
