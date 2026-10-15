-- CreateEnum
CREATE TYPE "OrganizationAccessAction" AS ENUM ('ROLE_CHANGED');

-- CreateTable
CREATE TABLE "OrganizationAccessEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "targetAuthIdentityId" TEXT NOT NULL,
    "action" "OrganizationAccessAction" NOT NULL,
    "previousRole" "OrgRole" NOT NULL,
    "role" "OrgRole" NOT NULL,
    "actorAuthIdentityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationAccessEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationAccessEvent_organizationId_createdAt_idx" ON "OrganizationAccessEvent"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "OrganizationAccessEvent_targetAuthIdentityId_createdAt_idx" ON "OrganizationAccessEvent"("targetAuthIdentityId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrganizationAccessEvent" ADD CONSTRAINT "OrganizationAccessEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
