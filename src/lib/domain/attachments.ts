import { createHash, randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import type { Attachment, AttachmentEventAction } from "@prisma/client";

import { log } from "@/lib/logging";
import { prisma } from "@/lib/prisma";
import { getFileStorageProvider } from "@/lib/storage/resolve";
import { StorageError, type FileStorageProvider } from "@/lib/storage/provider";
import {
  resolveUploadTicketSecret,
  signUploadTicket,
  verifyUploadTicket,
} from "@/lib/storage/upload-ticket";

/**
 * Attachments and organizational documents (issue #16).
 *
 * PRODUCT BOUNDARY: uploaded files are documentary evidence and
 * organizational records. This module stores, serves, organizes, and
 * audits files — it never inspects file contents to draw conclusions
 * and never feeds readiness, safety, or dispatch decisions.
 *
 * Model:
 * - `Attachment` is the durable file record: sanitized display name,
 *   media type, size, SHA-256, provider name, and an opaque storage key.
 *   No blobs, no URLs, no provider-specific fields.
 * - Explicit per-entity link tables (IncidentAttachment,
 *   IncidentNoteAttachment, ...) carry composite organizationId FKs so
 *   a cross-organization link is physically impossible — no free-form
 *   polymorphic entityType strings on live relationships.
 * - `OrganizationDocument` + append-only `OrganizationDocumentVersion`
 *   cover org-level files (SOPs, manuals, insurance). The current file
 *   is the highest versionNumber; replacing a file preserves history.
 * - `AttachmentEvent` is the append-only audit trail (upload, link,
 *   unlink, delete) with scalar actor ids.
 *
 * PROTECTED-RECORD RULE: incidents carry sensitive material and
 * expenses carry financial facts. Any attachment mutation whose
 * evidence set touches a CLOSED incident — or an APPROVED or already
 * REIMBURSED expense (issue #17) — requires a human reason, recorded
 * on the AttachmentEvent and mirrored onto the record's own event
 * history. Other records accept mutations without a reason; every
 * mutation is still audited.
 */

export class AttachmentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentInputError";
  }
}

/** A selector named a record outside the caller's organization. */
export class CrossOrganizationAttachmentError extends Error {
  constructor() {
    super("A selected record belongs to another organization.");
    this.name = "CrossOrganizationAttachmentError";
  }
}

/** A protected record's evidence set changed without a reason. */
export class AttachmentReasonRequiredError extends Error {
  constructor() {
    super(
      "A reason is required to change attachments on a closed incident or an approved/reimbursed expense.",
    );
    this.name = "AttachmentReasonRequiredError";
  }
}

/** The attachment is tombstoned — metadata remains, bytes do not. */
export class AttachmentDeletedError extends Error {
  constructor() {
    super("This file has been deleted.");
    this.name = "AttachmentDeletedError";
  }
}

/**
 * The presented upload grant is forged, expired, mismatched, or already
 * spent — the caller must restart the upload to get a fresh grant.
 */
export class AttachmentUploadGrantError extends Error {
  constructor() {
    super("The upload session is no longer valid. Please try again.");
    this.name = "AttachmentUploadGrantError";
  }
}

/* ------------------------------------------------------------------ */
/* Upload policy                                                       */
/* ------------------------------------------------------------------ */

/** Conservative v1 cap: single file ≤ 25 MiB. */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export const ATTACHMENT_DISPLAY_FILENAME_MAX = 160;
export const ATTACHMENT_ORIGINAL_FILENAME_MAX = 300;
export const ATTACHMENT_DESCRIPTION_MAX = 500;

/**
 * Allowed media types mapped to their accepted filename extensions.
 * Both dimensions are enforced: the declared type must be listed AND
 * the filename extension must belong to that type. Content sniffing
 * (magic bytes) adds a third check for formats that have one — the
 * browser-supplied Content-Type is never trusted alone.
 *
 * Deliberately excluded: HTML, SVG, JavaScript, executables, archives,
 * and macro-enabled Office formats — anything a browser might execute.
 */
export const ALLOWED_ATTACHMENT_MEDIA_TYPES: Readonly<
  Record<string, readonly string[]>
> = {
  "application/pdf": [".pdf"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "text/plain": [".txt", ".log", ".md"],
  "text/csv": [".csv"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    ".docx",
  ],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
    ".xlsx",
  ],
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

/**
 * Structural content checks for formats with a reliable signature.
 * Returns true when the bytes plausibly match the declared type; null
 * when the type has no signature to check (text formats — handled by
 * the NUL-byte rejection in validateUpload instead).
 */
function matchesSignature(
  mediaType: string,
  bytes: Uint8Array,
): boolean | null {
  const starts = (sig: number[], offset = 0) =>
    bytes.length >= offset + sig.length &&
    sig.every((b, i) => bytes[offset + i] === b);
  switch (mediaType) {
    case "application/pdf":
      return starts([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    case "image/jpeg":
      return starts([0xff, 0xd8, 0xff]);
    case "image/png":
      return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/webp":
      return (
        starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8) // "RIFF" + "WEBP"
      );
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      // OOXML files are ZIP containers — "PK\x03\x04".
      return starts([0x50, 0x4b, 0x03, 0x04]);
    default:
      return null;
  }
}

/** Text formats must not contain NUL bytes — a cheap binary masquerade check. */
function looksLikeText(bytes: Uint8Array): boolean {
  const probe = bytes.subarray(0, 4096);
  return !probe.includes(0);
}

export interface AttachmentFileInput {
  /** Client-supplied original filename — metadata only, never trusted. */
  name: string;
  /** Client-declared media type — validated, never trusted alone. */
  mediaType: string;
  bytes: Uint8Array;
}

/**
 * The declared-metadata half of an upload — what the client SAYS the
 * file is. Validated at grant time (before a byte exists) and again at
 * finalize; the object itself is checked by `validateUploadHead`.
 */
export interface DeclaredUploadMetadata {
  name: string;
  mediaType: string;
  sizeBytes: number;
}

/**
 * Declared-metadata policy: filename present and bounded, size within
 * the cap, media type allowlisted, and filename extension consistent
 * with the declared type. Throws AttachmentInputError.
 */
export function validateDeclaredUpload(file: DeclaredUploadMetadata): void {
  const name = file.name?.trim() ?? "";
  if (!name || name.length > ATTACHMENT_ORIGINAL_FILENAME_MAX) {
    throw new AttachmentInputError(
      "Choose a file with a filename under 300 characters.",
    );
  }
  if (!Number.isInteger(file.sizeBytes) || file.sizeBytes <= 0) {
    throw new AttachmentInputError("Empty files cannot be uploaded.");
  }
  if (file.sizeBytes > ATTACHMENT_MAX_BYTES) {
    throw new AttachmentInputError(
      `Files must be ${Math.floor(ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB or smaller.`,
    );
  }
  const extensions = ALLOWED_ATTACHMENT_MEDIA_TYPES[file.mediaType];
  if (!extensions) {
    throw new AttachmentInputError(
      "That file type is not supported. Accepted: PDF, JPEG, PNG, WebP, text, CSV, DOCX, XLSX.",
    );
  }
  if (!extensions.includes(extensionOf(name))) {
    throw new AttachmentInputError(
      "The file extension does not match the file type.",
    );
  }
}

/**
 * The content half of the policy — run against the first bytes of the
 * actual object (the whole body when buffered, or the streamed head of
 * a staged object; every check probes at most 4 KiB). Signature match
 * for formats that have one, NUL-byte rejection for text formats.
 * Throws AttachmentInputError.
 */
export function validateUploadHead(mediaType: string, head: Uint8Array): void {
  const signature = matchesSignature(mediaType, head);
  if (signature === false) {
    throw new AttachmentInputError(
      "The file contents do not match the declared file type.",
    );
  }
  if (
    (mediaType === "text/plain" || mediaType === "text/csv") &&
    !looksLikeText(head)
  ) {
    throw new AttachmentInputError("The file does not look like text content.");
  }
}

/**
 * Validate an upload against the v1 policy: non-empty, within the size
 * cap, declared media type allowed, extension consistent with the type,
 * and — where the format has a signature — content that plausibly
 * matches. Throws AttachmentInputError with an operator-safe message.
 */
export function validateUpload(file: AttachmentFileInput): void {
  validateDeclaredUpload({
    name: file.name,
    mediaType: file.mediaType,
    sizeBytes: file.bytes.byteLength,
  });
  validateUploadHead(file.mediaType, file.bytes.subarray(0, 4096));
}

/**
 * User-facing filename: NFC-normalized, basename-only (path separators
 * and traversal stripped), control characters removed, length-capped.
 * The sanitized name is a display convenience — it is never used for
 * storage addressing or served to `Content-Disposition` raw; the
 * download route re-encodes it per RFC 6266.
 */
export function sanitizeDisplayFilename(name: string): string {
  let cleaned = name.normalize("NFC");
  // basename semantics across both separator styles
  cleaned = cleaned.split(/[\\/]/).pop() ?? cleaned;
  // strip control characters and bidi/format overrides
  cleaned = cleaned.replace(
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
  cleaned = cleaned.trim().replace(/^\.+/, "").trim();
  if (cleaned.length === 0) {
    return "attachment";
  }
  return cleaned.slice(0, ATTACHMENT_DISPLAY_FILENAME_MAX);
}

/**
 * RFC 6266 Content-Disposition for an untrusted filename: a sanitized
 * ASCII fallback in `filename=` plus the full UTF-8 name in
 * `filename*=`. Header injection is impossible — control characters and
 * quotes never reach the header value.
 */
export function attachmentContentDisposition(filename: string): string {
  const fallback =
    filename
      // Fetch Headers require ByteString — every character outside
      // printable ASCII must leave the quoted fallback (the UTF-8
      // filename* parameter carries the real name).
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_")
      .trim() || "attachment";
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/* ------------------------------------------------------------------ */
/* Entity resolution                                                   */
/* ------------------------------------------------------------------ */

export type AttachmentEntityType =
  | "INCIDENT"
  | "INCIDENT_NOTE"
  | "MEMBER_QUALIFICATION"
  | "TRAINING_EVENT"
  | "ASSET"
  | "INSPECTION_RECORD"
  | "MAINTENANCE_RECORD"
  | "DEFECT"
  | "EXPENSE";

export const ATTACHMENT_ENTITY_TYPES: readonly AttachmentEntityType[] = [
  "INCIDENT",
  "INCIDENT_NOTE",
  "MEMBER_QUALIFICATION",
  "TRAINING_EVENT",
  "ASSET",
  "INSPECTION_RECORD",
  "MAINTENANCE_RECORD",
  "DEFECT",
  "EXPENSE",
];

export function isAttachmentEntityType(
  value: unknown,
): value is AttachmentEntityType {
  return ATTACHMENT_ENTITY_TYPES.includes(value as AttachmentEntityType);
}

interface ResolvedEntity {
  organizationId: string;
  /** Set for INCIDENT and INCIDENT_NOTE targets. */
  incidentId: string | null;
  incidentStatus: "DRAFT" | "OPEN" | "CLOSED" | null;
  /** Set for EXPENSE targets. */
  expenseId: string | null;
  /**
   * Whether attachment mutations on this record require a human reason:
   * a CLOSED incident, or an APPROVED / already-REIMBURSED expense.
   */
  requiresReason: boolean;
}

/**
 * Resolve the link target inside a transaction. Composite FKs already
 * guarantee row-level same-org integrity; this lookup exists to (a)
 * reject fabricated ids opaquely before any write and (b) supply the
 * denormalized columns and closed-incident state the link/event writes
 * need. A missing row is indistinguishable from a foreign one.
 */
async function resolveEntity(
  tx: Prisma.TransactionClient,
  entityType: AttachmentEntityType,
  entityId: string,
): Promise<ResolvedEntity> {
  switch (entityType) {
    case "INCIDENT": {
      const incident = await tx.incident.findUnique({
        where: { id: entityId },
        select: { organizationId: true, status: true },
      });
      if (!incident) throw new CrossOrganizationAttachmentError();
      return {
        organizationId: incident.organizationId,
        incidentId: entityId,
        incidentStatus: incident.status,
        expenseId: null,
        requiresReason: incident.status === "CLOSED",
      };
    }
    case "INCIDENT_NOTE": {
      const note = await tx.incidentNote.findUnique({
        where: { id: entityId },
        select: {
          organizationId: true,
          incidentId: true,
          incident: { select: { status: true } },
        },
      });
      if (!note) throw new CrossOrganizationAttachmentError();
      return {
        organizationId: note.organizationId,
        incidentId: note.incidentId,
        incidentStatus: note.incident.status,
        expenseId: null,
        requiresReason: note.incident.status === "CLOSED",
      };
    }
    case "MEMBER_QUALIFICATION": {
      const record = await tx.memberQualification.findUnique({
        where: { id: entityId },
        select: { organizationId: true },
      });
      if (!record) throw new CrossOrganizationAttachmentError();
      return {
        organizationId: record.organizationId,
        incidentId: null,
        incidentStatus: null,
        expenseId: null,
        requiresReason: false,
      };
    }
    case "TRAINING_EVENT": {
      const event = await tx.trainingEvent.findUnique({
        where: { id: entityId },
        select: { organizationId: true },
      });
      if (!event) throw new CrossOrganizationAttachmentError();
      return {
        organizationId: event.organizationId,
        incidentId: null,
        incidentStatus: null,
        expenseId: null,
        requiresReason: false,
      };
    }
    case "ASSET": {
      const asset = await tx.asset.findUnique({
        where: { id: entityId },
        select: { organizationId: true },
      });
      if (!asset) throw new CrossOrganizationAttachmentError();
      return {
        organizationId: asset.organizationId,
        incidentId: null,
        incidentStatus: null,
        expenseId: null,
        requiresReason: false,
      };
    }
    case "INSPECTION_RECORD": {
      const record = await tx.inspectionRecord.findUnique({
        where: { id: entityId },
        select: { organizationId: true },
      });
      if (!record) throw new CrossOrganizationAttachmentError();
      return {
        organizationId: record.organizationId,
        incidentId: null,
        incidentStatus: null,
        expenseId: null,
        requiresReason: false,
      };
    }
    case "MAINTENANCE_RECORD": {
      const record = await tx.maintenanceRecord.findUnique({
        where: { id: entityId },
        select: { organizationId: true },
      });
      if (!record) throw new CrossOrganizationAttachmentError();
      return {
        organizationId: record.organizationId,
        incidentId: null,
        incidentStatus: null,
        expenseId: null,
        requiresReason: false,
      };
    }
    case "DEFECT": {
      const defect = await tx.defect.findUnique({
        where: { id: entityId },
        select: { organizationId: true },
      });
      if (!defect) throw new CrossOrganizationAttachmentError();
      return {
        organizationId: defect.organizationId,
        incidentId: null,
        incidentStatus: null,
        expenseId: null,
        requiresReason: false,
      };
    }
    case "EXPENSE": {
      // Issue #17 — receipts and invoices. An approved or already-
      // reimbursed expense is financial evidence whose mutation needs
      // an explicit reason (the same posture as a closed incident).
      const expense = await tx.expense.findUnique({
        where: { id: entityId },
        select: {
          organizationId: true,
          status: true,
          reimbursementStatus: true,
        },
      });
      if (!expense) throw new CrossOrganizationAttachmentError();
      return {
        organizationId: expense.organizationId,
        incidentId: null,
        incidentStatus: null,
        expenseId: entityId,
        requiresReason:
          expense.status === "APPROVED" ||
          expense.reimbursementStatus === "REIMBURSED",
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Internal write helpers                                              */
/* ------------------------------------------------------------------ */

async function attachmentEvent(
  tx: Prisma.TransactionClient,
  attachment: { id: string; organizationId: string },
  action: AttachmentEventAction,
  actorAuthIdentityId: string,
  context?: {
    entityType?: string;
    entityId?: string;
    reason?: string | null;
    storageDeleted?: boolean | null;
  },
) {
  return tx.attachmentEvent.create({
    data: {
      organizationId: attachment.organizationId,
      attachmentId: attachment.id,
      action,
      entityType: context?.entityType ?? null,
      entityId: context?.entityId ?? null,
      reason: context?.reason ?? null,
      storageDeleted: context?.storageDeleted ?? null,
      actorAuthIdentityId,
    },
  });
}

/**
 * Mirror an attachment mutation onto the owning record's own event
 * history (incident timeline, expense event feed) so the record shows
 * evidence-set changes without opening the file's audit trail.
 */
async function entityEventMirror(
  tx: Prisma.TransactionClient,
  entity: Pick<ResolvedEntity, "organizationId" | "incidentId" | "expenseId">,
  type: "ATTACHMENT_ADDED" | "ATTACHMENT_REMOVED",
  attachmentId: string,
  actorAuthIdentityId: string,
  reason?: string | null,
) {
  const now = new Date();
  const metadata = {
    attachmentId,
    ...(reason ? { reason } : {}),
  } satisfies Prisma.InputJsonValue;
  if (entity.incidentId) {
    await tx.incidentTimelineEvent.create({
      data: {
        organizationId: entity.organizationId,
        incidentId: entity.incidentId,
        type,
        occurredAt: now,
        createdAt: now,
        actorAuthIdentityId,
        metadata,
      },
    });
  } else if (entity.expenseId) {
    await tx.expenseEvent.create({
      data: {
        organizationId: entity.organizationId,
        expenseId: entity.expenseId,
        type,
        occurredAt: now,
        createdAt: now,
        actorAuthIdentityId,
        metadata,
      },
    });
  }
}

/** Enforce the protected-record reason rule for one resolved target. */
function requireReasonForProtected(
  entity: ResolvedEntity,
  reason: string | null | undefined,
) {
  if (entity.requiresReason && !reason?.trim()) {
    throw new AttachmentReasonRequiredError();
  }
}

/**
 * Create the per-entity link row. Composite FKs make a same-org
 * violation impossible — a mismatch surfaces as a raw constraint error,
 * which callers map to the opaque cross-org error.
 */
async function createLinkRow(
  tx: Prisma.TransactionClient,
  entityType: AttachmentEntityType,
  entity: ResolvedEntity,
  entityId: string,
  attachmentId: string,
  actorAuthIdentityId: string,
) {
  const base = {
    organizationId: entity.organizationId,
    attachmentId,
    createdByAuthIdentityId: actorAuthIdentityId,
  };
  switch (entityType) {
    case "INCIDENT":
      return tx.incidentAttachment.create({
        data: { ...base, incidentId: entityId },
      });
    case "INCIDENT_NOTE":
      return tx.incidentNoteAttachment.create({
        data: {
          ...base,
          noteId: entityId,
          incidentId: entity.incidentId!,
        },
      });
    case "MEMBER_QUALIFICATION":
      return tx.memberQualificationAttachment.create({
        data: { ...base, memberQualificationId: entityId },
      });
    case "TRAINING_EVENT":
      return tx.trainingEventAttachment.create({
        data: { ...base, trainingEventId: entityId },
      });
    case "ASSET":
      return tx.assetAttachment.create({
        data: { ...base, assetId: entityId },
      });
    case "INSPECTION_RECORD":
      return tx.inspectionRecordAttachment.create({
        data: { ...base, inspectionRecordId: entityId },
      });
    case "MAINTENANCE_RECORD":
      return tx.maintenanceRecordAttachment.create({
        data: { ...base, maintenanceRecordId: entityId },
      });
    case "DEFECT":
      return tx.defectAttachment.create({
        data: { ...base, defectId: entityId },
      });
    case "EXPENSE":
      return tx.expenseAttachment.create({
        data: { ...base, expenseId: entityId },
      });
  }
}

/**
 * Delete the per-entity link row if present. deleteMany makes a repeated
 * unlink idempotent — count 0 is "nothing was linked".
 */
async function deleteLinkRow(
  tx: Prisma.TransactionClient,
  entityType: AttachmentEntityType,
  entityId: string,
  attachmentId: string,
): Promise<{ count: number }> {
  switch (entityType) {
    case "INCIDENT":
      return tx.incidentAttachment.deleteMany({
        where: { incidentId: entityId, attachmentId },
      });
    case "INCIDENT_NOTE":
      return tx.incidentNoteAttachment.deleteMany({
        where: { noteId: entityId, attachmentId },
      });
    case "MEMBER_QUALIFICATION":
      return tx.memberQualificationAttachment.deleteMany({
        where: { memberQualificationId: entityId, attachmentId },
      });
    case "TRAINING_EVENT":
      return tx.trainingEventAttachment.deleteMany({
        where: { trainingEventId: entityId, attachmentId },
      });
    case "ASSET":
      return tx.assetAttachment.deleteMany({
        where: { assetId: entityId, attachmentId },
      });
    case "INSPECTION_RECORD":
      return tx.inspectionRecordAttachment.deleteMany({
        where: { inspectionRecordId: entityId, attachmentId },
      });
    case "MAINTENANCE_RECORD":
      return tx.maintenanceRecordAttachment.deleteMany({
        where: { maintenanceRecordId: entityId, attachmentId },
      });
    case "DEFECT":
      return tx.defectAttachment.deleteMany({
        where: { defectId: entityId, attachmentId },
      });
    case "EXPENSE":
      return tx.expenseAttachment.deleteMany({
        where: { expenseId: entityId, attachmentId },
      });
  }
}

/** Opaque, org-scoped storage key — never derived from filename/title. */
export function newAttachmentStorageKey(organizationId: string): string {
  return `organizations/${organizationId}/attachments/${randomUUID()}`;
}

/* ------------------------------------------------------------------ */
/* Upload                                                              */
/* ------------------------------------------------------------------ */

export interface AttachmentUploadOptions {
  description?: string | null;
  /** Required when the target is protected (CLOSED incident, APPROVED or REIMBURSED expense). */
  reason?: string | null;
}

/**
 * Upload a file onto a domain record.
 *
 * Order of operations is deliberate: validate → store bytes → persist
 * metadata+link+audit in ONE transaction. The object is stored before
 * the DB write so a DB failure can compensate by deleting the object;
 * the reverse order would hold a transaction (or an orphaned ACTIVE
 * record) across a slow network upload. Validation happens before
 * storage so policy failures never create objects.
 */
export async function uploadAttachment(
  entity: { type: AttachmentEntityType; id: string },
  file: AttachmentFileInput,
  options: AttachmentUploadOptions,
  actorAuthIdentityId: string,
  storage: FileStorageProvider = getFileStorageProvider(),
): Promise<Attachment> {
  validateUpload(file);
  const displayFilename = sanitizeDisplayFilename(file.name);
  const checksumSha256 = createHash("sha256").update(file.bytes).digest("hex");

  // Pre-resolve the org for the storage key; the transaction re-resolves
  // and enforces integrity at write time.
  const preview = await resolveEntity(prisma, entity.type, entity.id);
  requireReasonForProtected(preview, options.reason);

  const storageKey = newAttachmentStorageKey(preview.organizationId);
  await storage.put(storageKey, file.bytes, file.mediaType);

  try {
    const attachment = await prisma.$transaction(async (tx) => {
      const resolved = await resolveEntity(tx, entity.type, entity.id);
      requireReasonForProtected(resolved, options.reason);

      const attachment = await tx.attachment.create({
        data: {
          organizationId: resolved.organizationId,
          displayFilename,
          mediaType: file.mediaType,
          sizeBytes: file.bytes.byteLength,
          storageProvider: storage.providerName,
          storageKey,
          checksumSha256,
          description: options.description?.trim() || null,
          uploadedByAuthIdentityId: actorAuthIdentityId,
        },
      });
      await createLinkRow(
        tx,
        entity.type,
        resolved,
        entity.id,
        attachment.id,
        actorAuthIdentityId,
      );
      await attachmentEvent(tx, attachment, "UPLOADED", actorAuthIdentityId, {
        entityType: entity.type,
        entityId: entity.id,
      });
      await attachmentEvent(tx, attachment, "LINKED", actorAuthIdentityId, {
        entityType: entity.type,
        entityId: entity.id,
        reason: options.reason ?? null,
      });
      await entityEventMirror(
        tx,
        resolved,
        "ATTACHMENT_ADDED",
        attachment.id,
        actorAuthIdentityId,
        options.reason,
      );
      return attachment;
    });
    log({
      event: "attachment.uploaded",
      subsystem: "attachments",
      entityType: "Attachment",
      entityId: attachment.id,
      organizationId: attachment.organizationId,
      actorId: actorAuthIdentityId,
      storageProvider: storage.providerName,
      sizeBytes: attachment.sizeBytes,
    });
    return attachment;
  } catch (error) {
    // Compensation: the object exists but the metadata never committed —
    // delete it rather than leak an unreferenced blob.
    try {
      await storage.delete(storageKey);
      log({
        event: "attachment.orphan_cleanup",
        subsystem: "attachments",
        organizationId: preview.organizationId,
        outcome: "success",
      });
    } catch (cleanupError) {
      log({
        event: "attachment.orphan_cleanup",
        subsystem: "attachments",
        organizationId: preview.organizationId,
        level: "error",
        outcome: "operational_failure",
        errorName:
          cleanupError instanceof Error ? cleanupError.name : "unknown",
      });
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Direct-to-store uploads (prepare → client PUT → finalize)            */
/* ------------------------------------------------------------------ */

/**
 * Unfinalized objects live under `staging/` — a dedicated prefix an
 * object-store lifecycle rule can expire wholesale. An abandoned
 * direct upload never becomes a DB row and never reaches the
 * `organizations/` namespace a recorded attachment lives under.
 */
export const ATTACHMENT_STAGING_PREFIX = "staging";

/** Upload grants are short-lived: the PUT must finish within 15 minutes. */
export const UPLOAD_GRANT_TTL_SECONDS = 15 * 60;

/** Staging keys are opaque, org-scoped, and generated server-side. */
export function newAttachmentStagingKey(organizationId: string): string {
  return `${ATTACHMENT_STAGING_PREFIX}/organizations/${organizationId}/${randomUUID()}`;
}

/** Grant returned to the client — the URL is a write-only capability. */
export interface PreparedUpload {
  stagingKey: string;
  finalKey: string;
  url: string;
  /** Signed form fields the client must echo verbatim in its POST. */
  fields: Record<string, string>;
  ticket: string;
  /** ISO 8601 — serialized across the server-action boundary. */
  expiresAt: string;
}

/** What the client echoes back after its direct upload completes. */
export interface StagedUploadCompletion {
  stagingKey: string;
  finalKey: string;
  ticket: string;
}

/**
 * Issue a direct-upload grant for an already-resolved organization.
 * Returns null when the configured provider cannot direct-upload —
 * the caller then falls back to the proxied `uploadAttachment` path.
 * NEVER log or persist the returned URL.
 */
async function prepareUploadGrant(
  organizationId: string,
  declared: DeclaredUploadMetadata,
  actorAuthIdentityId: string,
  storage: FileStorageProvider,
): Promise<PreparedUpload | null> {
  validateDeclaredUpload(declared);
  if (!storage.createUploadTarget || !storage.promoteObject) {
    return null;
  }
  const stagingKey = newAttachmentStagingKey(organizationId);
  const finalKey = newAttachmentStorageKey(organizationId);
  const target = await storage.createUploadTarget(stagingKey, {
    contentType: declared.mediaType,
    sizeBytes: declared.sizeBytes,
    expiresInSeconds: UPLOAD_GRANT_TTL_SECONDS,
  });
  const ticket = signUploadTicket(
    {
      stagingKey,
      finalKey,
      actorId: actorAuthIdentityId,
      mediaType: declared.mediaType,
      sizeBytes: declared.sizeBytes,
      expiresAt: Math.floor(target.expiresAt.getTime() / 1000),
    },
    resolveUploadTicketSecret(),
  );
  log({
    event: "attachment.upload_authorized",
    subsystem: "attachments",
    organizationId,
    actorId: actorAuthIdentityId,
    storageProvider: storage.providerName,
    sizeBytes: declared.sizeBytes,
  });
  return {
    stagingKey,
    finalKey,
    url: target.url,
    fields: target.fields,
    ticket,
    expiresAt: target.expiresAt.toISOString(),
  };
}

/**
 * Authorize a direct upload onto a domain record. Same resolution and
 * protected-record rules as `uploadAttachment` — the grant is issued
 * only after the real organization and its policy checks pass.
 */
export async function prepareAttachmentUpload(
  entity: { type: AttachmentEntityType; id: string },
  declared: DeclaredUploadMetadata,
  options: AttachmentUploadOptions,
  actorAuthIdentityId: string,
  storage: FileStorageProvider = getFileStorageProvider(),
): Promise<PreparedUpload | null> {
  const preview = await resolveEntity(prisma, entity.type, entity.id);
  requireReasonForProtected(preview, options.reason);
  return prepareUploadGrant(
    preview.organizationId,
    declared,
    actorAuthIdentityId,
    storage,
  );
}

/** Authorize a direct upload for a new organization document. */
export async function prepareDocumentUpload(
  organizationId: string,
  declared: DeclaredUploadMetadata,
  actorAuthIdentityId: string,
  storage: FileStorageProvider = getFileStorageProvider(),
): Promise<PreparedUpload | null> {
  return prepareUploadGrant(
    organizationId,
    declared,
    actorAuthIdentityId,
    storage,
  );
}

/**
 * Versions only land on ACTIVE documents — the UI hides the form on
 * archived ones, and the domain enforces the same rule server-side.
 */
function requireDocumentAcceptsVersions(document: { status: string }): void {
  if (document.status !== "ACTIVE") {
    throw new AttachmentInputError(
      "This document is archived and cannot accept new versions.",
    );
  }
}

/** Authorize a direct upload for the next version of a document. */
export async function prepareDocumentVersionUpload(
  documentId: string,
  declared: DeclaredUploadMetadata,
  actorAuthIdentityId: string,
  storage: FileStorageProvider = getFileStorageProvider(),
): Promise<PreparedUpload | null> {
  const document = await prisma.organizationDocument.findUnique({
    where: { id: documentId },
    select: { organizationId: true, status: true },
  });
  if (!document) throw new CrossOrganizationAttachmentError();
  requireDocumentAcceptsVersions(document);
  return prepareUploadGrant(
    document.organizationId,
    declared,
    actorAuthIdentityId,
    storage,
  );
}

type VerifiedStagedUpload =
  | { kind: "existing"; attachment: Attachment }
  | {
      kind: "verified";
      finalKey: string;
      sizeBytes: number;
      checksumSha256: string;
    };

/** Best-effort removal of a rejected staging object — logged, never thrown. */
async function cleanupStagingObject(
  storage: FileStorageProvider,
  stagingKey: string,
  organizationId: string,
) {
  try {
    await storage.delete(stagingKey);
  } catch (cleanupError) {
    log({
      event: "attachment.staging_cleanup",
      subsystem: "attachments",
      organizationId,
      level: "error",
      outcome: "operational_failure",
      errorName: cleanupError instanceof Error ? cleanupError.name : "unknown",
    });
  }
}

/**
 * Hash a staged object while streaming it — the whole body is hashed
 * and its head sampled for content checks, but the file is never
 * buffered in memory. Returns the SHA-256, the counted byte length,
 * and the first ≤4 KiB for signature/text probes.
 */
async function hashObjectStream(stream: ReadableStream<Uint8Array>): Promise<{
  checksumSha256: string;
  sizeBytes: number;
  head: Uint8Array;
}> {
  const hash = createHash("sha256");
  const headParts: Uint8Array[] = [];
  let headLength = 0;
  let sizeBytes = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      sizeBytes += value.byteLength;
      if (headLength < 4096) {
        headParts.push(value);
        headLength += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const head = new Uint8Array(Math.min(headLength, 4096));
  let offset = 0;
  for (const part of headParts) {
    head.set(part.subarray(0, head.length - offset), offset);
    offset += part.byteLength;
    if (offset >= head.length) break;
  }
  return { checksumSha256: hash.digest("hex"), sizeBytes, head };
}

/**
 * Verify a presented grant and the staged object behind it, then
 * promote the object to its recorded key. Every check the proxied path
 * runs happens here too — against the REAL stored bytes, not client
 * claims: ticket authenticity/expiry/actor/field binding, key scoping
 * to the resolved organization, existence, exact size, media-type
 * signature, and a streamed SHA-256.
 *
 * Idempotent: a missing staging object with an already-recorded final
 * key means an earlier finalize committed — return that row instead of
 * failing the retry.
 */
async function verifyStagedUpload(
  organizationId: string,
  staged: StagedUploadCompletion,
  declared: DeclaredUploadMetadata,
  actorAuthIdentityId: string,
  storage: FileStorageProvider,
): Promise<VerifiedStagedUpload> {
  const payload = verifyUploadTicket(
    staged.ticket,
    resolveUploadTicketSecret(),
  );
  if (
    !payload ||
    payload.stagingKey !== staged.stagingKey ||
    payload.finalKey !== staged.finalKey ||
    payload.actorId !== actorAuthIdentityId ||
    payload.mediaType !== declared.mediaType ||
    payload.sizeBytes !== declared.sizeBytes
  ) {
    throw new AttachmentUploadGrantError();
  }
  validateDeclaredUpload(declared);

  // The grant's keys must live inside THIS organization's namespaces —
  // a ticket cannot be replayed to record an object under another org's
  // prefix, and the staging object must be one this flow issued.
  if (
    !staged.stagingKey.startsWith(
      `${ATTACHMENT_STAGING_PREFIX}/organizations/${organizationId}/`,
    ) ||
    !staged.finalKey.startsWith(`organizations/${organizationId}/attachments/`)
  ) {
    throw new AttachmentUploadGrantError();
  }
  if (!storage.promoteObject) {
    throw new StorageError(
      "config_missing",
      "The configured storage provider cannot finalize direct uploads.",
    );
  }

  const stat = await storage.head(staged.stagingKey);
  if (!stat) {
    const existing = await prisma.attachment.findFirst({
      where: { storageKey: staged.finalKey },
    });
    if (existing) return { kind: "existing", attachment: existing };
    throw new AttachmentUploadGrantError();
  }
  if (stat.sizeBytes !== declared.sizeBytes) {
    await cleanupStagingObject(storage, staged.stagingKey, organizationId);
    throw new AttachmentInputError(
      "The uploaded file does not match the authorized upload.",
    );
  }

  const object = await storage.openRead(staged.stagingKey);
  const streamed = await hashObjectStream(object.stream);
  if (streamed.sizeBytes !== stat.sizeBytes) {
    await cleanupStagingObject(storage, staged.stagingKey, organizationId);
    throw new StorageError(
      "provider_error",
      "The stored object did not read back completely.",
    );
  }
  try {
    validateUploadHead(declared.mediaType, streamed.head);
  } catch (error) {
    await cleanupStagingObject(storage, staged.stagingKey, organizationId);
    throw error;
  }

  await storage.promoteObject(staged.stagingKey, staged.finalKey);
  return {
    kind: "verified",
    finalKey: staged.finalKey,
    sizeBytes: stat.sizeBytes,
    checksumSha256: streamed.checksumSha256,
  };
}

/**
 * Finalize a direct upload onto a domain record: the staged object is
 * verified and promoted, then Attachment + link + audit events commit
 * in one transaction — identical durable shape to `uploadAttachment`.
 * On a failed commit the promoted object is deleted (same orphan
 * compensation as the proxied path).
 */
export async function finalizeAttachmentUpload(
  entity: { type: AttachmentEntityType; id: string },
  staged: StagedUploadCompletion,
  declared: DeclaredUploadMetadata,
  options: AttachmentUploadOptions,
  actorAuthIdentityId: string,
  storage: FileStorageProvider = getFileStorageProvider(),
): Promise<Attachment> {
  const preview = await resolveEntity(prisma, entity.type, entity.id);
  requireReasonForProtected(preview, options.reason);
  const verified = await verifyStagedUpload(
    preview.organizationId,
    staged,
    declared,
    actorAuthIdentityId,
    storage,
  );
  if (verified.kind === "existing") return verified.attachment;

  const displayFilename = sanitizeDisplayFilename(declared.name);
  try {
    const attachment = await prisma.$transaction(async (tx) => {
      const resolved = await resolveEntity(tx, entity.type, entity.id);
      requireReasonForProtected(resolved, options.reason);

      const attachment = await tx.attachment.create({
        data: {
          organizationId: resolved.organizationId,
          displayFilename,
          mediaType: declared.mediaType,
          sizeBytes: verified.sizeBytes,
          storageProvider: storage.providerName,
          storageKey: verified.finalKey,
          checksumSha256: verified.checksumSha256,
          description: options.description?.trim() || null,
          uploadedByAuthIdentityId: actorAuthIdentityId,
        },
      });
      await createLinkRow(
        tx,
        entity.type,
        resolved,
        entity.id,
        attachment.id,
        actorAuthIdentityId,
      );
      await attachmentEvent(tx, attachment, "UPLOADED", actorAuthIdentityId, {
        entityType: entity.type,
        entityId: entity.id,
      });
      await attachmentEvent(tx, attachment, "LINKED", actorAuthIdentityId, {
        entityType: entity.type,
        entityId: entity.id,
        reason: options.reason ?? null,
      });
      await entityEventMirror(
        tx,
        resolved,
        "ATTACHMENT_ADDED",
        attachment.id,
        actorAuthIdentityId,
        options.reason,
      );
      return attachment;
    });
    log({
      event: "attachment.uploaded",
      subsystem: "attachments",
      entityType: "Attachment",
      entityId: attachment.id,
      organizationId: attachment.organizationId,
      actorId: actorAuthIdentityId,
      storageProvider: storage.providerName,
      sizeBytes: attachment.sizeBytes,
    });
    return attachment;
  } catch (error) {
    try {
      await storage.delete(verified.finalKey);
      log({
        event: "attachment.orphan_cleanup",
        subsystem: "attachments",
        organizationId: preview.organizationId,
        outcome: "success",
      });
    } catch (cleanupError) {
      log({
        event: "attachment.orphan_cleanup",
        subsystem: "attachments",
        organizationId: preview.organizationId,
        level: "error",
        outcome: "operational_failure",
        errorName:
          cleanupError instanceof Error ? cleanupError.name : "unknown",
      });
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Unlink                                                              */
/* ------------------------------------------------------------------ */

/**
 * Remove the link between an attachment and one record. The link row is
 * deleted (row existence IS the current link) while the AttachmentEvent
 * preserves the historical fact. The attachment itself is untouched —
 * an unlinked file remains downloadable/deletable by org admins from
 * the attachment audit surface. The per-entity unique constraint plus
 * deleteMany makes a repeated unlink a quiet no-op.
 */
export async function unlinkAttachment(
  entity: { type: AttachmentEntityType; id: string },
  attachmentId: string,
  options: { reason?: string | null },
  actorAuthIdentityId: string,
): Promise<{ unlinked: boolean }> {
  const preview = await resolveEntity(prisma, entity.type, entity.id);
  requireReasonForProtected(preview, options.reason);

  const result = await prisma.$transaction(async (tx) => {
    const resolved = await resolveEntity(tx, entity.type, entity.id);
    requireReasonForProtected(resolved, options.reason);

    const attachment = await tx.attachment.findFirst({
      where: { id: attachmentId, organizationId: resolved.organizationId },
    });
    if (!attachment) throw new CrossOrganizationAttachmentError();

    const removed = await deleteLinkRow(
      tx,
      entity.type,
      entity.id,
      attachmentId,
    );
    if (removed.count === 0) {
      return { unlinked: false, attachment, resolved };
    }
    await attachmentEvent(tx, attachment, "UNLINKED", actorAuthIdentityId, {
      entityType: entity.type,
      entityId: entity.id,
      reason: options.reason ?? null,
    });
    await entityEventMirror(
      tx,
      resolved,
      "ATTACHMENT_REMOVED",
      attachment.id,
      actorAuthIdentityId,
      options.reason,
    );
    return { unlinked: true, attachment, resolved };
  });

  if (result.unlinked) {
    log({
      event: "attachment.unlinked",
      subsystem: "attachments",
      entityType: "Attachment",
      entityId: attachmentId,
      organizationId: result.attachment.organizationId,
      actorId: actorAuthIdentityId,
    });
  }
  return { unlinked: result.unlinked };
}

/* ------------------------------------------------------------------ */
/* Delete (metadata tombstone + physical object)                       */
/* ------------------------------------------------------------------ */

/**
 * Explicit physical deletion. Distinct from unlinking: this tombstones
 * the metadata record (status DELETED, actor + timestamp) and attempts
 * provider removal. The metadata row and its AttachmentEvent history
 * are NEVER hard-deleted — a reviewer can always tell the file existed.
 *
 * Order: tombstone in a transaction first (guards concurrent deletes via
 * the status predicate), then storage.delete, then the DELETED event
 * recording whether the physical removal actually happened. A provider
 * failure leaves an honest `storageDeleted: false` event and surfaces
 * the failure to the caller — deletion is never silently claimed.
 *
 * If the attachment is still linked to a protected record — a CLOSED
 * incident, or an APPROVED / already-REIMBURSED expense — a reason is
 * required: the evidence set is being destroyed, not just edited.
 */
export async function deleteAttachment(
  attachmentId: string,
  options: { reason?: string | null },
  actorAuthIdentityId: string,
  storage: FileStorageProvider = getFileStorageProvider(),
): Promise<Attachment> {
  const tombstoned = await prisma.$transaction(async (tx) => {
    const attachment = await tx.attachment.findUnique({
      where: { id: attachmentId },
      include: {
        incidentLinks: { include: { incident: { select: { status: true } } } },
        incidentNoteLinks: {
          include: {
            note: { include: { incident: { select: { status: true } } } },
          },
        },
        expenseLinks: {
          include: {
            expense: { select: { status: true, reimbursementStatus: true } },
          },
        },
      },
    });
    if (!attachment) throw new CrossOrganizationAttachmentError();
    if (attachment.status === "DELETED") {
      // Already tombstoned — but a previous attempt may have failed the
      // physical removal (storageDeleted=false) or crashed before the
      // outcome was recorded at all (no DELETED event). Both mean the
      // object may still exist: fall through to retry the idempotent
      // storage delete and append a fresh DELETED event — history stays
      // append-only.
      const lastDelete = await tx.attachmentEvent.findFirst({
        where: { attachmentId, action: "DELETED" },
        orderBy: { createdAt: "desc" },
        select: { storageDeleted: true },
      });
      const retryNeeded = lastDelete?.storageDeleted !== true;
      return { attachment, changed: false, retryStorage: retryNeeded };
    }

    const touchesProtectedRecord =
      attachment.incidentLinks.some((l) => l.incident.status === "CLOSED") ||
      attachment.incidentNoteLinks.some(
        (l) => l.note.incident.status === "CLOSED",
      ) ||
      attachment.expenseLinks.some(
        (l) =>
          l.expense.status === "APPROVED" ||
          l.expense.reimbursementStatus === "REIMBURSED",
      );
    if (touchesProtectedRecord && !options.reason?.trim()) {
      throw new AttachmentReasonRequiredError();
    }

    const marked = await tx.attachment.updateMany({
      where: { id: attachmentId, status: "ACTIVE" },
      data: {
        status: "DELETED",
        deletedAt: new Date(),
        deletedByAuthIdentityId: actorAuthIdentityId,
      },
    });
    if (marked.count === 1) {
      // Mirror the removal onto every record the file is still linked
      // to — tombstoning keeps the link rows (each record's history
      // retains the fact a file existed), so each record's own feed
      // must show the evidence was destroyed, the same way
      // unlinkAttachment mirrors the detach path. Inside this
      // transaction the mirror is atomic with the tombstone; the retry
      // path above skips it because the mirrors already committed.
      // Dedupe incidents reached through BOTH a direct link and a note
      // link so their timeline gets one event.
      const incidentIds = new Set(
        attachment.incidentLinks.map((l) => l.incidentId),
      );
      for (const link of attachment.incidentNoteLinks) {
        incidentIds.add(link.note.incidentId);
      }
      for (const incidentId of incidentIds) {
        await entityEventMirror(
          tx,
          {
            organizationId: attachment.organizationId,
            incidentId,
            expenseId: null,
          },
          "ATTACHMENT_REMOVED",
          attachment.id,
          actorAuthIdentityId,
          options.reason,
        );
      }
      for (const link of attachment.expenseLinks) {
        await entityEventMirror(
          tx,
          {
            organizationId: attachment.organizationId,
            incidentId: null,
            expenseId: link.expenseId,
          },
          "ATTACHMENT_REMOVED",
          attachment.id,
          actorAuthIdentityId,
          options.reason,
        );
      }
    }
    return { attachment, changed: marked.count === 1, retryStorage: false };
  });

  if (!tombstoned.changed && !tombstoned.retryStorage) {
    return tombstoned.attachment;
  }

  // Physical delete AFTER the tombstone commits — a crashed or failed
  // storage call never leaves an ACTIVE record pointing at nothing.
  let storageDeleted = false;
  let storageFailure: StorageError | null = null;
  try {
    await storage.delete(tombstoned.attachment.storageKey);
    storageDeleted = true;
  } catch (error) {
    storageFailure =
      error instanceof StorageError
        ? error
        : new StorageError("provider_error", "Object deletion failed.", error);
  }

  await prisma.attachmentEvent.create({
    data: {
      organizationId: tombstoned.attachment.organizationId,
      attachmentId,
      action: "DELETED",
      reason: options.reason ?? null,
      storageDeleted,
      actorAuthIdentityId,
    },
  });

  log({
    event: "attachment.deleted",
    subsystem: "attachments",
    entityType: "Attachment",
    entityId: attachmentId,
    organizationId: tombstoned.attachment.organizationId,
    actorId: actorAuthIdentityId,
    level: storageFailure ? "warn" : "info",
    outcome: storageFailure ? "expected_failure" : "success",
    storageDeleted,
  });
  if (storageFailure) {
    throw storageFailure;
  }
  return tombstoned.attachment;
}

/* ------------------------------------------------------------------ */
/* Download                                                            */
/* ------------------------------------------------------------------ */

export interface AttachmentDownload {
  stream: ReadableStream<Uint8Array>;
  sizeBytes: number;
  mediaType: string;
  displayFilename: string;
}

/**
 * Open an attachment for download. Authorization has already happened —
 * the caller resolved the Attachment row and verified org scope. This
 * function enforces status, resolves the provider BY THE STORED NAME
 * (records say which store holds their bytes), and returns a stream —
 * bytes are never buffered back into memory or handed to the client as
 * a URL.
 */
export async function openAttachmentDownload(
  attachment: Attachment,
  storage: FileStorageProvider = getFileStorageProvider(),
): Promise<AttachmentDownload> {
  if (attachment.status !== "ACTIVE") {
    throw new AttachmentDeletedError();
  }
  if (storage.providerName !== attachment.storageProvider) {
    // The record names a store this deployment no longer serves —
    // honest failure, never a silent fallback to the wrong provider.
    throw new StorageError(
      "config_missing",
      `Storage provider '${attachment.storageProvider}' is not configured on this deployment.`,
    );
  }
  const object = await storage.openRead(attachment.storageKey);
  return {
    stream: object.stream,
    sizeBytes: attachment.sizeBytes,
    mediaType: attachment.mediaType,
    displayFilename: attachment.displayFilename,
  };
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

/**
 * Attachments linked to one record, newest first. Caller has already
 * verified org scope on the parent; the join is org-bound anyway.
 */
export interface EntityAttachmentRow {
  linkId: string;
  attachment: Attachment;
  createdAt: Date;
  createdByAuthIdentityId: string;
}

export async function listEntityAttachments(
  entityType: AttachmentEntityType,
  entityId: string,
): Promise<EntityAttachmentRow[]> {
  const orderBy = { createdAt: "desc" as const };
  const include = { attachment: true };
  let rows: {
    id: string;
    attachment: Attachment;
    createdAt: Date;
    createdByAuthIdentityId: string;
  }[];
  switch (entityType) {
    case "INCIDENT":
      rows = await prisma.incidentAttachment.findMany({
        where: { incidentId: entityId },
        include,
        orderBy,
      });
      break;
    case "INCIDENT_NOTE":
      rows = await prisma.incidentNoteAttachment.findMany({
        where: { noteId: entityId },
        include,
        orderBy,
      });
      break;
    case "MEMBER_QUALIFICATION":
      rows = await prisma.memberQualificationAttachment.findMany({
        where: { memberQualificationId: entityId },
        include,
        orderBy,
      });
      break;
    case "TRAINING_EVENT":
      rows = await prisma.trainingEventAttachment.findMany({
        where: { trainingEventId: entityId },
        include,
        orderBy,
      });
      break;
    case "ASSET":
      rows = await prisma.assetAttachment.findMany({
        where: { assetId: entityId },
        include,
        orderBy,
      });
      break;
    case "INSPECTION_RECORD":
      rows = await prisma.inspectionRecordAttachment.findMany({
        where: { inspectionRecordId: entityId },
        include,
        orderBy,
      });
      break;
    case "MAINTENANCE_RECORD":
      rows = await prisma.maintenanceRecordAttachment.findMany({
        where: { maintenanceRecordId: entityId },
        include,
        orderBy,
      });
      break;
    case "DEFECT":
      rows = await prisma.defectAttachment.findMany({
        where: { defectId: entityId },
        include,
        orderBy,
      });
      break;
    case "EXPENSE":
      rows = await prisma.expenseAttachment.findMany({
        where: { expenseId: entityId },
        include,
        orderBy,
      });
      break;
  }
  return rows.map((row) => ({
    linkId: row.id,
    attachment: row.attachment,
    createdAt: row.createdAt,
    createdByAuthIdentityId: row.createdByAuthIdentityId,
  }));
}

/** The attachment's own audit trail, oldest first. */
export async function listAttachmentEvents(attachmentId: string) {
  return prisma.attachmentEvent.findMany({
    where: { attachmentId },
    orderBy: { createdAt: "asc" },
  });
}

/* ------------------------------------------------------------------ */
/* Organization documents                                              */
/* ------------------------------------------------------------------ */

export interface OrganizationDocumentInput {
  title: string;
  category?: string | null;
  effectiveOn?: Date | null;
  expiresOn?: Date | null;
  notes?: string | null;
}

/**
 * Create an org-level document (SOP, manual, insurance cert, ...) as a
 * durable document record plus version 1 pointing at a fresh Attachment.
 * Same upload discipline: object stored first, rows committed in one
 * transaction, orphan object cleaned up on failure.
 */
export async function createOrganizationDocument(
  organizationId: string,
  file: AttachmentFileInput,
  input: OrganizationDocumentInput & { description?: string | null },
  versionNote: string | null,
  actorAuthIdentityId: string,
  storage: FileStorageProvider = getFileStorageProvider(),
) {
  validateUpload(file);
  const displayFilename = sanitizeDisplayFilename(file.name);
  const checksumSha256 = createHash("sha256").update(file.bytes).digest("hex");
  const storageKey = newAttachmentStorageKey(organizationId);
  await storage.put(storageKey, file.bytes, file.mediaType);

  try {
    const document = await prisma.$transaction(async (tx) => {
      const attachment = await tx.attachment.create({
        data: {
          organizationId,
          displayFilename,
          mediaType: file.mediaType,
          sizeBytes: file.bytes.byteLength,
          storageProvider: storage.providerName,
          storageKey,
          checksumSha256,
          description: input.description?.trim() || null,
          uploadedByAuthIdentityId: actorAuthIdentityId,
        },
      });
      const document = await tx.organizationDocument.create({
        data: {
          organizationId,
          title: input.title,
          category: input.category?.trim() || null,
          effectiveOn: input.effectiveOn ?? null,
          expiresOn: input.expiresOn ?? null,
          notes: input.notes?.trim() || null,
          createdByAuthIdentityId: actorAuthIdentityId,
        },
      });
      await tx.organizationDocumentVersion.create({
        data: {
          organizationId,
          documentId: document.id,
          attachmentId: attachment.id,
          versionNumber: 1,
          note: versionNote,
          createdByAuthIdentityId: actorAuthIdentityId,
        },
      });
      await attachmentEvent(tx, attachment, "UPLOADED", actorAuthIdentityId, {
        entityType: "ORGANIZATION_DOCUMENT",
        entityId: document.id,
      });
      await attachmentEvent(tx, attachment, "LINKED", actorAuthIdentityId, {
        entityType: "ORGANIZATION_DOCUMENT",
        entityId: document.id,
      });
      return document;
    });
    log({
      event: "document.created",
      subsystem: "attachments",
      entityType: "OrganizationDocument",
      entityId: document.id,
      organizationId,
      actorId: actorAuthIdentityId,
    });
    return document;
  } catch (error) {
    try {
      await storage.delete(storageKey);
    } catch (cleanupError) {
      log({
        event: "attachment.orphan_cleanup",
        subsystem: "attachments",
        organizationId,
        level: "error",
        outcome: "operational_failure",
        errorName:
          cleanupError instanceof Error ? cleanupError.name : "unknown",
      });
    }
    throw error;
  }
}

/**
 * Upload a replacement file as the next version of a document. The
 * unique (documentId, versionNumber) constraint serializes concurrent
 * uploads — two simultaneous replacements cannot mint the same number;
 * the loser gets a P2002 which the caller surfaces as a conflict.
 */
export async function addOrganizationDocumentVersion(
  documentId: string,
  file: AttachmentFileInput,
  versionNote: string | null,
  actorAuthIdentityId: string,
  storage: FileStorageProvider = getFileStorageProvider(),
) {
  validateUpload(file);
  const document = await prisma.organizationDocument.findUnique({
    where: { id: documentId },
    select: { id: true, organizationId: true, status: true },
  });
  if (!document) throw new CrossOrganizationAttachmentError();
  requireDocumentAcceptsVersions(document);

  const displayFilename = sanitizeDisplayFilename(file.name);
  const checksumSha256 = createHash("sha256").update(file.bytes).digest("hex");
  const storageKey = newAttachmentStorageKey(document.organizationId);
  await storage.put(storageKey, file.bytes, file.mediaType);

  try {
    const version = await prisma.$transaction(async (tx) => {
      // Re-check inside the transaction — an archive landing between the
      // outer check and this commit must not win the race.
      const current = await tx.organizationDocument.findUniqueOrThrow({
        where: { id: documentId },
        select: { status: true },
      });
      requireDocumentAcceptsVersions(current);
      const latest = await tx.organizationDocumentVersion.aggregate({
        where: { documentId },
        _max: { versionNumber: true },
      });
      const attachment = await tx.attachment.create({
        data: {
          organizationId: document.organizationId,
          displayFilename,
          mediaType: file.mediaType,
          sizeBytes: file.bytes.byteLength,
          storageProvider: storage.providerName,
          storageKey,
          checksumSha256,
          uploadedByAuthIdentityId: actorAuthIdentityId,
        },
      });
      const version = await tx.organizationDocumentVersion.create({
        data: {
          organizationId: document.organizationId,
          documentId: document.id,
          attachmentId: attachment.id,
          versionNumber: (latest._max.versionNumber ?? 0) + 1,
          note: versionNote,
          createdByAuthIdentityId: actorAuthIdentityId,
        },
      });
      await attachmentEvent(tx, attachment, "UPLOADED", actorAuthIdentityId, {
        entityType: "ORGANIZATION_DOCUMENT",
        entityId: document.id,
      });
      await attachmentEvent(tx, attachment, "LINKED", actorAuthIdentityId, {
        entityType: "ORGANIZATION_DOCUMENT",
        entityId: document.id,
      });
      return version;
    });
    log({
      event: "document.version_added",
      subsystem: "attachments",
      entityType: "OrganizationDocument",
      entityId: document.id,
      organizationId: document.organizationId,
      actorId: actorAuthIdentityId,
      versionNumber: version.versionNumber,
    });
    return version;
  } catch (error) {
    try {
      await storage.delete(storageKey);
    } catch (cleanupError) {
      log({
        event: "attachment.orphan_cleanup",
        subsystem: "attachments",
        organizationId: document.organizationId,
        level: "error",
        outcome: "operational_failure",
        errorName:
          cleanupError instanceof Error ? cleanupError.name : "unknown",
      });
    }
    throw error;
  }
}

/**
 * Finalize a direct upload as a new organization document — the staged
 * object is verified and promoted, then document + version 1 + audit
 * events commit in one transaction (same durable shape as
 * `createOrganizationDocument`). On a failed commit the promoted
 * object is deleted.
 */
export async function finalizeDocumentCreate(
  organizationId: string,
  staged: StagedUploadCompletion,
  declared: DeclaredUploadMetadata,
  input: OrganizationDocumentInput & { description?: string | null },
  versionNote: string | null,
  actorAuthIdentityId: string,
  storage: FileStorageProvider = getFileStorageProvider(),
) {
  const verified = await verifyStagedUpload(
    organizationId,
    staged,
    declared,
    actorAuthIdentityId,
    storage,
  );
  if (verified.kind === "existing") {
    const version = await prisma.organizationDocumentVersion.findFirst({
      where: { attachmentId: verified.attachment.id },
      include: { document: true },
    });
    if (!version) throw new CrossOrganizationAttachmentError();
    return version.document;
  }

  const displayFilename = sanitizeDisplayFilename(declared.name);
  try {
    const document = await prisma.$transaction(async (tx) => {
      const attachment = await tx.attachment.create({
        data: {
          organizationId,
          displayFilename,
          mediaType: declared.mediaType,
          sizeBytes: verified.sizeBytes,
          storageProvider: storage.providerName,
          storageKey: verified.finalKey,
          checksumSha256: verified.checksumSha256,
          description: input.description?.trim() || null,
          uploadedByAuthIdentityId: actorAuthIdentityId,
        },
      });
      const document = await tx.organizationDocument.create({
        data: {
          organizationId,
          title: input.title,
          category: input.category?.trim() || null,
          effectiveOn: input.effectiveOn ?? null,
          expiresOn: input.expiresOn ?? null,
          notes: input.notes?.trim() || null,
          createdByAuthIdentityId: actorAuthIdentityId,
        },
      });
      await tx.organizationDocumentVersion.create({
        data: {
          organizationId,
          documentId: document.id,
          attachmentId: attachment.id,
          versionNumber: 1,
          note: versionNote,
          createdByAuthIdentityId: actorAuthIdentityId,
        },
      });
      await attachmentEvent(tx, attachment, "UPLOADED", actorAuthIdentityId, {
        entityType: "ORGANIZATION_DOCUMENT",
        entityId: document.id,
      });
      await attachmentEvent(tx, attachment, "LINKED", actorAuthIdentityId, {
        entityType: "ORGANIZATION_DOCUMENT",
        entityId: document.id,
      });
      return document;
    });
    log({
      event: "document.created",
      subsystem: "attachments",
      entityType: "OrganizationDocument",
      entityId: document.id,
      organizationId,
      actorId: actorAuthIdentityId,
    });
    return document;
  } catch (error) {
    try {
      await storage.delete(verified.finalKey);
    } catch (cleanupError) {
      log({
        event: "attachment.orphan_cleanup",
        subsystem: "attachments",
        organizationId,
        level: "error",
        outcome: "operational_failure",
        errorName:
          cleanupError instanceof Error ? cleanupError.name : "unknown",
      });
    }
    throw error;
  }
}

/**
 * Finalize a direct upload as the next version of a document — same
 * serialization on (documentId, versionNumber) as the proxied path.
 */
export async function finalizeDocumentVersion(
  documentId: string,
  staged: StagedUploadCompletion,
  declared: DeclaredUploadMetadata,
  versionNote: string | null,
  actorAuthIdentityId: string,
  storage: FileStorageProvider = getFileStorageProvider(),
) {
  const document = await prisma.organizationDocument.findUnique({
    where: { id: documentId },
    select: { id: true, organizationId: true, status: true },
  });
  if (!document) throw new CrossOrganizationAttachmentError();
  requireDocumentAcceptsVersions(document);

  const verified = await verifyStagedUpload(
    document.organizationId,
    staged,
    declared,
    actorAuthIdentityId,
    storage,
  );
  if (verified.kind === "existing") {
    const version = await prisma.organizationDocumentVersion.findFirst({
      where: { attachmentId: verified.attachment.id },
    });
    if (!version) throw new CrossOrganizationAttachmentError();
    return version;
  }

  const displayFilename = sanitizeDisplayFilename(declared.name);
  try {
    const version = await prisma.$transaction(async (tx) => {
      // Re-check inside the transaction — an archive landing between the
      // outer check and this commit must not win the race.
      const current = await tx.organizationDocument.findUniqueOrThrow({
        where: { id: documentId },
        select: { status: true },
      });
      requireDocumentAcceptsVersions(current);
      const latest = await tx.organizationDocumentVersion.aggregate({
        where: { documentId },
        _max: { versionNumber: true },
      });
      const attachment = await tx.attachment.create({
        data: {
          organizationId: document.organizationId,
          displayFilename,
          mediaType: declared.mediaType,
          sizeBytes: verified.sizeBytes,
          storageProvider: storage.providerName,
          storageKey: verified.finalKey,
          checksumSha256: verified.checksumSha256,
          uploadedByAuthIdentityId: actorAuthIdentityId,
        },
      });
      const version = await tx.organizationDocumentVersion.create({
        data: {
          organizationId: document.organizationId,
          documentId: document.id,
          attachmentId: attachment.id,
          versionNumber: (latest._max.versionNumber ?? 0) + 1,
          note: versionNote,
          createdByAuthIdentityId: actorAuthIdentityId,
        },
      });
      await attachmentEvent(tx, attachment, "UPLOADED", actorAuthIdentityId, {
        entityType: "ORGANIZATION_DOCUMENT",
        entityId: document.id,
      });
      await attachmentEvent(tx, attachment, "LINKED", actorAuthIdentityId, {
        entityType: "ORGANIZATION_DOCUMENT",
        entityId: document.id,
      });
      return version;
    });
    log({
      event: "document.version_added",
      subsystem: "attachments",
      entityType: "OrganizationDocument",
      entityId: document.id,
      organizationId: document.organizationId,
      actorId: actorAuthIdentityId,
      versionNumber: version.versionNumber,
    });
    return version;
  } catch (error) {
    try {
      await storage.delete(verified.finalKey);
    } catch (cleanupError) {
      log({
        event: "attachment.orphan_cleanup",
        subsystem: "attachments",
        organizationId: document.organizationId,
        level: "error",
        outcome: "operational_failure",
        errorName:
          cleanupError instanceof Error ? cleanupError.name : "unknown",
      });
    }
    throw error;
  }
}

/** Update document metadata (title/category/dates/notes) — no file changes. */
export async function updateOrganizationDocument(
  documentId: string,
  input: OrganizationDocumentInput,
) {
  return prisma.organizationDocument.update({
    where: { id: documentId },
    data: {
      title: input.title,
      category: input.category?.trim() || null,
      effectiveOn: input.effectiveOn ?? null,
      expiresOn: input.expiresOn ?? null,
      notes: input.notes?.trim() || null,
    },
  });
}

/**
 * Archive/unarchive a document. Archiving is a presentation state — the
 * document and every version remain intact and downloadable by admins;
 * nothing is deleted. Physical file removal stays an explicit
 * deleteAttachment decision per version.
 */
export async function setOrganizationDocumentStatus(
  documentId: string,
  status: "ACTIVE" | "ARCHIVED",
  actorAuthIdentityId: string,
) {
  const document = await prisma.organizationDocument.update({
    where: { id: documentId },
    data: { status },
  });
  log({
    event: status === "ARCHIVED" ? "document.archived" : "document.unarchived",
    subsystem: "attachments",
    entityType: "OrganizationDocument",
    entityId: documentId,
    organizationId: document.organizationId,
    actorId: actorAuthIdentityId,
  });
  return document;
}

/** Org document list — current version only, newest first. */
export async function listOrganizationDocuments(organizationId: string) {
  const documents = await prisma.organizationDocument.findMany({
    where: { organizationId },
    include: {
      versions: {
        orderBy: { versionNumber: "desc" },
        take: 1,
        include: { attachment: true },
      },
      _count: { select: { versions: true } },
    },
    orderBy: [{ status: "asc" }, { title: "asc" }],
  });
  return documents;
}

/** One document with its full version history, newest first. */
export async function getOrganizationDocument(documentId: string) {
  return prisma.organizationDocument.findUnique({
    where: { id: documentId },
    include: {
      versions: {
        orderBy: { versionNumber: "desc" },
        include: { attachment: true },
      },
    },
  });
}
