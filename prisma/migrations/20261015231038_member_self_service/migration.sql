-- CreateEnum
CREATE TYPE "MemberSubmissionKind" AS ENUM ('QUALIFICATION_CLAIM', 'RECORD_CORRECTION');

-- CreateEnum
CREATE TYPE "MemberSubmissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "emergencyContactName" TEXT,
ADD COLUMN     "emergencyContactPhone" TEXT;

-- CreateTable
CREATE TABLE "MemberContactChange" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "previousValue" TEXT,
    "newValue" TEXT,
    "selfReported" BOOLEAN NOT NULL DEFAULT false,
    "actorAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberContactChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberSubmission" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "kind" "MemberSubmissionKind" NOT NULL,
    "details" TEXT NOT NULL,
    "qualificationDefinitionId" TEXT,
    "issuedOn" DATE,
    "expiresOn" DATE,
    "issuer" TEXT,
    "reference" TEXT,
    "targetMemberQualificationId" TEXT,
    "status" "MemberSubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "submittedByAuthIdentityId" TEXT NOT NULL,
    "reviewedByAuthIdentityId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdMemberQualificationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberSubmissionAttachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberSubmissionId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "createdByAuthIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberSubmissionAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemberContactChange_memberId_createdAt_idx" ON "MemberContactChange"("memberId", "createdAt");

-- CreateIndex
CREATE INDEX "MemberContactChange_organizationId_createdAt_idx" ON "MemberContactChange"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "MemberSubmission_memberId_createdAt_idx" ON "MemberSubmission"("memberId", "createdAt");

-- CreateIndex
CREATE INDEX "MemberSubmission_organizationId_status_idx" ON "MemberSubmission"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MemberSubmission_id_organizationId_key" ON "MemberSubmission"("id", "organizationId");

-- CreateIndex
CREATE INDEX "MemberSubmissionAttachment_attachmentId_idx" ON "MemberSubmissionAttachment"("attachmentId");

-- CreateIndex
CREATE INDEX "MemberSubmissionAttachment_organizationId_memberSubmissionI_idx" ON "MemberSubmissionAttachment"("organizationId", "memberSubmissionId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberSubmissionAttachment_memberSubmissionId_attachmentId_key" ON "MemberSubmissionAttachment"("memberSubmissionId", "attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberSubmissionAttachment_id_organizationId_key" ON "MemberSubmissionAttachment"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "MemberContactChange" ADD CONSTRAINT "MemberContactChange_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberContactChange" ADD CONSTRAINT "MemberContactChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberSubmission" ADD CONSTRAINT "MemberSubmission_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "Member"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberSubmission" ADD CONSTRAINT "MemberSubmission_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberSubmission" ADD CONSTRAINT "MemberSubmission_qualificationDefinitionId_organizationId_fkey" FOREIGN KEY ("qualificationDefinitionId", "organizationId") REFERENCES "QualificationDefinition"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberSubmission" ADD CONSTRAINT "MemberSubmission_targetMemberQualificationId_organizationI_fkey" FOREIGN KEY ("targetMemberQualificationId", "organizationId") REFERENCES "MemberQualification"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberSubmission" ADD CONSTRAINT "MemberSubmission_createdMemberQualificationId_organization_fkey" FOREIGN KEY ("createdMemberQualificationId", "organizationId") REFERENCES "MemberQualification"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberSubmissionAttachment" ADD CONSTRAINT "MemberSubmissionAttachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberSubmissionAttachment" ADD CONSTRAINT "MemberSubmissionAttachment_memberSubmissionId_organization_fkey" FOREIGN KEY ("memberSubmissionId", "organizationId") REFERENCES "MemberSubmission"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberSubmissionAttachment" ADD CONSTRAINT "MemberSubmissionAttachment_attachmentId_organizationId_fkey" FOREIGN KEY ("attachmentId", "organizationId") REFERENCES "Attachment"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
