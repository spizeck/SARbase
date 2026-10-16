-- CreateEnum
CREATE TYPE "OrgCapability" AS ENUM ('OPERATIONS_MANAGE', 'TRAINING_MANAGE', 'QUALIFICATIONS_MANAGE', 'QUALIFICATIONS_VERIFY', 'MEMBERS_MANAGE', 'EQUIPMENT_MANAGE', 'FINANCE_MANAGE', 'FINANCE_APPROVE', 'DOCUMENTS_MANAGE', 'NOTIFICATIONS_MANAGE', 'REPORTS_EXPORT');

-- AlterEnum
ALTER TYPE "OrgRole" ADD VALUE 'MANAGER';

-- AlterEnum
ALTER TYPE "OrganizationAccessAction" ADD VALUE 'CAPABILITIES_CHANGED';

-- AlterTable
ALTER TABLE "OrganizationAccess" ADD COLUMN     "capabilities" "OrgCapability"[];

-- AlterTable
ALTER TABLE "OrganizationAccessEvent" ADD COLUMN     "capabilities" "OrgCapability"[],
ADD COLUMN     "previousCapabilities" "OrgCapability"[],
ADD COLUMN     "reason" TEXT;
