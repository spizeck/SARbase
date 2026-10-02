-- DropForeignKey
ALTER TABLE "IncidentNoteCorrection" DROP CONSTRAINT "IncidentNoteCorrection_noteId_organizationId_fkey";

-- DropIndex
DROP INDEX "IncidentNote_id_organizationId_key";

-- CreateIndex
CREATE UNIQUE INDEX "IncidentNote_id_incidentId_organizationId_key" ON "IncidentNote"("id", "incidentId", "organizationId");

-- AddForeignKey
ALTER TABLE "IncidentNoteCorrection" ADD CONSTRAINT "IncidentNoteCorrection_noteId_incidentId_organizationId_fkey" FOREIGN KEY ("noteId", "incidentId", "organizationId") REFERENCES "IncidentNote"("id", "incidentId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
