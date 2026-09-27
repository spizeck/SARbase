-- CreateEnum
CREATE TYPE "AuthIdentityStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('MEMBER', 'ADMIN');

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "authIdentityId" TEXT;

-- CreateTable
CREATE TABLE "AuthIdentity" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerUid" TEXT NOT NULL,
    "email" TEXT,
    "status" "AuthIdentityStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationAccess" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "authIdentityId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthIdentity_email_idx" ON "AuthIdentity"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AuthIdentity_provider_providerUid_key" ON "AuthIdentity"("provider", "providerUid");

-- CreateIndex
CREATE INDEX "OrganizationAccess_organizationId_idx" ON "OrganizationAccess"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationAccess_authIdentityId_organizationId_key" ON "OrganizationAccess"("authIdentityId", "organizationId");

-- CreateIndex
CREATE INDEX "Member_authIdentityId_idx" ON "Member"("authIdentityId");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_authIdentityId_fkey" FOREIGN KEY ("authIdentityId") REFERENCES "AuthIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationAccess" ADD CONSTRAINT "OrganizationAccess_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationAccess" ADD CONSTRAINT "OrganizationAccess_authIdentityId_fkey" FOREIGN KEY ("authIdentityId") REFERENCES "AuthIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
