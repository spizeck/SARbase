-- CreateEnum
CREATE TYPE "PreferredContactChannel" AS ENUM ('EMAIL', 'WHATSAPP');

-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'WHATSAPP';

-- AlterTable
ALTER TABLE "MemberNotificationPreference" ADD COLUMN     "preferredChannel" "PreferredContactChannel",
ADD COLUMN     "whatsappConsentAt" TIMESTAMP(3),
ADD COLUMN     "whatsappConsentRecordedByIdentityId" TEXT,
ADD COLUMN     "whatsappOptedOutAt" TIMESTAMP(3);
