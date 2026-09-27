/*
  Warnings:

  - You are about to drop the `BootstrapItem` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- DropTable
DROP TABLE "BootstrapItem";

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberUnit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberUnit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Unit_organizationId_idx" ON "Unit"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_organizationId_name_key" ON "Unit"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_id_organizationId_key" ON "Unit"("id", "organizationId");

-- CreateIndex
CREATE INDEX "Member_organizationId_status_idx" ON "Member"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Member_email_idx" ON "Member"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Member_id_organizationId_key" ON "Member"("id", "organizationId");

-- CreateIndex
CREATE INDEX "MemberUnit_unitId_idx" ON "MemberUnit"("unitId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberUnit_memberId_unitId_key" ON "MemberUnit"("memberId", "unitId");

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberUnit" ADD CONSTRAINT "MemberUnit_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberUnit" ADD CONSTRAINT "MemberUnit_unitId_organizationId_fkey" FOREIGN KEY ("unitId", "organizationId") REFERENCES "Unit"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
