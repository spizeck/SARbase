-- CreateIndex
CREATE UNIQUE INDEX "Member_organizationId_authIdentityId_key" ON "Member"("organizationId", "authIdentityId");
