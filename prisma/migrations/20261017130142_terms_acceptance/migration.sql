-- CreateTable
CREATE TABLE "TermsAcceptance" (
    "id" TEXT NOT NULL,
    "authIdentityId" TEXT NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "termsHash" TEXT NOT NULL,
    "privacyVersion" TEXT NOT NULL,
    "privacyHash" TEXT NOT NULL,
    "mechanism" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TermsAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TermsAcceptance_authIdentityId_idx" ON "TermsAcceptance"("authIdentityId");

-- CreateIndex
CREATE UNIQUE INDEX "TermsAcceptance_authIdentityId_termsVersion_key" ON "TermsAcceptance"("authIdentityId", "termsVersion");
