-- AlterTable: existing organizations default to UTC — operators should
-- set the organization's real IANA timezone in organization settings.
ALTER TABLE "Organization" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';
