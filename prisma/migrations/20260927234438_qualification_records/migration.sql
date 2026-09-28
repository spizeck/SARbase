-- CreateEnum
CREATE TYPE "QualificationDefinitionStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "QualificationDefinition" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "QualificationDefinitionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QualificationDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberQualification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "issuedOn" DATE,
    "expiresOn" DATE,
    "issuer" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberQualification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QualificationDefinition_organizationId_idx" ON "QualificationDefinition"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "QualificationDefinition_organizationId_name_key" ON "QualificationDefinition"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "QualificationDefinition_id_organizationId_key" ON "QualificationDefinition"("id", "organizationId");

-- CreateIndex
CREATE INDEX "MemberQualification_memberId_idx" ON "MemberQualification"("memberId");

-- CreateIndex
CREATE INDEX "MemberQualification_definitionId_idx" ON "MemberQualification"("definitionId");

-- CreateIndex
CREATE INDEX "MemberQualification_organizationId_expiresOn_idx" ON "MemberQualification"("organizationId", "expiresOn");

-- AddForeignKey
ALTER TABLE "QualificationDefinition" ADD CONSTRAINT "QualificationDefinition_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberQualification" ADD CONSTRAINT "MemberQualification_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberQualification" ADD CONSTRAINT "MemberQualification_definitionId_organizationId_fkey" FOREIGN KEY ("definitionId", "organizationId") REFERENCES "QualificationDefinition"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
