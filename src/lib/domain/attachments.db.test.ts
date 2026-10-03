import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Database-backed tests for issue #16 attachments and organization
 * documents. They run only via `npm run test:db` (DATABASE_URL
 * present) — fixtures are prefixed `att16test-` and cleaned up in
 * afterAll. All storage goes through the deterministic in-memory
 * provider — no real filesystem or object store is touched.
 */

import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { InMemoryFileStorageProvider } from "@/lib/storage/memory";
import {
  addOrganizationDocumentVersion,
  createOrganizationDocument,
  deleteAttachment,
  listEntityAttachments,
  listOrganizationDocuments,
  openAttachmentDownload,
  setOrganizationDocumentStatus,
  unlinkAttachment,
  uploadAttachment,
  AttachmentDeletedError,
  AttachmentReasonRequiredError,
  CrossOrganizationAttachmentError,
  type AttachmentFileInput,
} from "./attachments";
import { createIncident, transitionIncidentStatus } from "./incidents";

const hasDb = Boolean(process.env.DATABASE_URL);
// Run-scoped prefix: a crashed afterAll can never collide with or be
// mis-cleaned by a later run.
const PREFIX = `att16test-${Date.now().toString(36)}-`;

let counter = 0;
function uniq(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

const PDF_FILE: AttachmentFileInput = {
  name: "inspection-sheet.pdf",
  mediaType: "application/pdf",
  bytes: new TextEncoder().encode("%PDF-1.4 synthetic test fixture"),
};

let orgA: { id: string };
let orgB: { id: string };
let actorA: { id: string };
let assetA: { id: string };
let assetB: { id: string };
let incidentA: { id: string };
let noteA: { id: string };
let qualificationA: { id: string };
let trainingA: { id: string };
let inspectionRecordA: { id: string };
let maintenanceRecordA: { id: string };
let defectA: { id: string };

let storage: InMemoryFileStorageProvider;

async function upload(
  entityType: Parameters<typeof uploadAttachment>[0]["type"],
  entityId: string,
  options: Parameters<typeof uploadAttachment>[2] = {},
) {
  return uploadAttachment(
    { type: entityType, id: entityId },
    { ...PDF_FILE, name: uniq("file.pdf") },
    options,
    actorA.id,
    storage,
  );
}

async function eventActions(attachmentId: string) {
  const events = await prisma.attachmentEvent.findMany({
    where: { attachmentId },
    orderBy: { createdAt: "asc" },
  });
  return events.map((e) => e.action);
}

describe.skipIf(!hasDb)("attachments (issue #16)", () => {
  beforeAll(async () => {
    storage = new InMemoryFileStorageProvider();
    orgA = await prisma.organization.create({ data: { name: uniq("org-a") } });
    orgB = await prisma.organization.create({ data: { name: uniq("org-b") } });
    actorA = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("actor"),
        email: `${uniq("actor")}@example.test`,
      },
    });
    const memberA = await prisma.member.create({
      data: { organizationId: orgA.id, displayName: uniq("member") },
    });
    assetA = await prisma.asset.create({
      data: { organizationId: orgA.id, name: uniq("asset") },
    });
    assetB = await prisma.asset.create({
      data: { organizationId: orgB.id, name: uniq("asset") },
    });
    incidentA = await createIncident(
      orgA.id,
      { title: uniq("incident") },
      actorA.id,
    );
    noteA = await prisma.incidentNote.create({
      data: {
        organizationId: orgA.id,
        incidentId: incidentA.id,
        authorAuthIdentityId: actorA.id,
        body: "note body",
      },
    });
    const definition = await prisma.qualificationDefinition.create({
      data: { organizationId: orgA.id, name: uniq("qual") },
    });
    qualificationA = await prisma.memberQualification.create({
      data: {
        organizationId: orgA.id,
        memberId: memberA.id,
        definitionId: definition.id,
      },
    });
    trainingA = await prisma.trainingEvent.create({
      data: {
        organizationId: orgA.id,
        title: uniq("training"),
        date: new Date("2026-01-10T00:00:00Z"),
      },
    });
    const inspectionDefinition = await prisma.inspectionDefinition.create({
      data: { organizationId: orgA.id, name: uniq("insp") },
    });
    inspectionRecordA = await prisma.inspectionRecord.create({
      data: {
        organizationId: orgA.id,
        assetId: assetA.id,
        definitionId: inspectionDefinition.id,
        performedOn: new Date("2026-01-10T00:00:00Z"),
      },
    });
    maintenanceRecordA = await prisma.maintenanceRecord.create({
      data: {
        organizationId: orgA.id,
        assetId: assetA.id,
        performedOn: new Date("2026-01-10T00:00:00Z"),
        title: uniq("service"),
      },
    });
    defectA = await prisma.defect.create({
      data: {
        organizationId: orgA.id,
        assetId: assetA.id,
        reportedOn: new Date("2026-01-10T00:00:00Z"),
        title: uniq("defect"),
      },
    });
  });

  afterAll(async () => {
    const orgFilter = { organization: { name: { startsWith: PREFIX } } };
    await prisma.incidentNoteAttachment.deleteMany({ where: orgFilter });
    await prisma.incidentAttachment.deleteMany({ where: orgFilter });
    await prisma.memberQualificationAttachment.deleteMany({
      where: orgFilter,
    });
    await prisma.trainingEventAttachment.deleteMany({ where: orgFilter });
    await prisma.assetAttachment.deleteMany({ where: orgFilter });
    await prisma.inspectionRecordAttachment.deleteMany({ where: orgFilter });
    await prisma.maintenanceRecordAttachment.deleteMany({ where: orgFilter });
    await prisma.defectAttachment.deleteMany({ where: orgFilter });
    await prisma.organizationDocumentVersion.deleteMany({ where: orgFilter });
    await prisma.organizationDocument.deleteMany({ where: orgFilter });
    await prisma.attachmentEvent.deleteMany({ where: orgFilter });
    await prisma.attachment.deleteMany({ where: orgFilter });
    await prisma.incidentNote.deleteMany({ where: orgFilter });
    await prisma.incidentTimelineEvent.deleteMany({ where: orgFilter });
    await prisma.incidentChange.deleteMany({ where: orgFilter });
    await prisma.incidentMember.deleteMany({ where: orgFilter });
    await prisma.incidentAsset.deleteMany({ where: orgFilter });
    await prisma.incidentSequence.deleteMany({ where: orgFilter });
    await prisma.incident.deleteMany({ where: orgFilter });
    await prisma.inspectionRecord.deleteMany({ where: orgFilter });
    await prisma.maintenanceRecord.deleteMany({ where: orgFilter });
    await prisma.defect.deleteMany({ where: orgFilter });
    await prisma.inspectionDefinition.deleteMany({ where: orgFilter });
    // MemberQualification has no `organization` relation — reach the org
    // through its member.
    await prisma.memberQualification.deleteMany({
      where: { member: { organization: { name: { startsWith: PREFIX } } } },
    });
    await prisma.qualificationDefinition.deleteMany({ where: orgFilter });
    await prisma.trainingEvent.deleteMany({ where: orgFilter });
    await prisma.member.deleteMany({ where: orgFilter });
    await prisma.asset.deleteMany({ where: orgFilter });
    await prisma.authIdentity.deleteMany({
      where: { providerUid: { startsWith: PREFIX } },
    });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  /* ---------------- upload ---------------- */

  it("uploads a file onto an incident: metadata, link, object, and audit", async () => {
    const attachment = await upload("INCIDENT", incidentA.id, {
      description: "scene photo",
    });

    expect(attachment.organizationId).toBe(orgA.id);
    expect(attachment.displayFilename).toMatch(/\.pdf$/);
    expect(attachment.mediaType).toBe("application/pdf");
    expect(attachment.sizeBytes).toBe(PDF_FILE.bytes.byteLength);
    expect(attachment.checksumSha256).toBe(
      createHash("sha256").update(PDF_FILE.bytes).digest("hex"),
    );
    expect(attachment.storageProvider).toBe("memory");
    // Opaque key — no filename, no incident reference, no title.
    expect(attachment.storageKey).toMatch(
      /^organizations\/.+\/attachments\/[0-9a-f-]{36}$/,
    );
    expect(attachment.storageKey).not.toContain(".pdf");
    expect(attachment.uploadedByAuthIdentityId).toBe(actorA.id);
    expect(attachment.status).toBe("ACTIVE");

    // Link row exists and the object is in storage.
    const link = await prisma.incidentAttachment.findFirst({
      where: { incidentId: incidentA.id, attachmentId: attachment.id },
    });
    expect(link).not.toBeNull();
    expect(storage.objects.has(attachment.storageKey)).toBe(true);

    // Audit: UPLOADED then LINKED, plus the incident timeline mirror.
    expect(await eventActions(attachment.id)).toEqual(["UPLOADED", "LINKED"]);
    const timeline = await prisma.incidentTimelineEvent.findMany({
      where: { incidentId: incidentA.id, type: "ATTACHMENT_ADDED" },
    });
    expect(timeline).toHaveLength(1);
  });

  it("uploads onto every supported entity type", async () => {
    const targets: [Parameters<typeof uploadAttachment>[0]["type"], string][] =
      [
        ["INCIDENT_NOTE", noteA.id],
        ["MEMBER_QUALIFICATION", qualificationA.id],
        ["TRAINING_EVENT", trainingA.id],
        ["ASSET", assetA.id],
        ["INSPECTION_RECORD", inspectionRecordA.id],
        ["MAINTENANCE_RECORD", maintenanceRecordA.id],
        ["DEFECT", defectA.id],
      ];
    for (const [type, id] of targets) {
      const attachment = await upload(type, id);
      const rows = await listEntityAttachments(type, id);
      expect(rows.map((r) => r.attachment.id)).toContain(attachment.id);
    }
  });

  it("rejects a fabricated entity id before any object is stored", async () => {
    const before = storage.calls.filter((c) => c.op === "put").length;
    await expect(upload("ASSET", "nonexistent")).rejects.toBeInstanceOf(
      CrossOrganizationAttachmentError,
    );
    await expect(upload("ASSET", "nonexistent-2")).rejects.toBeInstanceOf(
      CrossOrganizationAttachmentError,
    );
    // No bytes touched storage — the check precedes the provider call.
    expect(storage.calls.filter((c) => c.op === "put").length).toBe(before);
  });

  it("cleans up the stored object when metadata persistence fails", async () => {
    const txSpy = vi
      .spyOn(prisma, "$transaction")
      .mockRejectedValueOnce(new Error("synthetic db failure"));
    const putsBefore = storage.calls.filter((c) => c.op === "put").length;
    await expect(upload("ASSET", assetA.id)).rejects.toThrow(
      "synthetic db failure",
    );
    txSpy.mockRestore();

    // The object was stored then compensated: a put with no surviving
    // attachment row must have a matching delete in the call ledger.
    const newKey = storage.calls.filter((c) => c.op === "put").at(-1)!.key;
    expect(storage.calls.filter((c) => c.op === "put").length).toBe(
      putsBefore + 1,
    );
    expect(
      storage.calls.some((c) => c.op === "delete" && c.key === newKey),
    ).toBe(true);
    expect(storage.objects.has(newKey)).toBe(false);
    expect(
      await prisma.attachment.findFirst({ where: { storageKey: newKey } }),
    ).toBeNull();
  });

  /* ---------------- cross-organization integrity ---------------- */

  it("makes a cross-organization link physically impossible at the DB level", async () => {
    const attachment = await upload("ASSET", assetA.id);
    // Try to link orgA's attachment to orgB's asset by hand — the
    // composite FK (assetId, organizationId) → Asset cannot resolve.
    await expect(
      prisma.assetAttachment.create({
        data: {
          organizationId: orgA.id,
          assetId: assetB.id,
          attachmentId: attachment.id,
          createdByAuthIdentityId: actorA.id,
        },
      }),
    ).rejects.toThrow();
    // And with orgB's organizationId — the attachment side fails instead.
    await expect(
      prisma.assetAttachment.create({
        data: {
          organizationId: orgB.id,
          assetId: assetB.id,
          attachmentId: attachment.id,
          createdByAuthIdentityId: actorA.id,
        },
      }),
    ).rejects.toThrow();
  });

  it("prevents duplicate links on the same record", async () => {
    const attachment = await upload("ASSET", assetA.id);
    await expect(
      prisma.assetAttachment.create({
        data: {
          organizationId: orgA.id,
          assetId: assetA.id,
          attachmentId: attachment.id,
          createdByAuthIdentityId: actorA.id,
        },
      }),
    ).rejects.toThrow(); // unique (assetId, attachmentId)
  });

  /* ---------------- unlink ---------------- */

  it("unlinks an attachment: link row gone, audit preserved, file survives", async () => {
    const attachment = await upload("DEFECT", defectA.id);
    const result = await unlinkAttachment(
      { type: "DEFECT", id: defectA.id },
      attachment.id,
      {},
      actorA.id,
    );
    expect(result.unlinked).toBe(true);

    const rows = await listEntityAttachments("DEFECT", defectA.id);
    expect(rows.map((r) => r.attachment.id)).not.toContain(attachment.id);

    // Metadata + object still exist; the audit row records the unlink.
    const row = await prisma.attachment.findUniqueOrThrow({
      where: { id: attachment.id },
    });
    expect(row.status).toBe("ACTIVE");
    expect(storage.objects.has(row.storageKey)).toBe(true);
    expect(await eventActions(attachment.id)).toEqual([
      "UPLOADED",
      "LINKED",
      "UNLINKED",
    ]);

    // Repeated unlink is a quiet no-op.
    const again = await unlinkAttachment(
      { type: "DEFECT", id: defectA.id },
      attachment.id,
      {},
      actorA.id,
    );
    expect(again.unlinked).toBe(false);
  });

  it("rejects unlinking a foreign-org attachment id opaquely", async () => {
    // A DEFECT in orgA named with an attachment from orgB's space fails
    // before touching any row.
    await expect(
      unlinkAttachment(
        { type: "DEFECT", id: defectA.id },
        "does-not-exist",
        {},
        actorA.id,
      ),
    ).rejects.toBeInstanceOf(CrossOrganizationAttachmentError);
  });

  /* ---------------- delete ---------------- */

  it("tombstones the record, deletes the object, and audits the outcome", async () => {
    const attachment = await upload("TRAINING_EVENT", trainingA.id);
    const deleted = await deleteAttachment(
      attachment.id,
      {},
      actorA.id,
      storage,
    );

    const row = await prisma.attachment.findUniqueOrThrow({
      where: { id: deleted.id },
    });
    expect(row.status).toBe("DELETED");
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedByAuthIdentityId).toBe(actorA.id);
    expect(storage.objects.has(row.storageKey)).toBe(false);

    const events = await prisma.attachmentEvent.findMany({
      where: { attachmentId: deleted.id, action: "DELETED" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.storageDeleted).toBe(true);

    // The metadata record survives — history proves the file existed.
    expect(row.displayFilename).toBeTruthy();

    // Repeated delete is a no-op, not a second tombstone or event.
    await deleteAttachment(attachment.id, {}, actorA.id, storage);
    const eventsAfter = await prisma.attachmentEvent.findMany({
      where: { attachmentId: deleted.id, action: "DELETED" },
    });
    expect(eventsAfter).toHaveLength(1);
  });

  it("records storageDeleted=false and reports failure honestly", async () => {
    const attachment = await upload("TRAINING_EVENT", trainingA.id);
    storage.failNext("provider_unavailable");
    await expect(
      deleteAttachment(attachment.id, {}, actorA.id, storage),
    ).rejects.toMatchObject({ code: "provider_unavailable" });

    const row = await prisma.attachment.findUniqueOrThrow({
      where: { id: attachment.id },
    });
    expect(row.status).toBe("DELETED"); // tombstone kept — honest state
    const events = await prisma.attachmentEvent.findMany({
      where: { attachmentId: attachment.id, action: "DELETED" },
    });
    expect(events[0]!.storageDeleted).toBe(false);
    // The object is still in storage — nothing claimed it was removed.
    expect(storage.objects.has(row.storageKey)).toBe(true);

    // Retrying the delete on an already-tombstoned record retries the
    // physical removal and appends a second honest DELETED event.
    await deleteAttachment(attachment.id, {}, actorA.id, storage);
    expect(storage.objects.has(row.storageKey)).toBe(false);
    const eventsAfter = await prisma.attachmentEvent.findMany({
      where: { attachmentId: attachment.id, action: "DELETED" },
      orderBy: { createdAt: "asc" },
    });
    expect(eventsAfter).toHaveLength(2);
    expect(eventsAfter[1]!.storageDeleted).toBe(true);
  });

  /* ---------------- download ---------------- */

  it("streams an authorized download for an ACTIVE attachment", async () => {
    const attachment = await upload("ASSET", assetA.id);
    const download = await openAttachmentDownload(attachment, storage);
    expect(download.displayFilename).toBe(attachment.displayFilename);
    expect(download.mediaType).toBe("application/pdf");
    const reader = download.stream.getReader();
    const { value } = await reader.read();
    expect(Buffer.from(value!).toString()).toContain("%PDF-1.4");
  });

  it("refuses a download for a tombstoned attachment", async () => {
    const attachment = await upload("ASSET", assetA.id);
    await deleteAttachment(attachment.id, {}, actorA.id, storage);
    const row = await prisma.attachment.findUniqueOrThrow({
      where: { id: attachment.id },
    });
    await expect(openAttachmentDownload(row, storage)).rejects.toBeInstanceOf(
      AttachmentDeletedError,
    );
  });

  /* ---------------- closed incidents ---------------- */

  it("requires a reason for attachment mutations on a CLOSED incident", async () => {
    const incident = await createIncident(
      orgA.id,
      { title: uniq("closed") },
      actorA.id,
    );
    await transitionIncidentStatus(incident.id, "CLOSED", actorA.id);

    // Upload without a reason fails closed — and precedes storage, so
    // no object is written.
    const putsBefore = storage.calls.filter((c) => c.op === "put").length;
    await expect(upload("INCIDENT", incident.id)).rejects.toBeInstanceOf(
      AttachmentReasonRequiredError,
    );
    expect(storage.calls.filter((c) => c.op === "put").length).toBe(putsBefore);

    // With a reason the mutation succeeds and is double-audited.
    const attachment = await upload("INCIDENT", incident.id, {
      reason: "late evidence received",
    });
    const added = await prisma.incidentTimelineEvent.findFirst({
      where: { incidentId: incident.id, type: "ATTACHMENT_ADDED" },
    });
    expect(added).not.toBeNull();
    expect((added!.metadata as { reason?: string }).reason).toBe(
      "late evidence received",
    );

    // Unlink without a reason fails; with a reason it audits.
    await expect(
      unlinkAttachment(
        { type: "INCIDENT", id: incident.id },
        attachment.id,
        {},
        actorA.id,
      ),
    ).rejects.toBeInstanceOf(AttachmentReasonRequiredError);
    await unlinkAttachment(
      { type: "INCIDENT", id: incident.id },
      attachment.id,
      { reason: "file uploaded to wrong incident" },
      actorA.id,
    );
    const removed = await prisma.incidentTimelineEvent.findFirst({
      where: { incidentId: incident.id, type: "ATTACHMENT_REMOVED" },
    });
    expect(removed).not.toBeNull();
  });

  it("requires a reason when deleting a file still linked to a CLOSED incident", async () => {
    const incident = await createIncident(
      orgA.id,
      { title: uniq("closed-del") },
      actorA.id,
    );
    const attachment = await upload("INCIDENT", incident.id);
    await transitionIncidentStatus(incident.id, "CLOSED", actorA.id);

    await expect(
      deleteAttachment(attachment.id, {}, actorA.id, storage),
    ).rejects.toBeInstanceOf(AttachmentReasonRequiredError);

    await deleteAttachment(
      attachment.id,
      { reason: "removed erroneous file" },
      actorA.id,
      storage,
    );
    const row = await prisma.attachment.findUniqueOrThrow({
      where: { id: attachment.id },
    });
    expect(row.status).toBe("DELETED");
    // The destruction is mirrored onto the incident timeline, the same
    // way an unlink is — the record's feed shows the evidence went away.
    const removed = await prisma.incidentTimelineEvent.findFirst({
      where: { incidentId: incident.id, type: "ATTACHMENT_REMOVED" },
    });
    expect(removed).not.toBeNull();
    expect((removed!.metadata as { reason?: string }).reason).toBe(
      "removed erroneous file",
    );
  });

  /* ---------------- organization documents ---------------- */

  it("creates a document with version 1 and full audit", async () => {
    const document = await createOrganizationDocument(
      orgA.id,
      { ...PDF_FILE, name: "sop-manual.pdf" },
      {
        title: "Operations Manual",
        category: "SOP",
        effectiveOn: new Date("2026-01-01T00:00:00Z"),
      },
      "initial version",
      actorA.id,
      storage,
    );

    const versions = await prisma.organizationDocumentVersion.findMany({
      where: { documentId: document.id },
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.versionNumber).toBe(1);

    const attachment = await prisma.attachment.findUniqueOrThrow({
      where: { id: versions[0]!.attachmentId },
    });
    expect(await eventActions(attachment.id)).toEqual(["UPLOADED", "LINKED"]);
    const linkEvent = await prisma.attachmentEvent.findFirstOrThrow({
      where: { attachmentId: attachment.id, action: "LINKED" },
    });
    expect(linkEvent.entityType).toBe("ORGANIZATION_DOCUMENT");
    expect(linkEvent.entityId).toBe(document.id);
  });

  it("appends versions without overwriting history", async () => {
    const document = await createOrganizationDocument(
      orgA.id,
      { ...PDF_FILE, name: "policy-v1.pdf" },
      { title: "Safety Policy", category: "Policy" },
      null,
      actorA.id,
      storage,
    );
    const v2 = await addOrganizationDocumentVersion(
      document.id,
      { ...PDF_FILE, name: "policy-v2.pdf" },
      "2026 renewal",
      actorA.id,
      storage,
    );
    expect(v2.versionNumber).toBe(2);

    const versions = await prisma.organizationDocumentVersion.findMany({
      where: { documentId: document.id },
      orderBy: { versionNumber: "asc" },
    });
    expect(versions).toHaveLength(2);
    // Both files survive — replacing a document never rewrites history.
    expect(versions[0]!.attachmentId).not.toBe(versions[1]!.attachmentId);
    for (const v of versions) {
      const attachment = await prisma.attachment.findUniqueOrThrow({
        where: { id: v.attachmentId },
      });
      expect(storage.objects.has(attachment.storageKey)).toBe(true);
    }
  });

  it("lists documents with their current version and archives without deleting", async () => {
    const document = await createOrganizationDocument(
      orgA.id,
      { ...PDF_FILE, name: "insurance.pdf" },
      { title: "Insurance Certificate", category: "Insurance" },
      null,
      actorA.id,
      storage,
    );

    const list = await listOrganizationDocuments(orgA.id);
    const row = list.find((d) => d.id === document.id);
    expect(row).toBeDefined();
    expect(row!.versions[0]!.versionNumber).toBe(1);

    await setOrganizationDocumentStatus(document.id, "ARCHIVED", actorA.id);
    const archived = await prisma.organizationDocument.findUniqueOrThrow({
      where: { id: document.id },
    });
    expect(archived.status).toBe("ARCHIVED");
    // Archiving is presentation-only — the file stays downloadable.
    const version = await prisma.organizationDocumentVersion.findFirstOrThrow({
      where: { documentId: document.id },
    });
    const attachment = await prisma.attachment.findUniqueOrThrow({
      where: { id: version.attachmentId },
    });
    await expect(
      openAttachmentDownload(attachment, storage),
    ).resolves.toBeDefined();
  });
});
