import { Prisma } from "@prisma/client";
import type {
  ExpenseEventType,
  ExpenseStatus,
  ReimbursementStatus,
  VendorStatus,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { log } from "@/lib/logging";
import { resolveActorLabels } from "./actors";
import { formatDateOnly } from "@/lib/dates";
import { MoneyInputError, parseMoneyAmount } from "@/lib/money";
import type {
  ExpenseContextLinkKindInput,
  ExpenseCreateInput,
  ExpenseReimbursementInput,
  ExpenseTransitionInput,
  ExpenseUpdateInput,
  VendorInput,
  VendorStatusInput,
} from "./schemas";

/**
 * Issue #17 — vendors, expenses, receipts, and reimbursements.
 *
 * Lightweight financial recordkeeping: where did we buy it, how much
 * did it cost, what was it for, who paid, and has reimbursement been
 * recorded. SARbase is not accounting software — no ledger, no
 * invoicing, no payment processing exists here or is planned.
 *
 * Semantics:
 * - Money is integer `amountMinor` + ISO 4217 `currency`; the display
 *   string is parsed by src/lib/money.ts, never a float.
 * - `status` (DRAFT/SUBMITTED/APPROVED/REJECTED) describes review of
 *   the record; `reimbursementStatus` is a separate factual axis —
 *   an approved expense is not automatically a reimbursement.
 * - Every mutation writes append-only ExpenseEvent history; material
 *   field edits also write before/after ExpenseChange snapshots —
 *   atomically, so a correction cannot commit without its audit row.
 * - All ids are untrusted selectors: a foreign or fabricated id fails
 *   opaquely (CrossOrganizationExpenseError), and composite
 *   (id, organizationId) FKs make cross-org rows impossible at the
 *   database level too.
 * - Actor attribution is scalar — history survives identity deletion.
 */

/** A submitted id did not resolve inside the caller's organization. */
export class CrossOrganizationExpenseError extends Error {
  constructor() {
    super("Expense record not found.");
    this.name = "CrossOrganizationExpenseError";
  }
}

/** Shaped input that cannot become a fact. */
export class ExpenseInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpenseInputError";
  }
}

/** The requested lifecycle transition is not allowed from this state. */
export class ExpenseTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpenseTransitionError";
  }
}

/** Correcting an APPROVED or already-REIMBURSED expense needs a reason. */
export class ExpenseCorrectionReasonError extends Error {
  constructor() {
    super("A reason is required to correct an approved or reimbursed expense.");
    this.name = "ExpenseCorrectionReasonError";
  }
}

/** The same context record is already linked to this expense. */
export class ExpenseDuplicateLinkError extends Error {
  constructor() {
    super("That record is already linked to this expense.");
    this.name = "ExpenseDuplicateLinkError";
  }
}

export const VENDOR_STATUS_LABELS: Record<VendorStatus, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
};

export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export const REIMBURSEMENT_STATUS_LABELS: Record<ReimbursementStatus, string> =
  {
    NOT_REQUIRED: "Not required",
    PENDING: "Pending",
    REIMBURSED: "Reimbursed",
  };

export const EXPENSE_CONTEXT_KIND_LABELS: Record<
  ExpenseContextLinkKindInput,
  string
> = {
  INCIDENT: "Incident",
  TRAINING_EVENT: "Training event",
  ASSET: "Asset",
  MAINTENANCE_RECORD: "Maintenance record",
  INVENTORY_ITEM: "Inventory item",
};

/* ------------------------------------------------------------------ */
/* Event rendering                                                     */
/* ------------------------------------------------------------------ */

/** Narrow, type-bound metadata payload shapes for expense events. */
interface ExpenseEventMetadata {
  from?: string;
  to?: string;
  kind?: ExpenseContextLinkKindInput;
  targetId?: string;
  targetLabel?: string;
  note?: string;
  reason?: string;
  attachmentId?: string;
  changeId?: string;
}

/**
 * Human-readable sentence for a system expense event. Link labels come
 * from the snapshotted metadata, so the sentence stays accurate even if
 * the linked record is renamed later.
 */
export function describeExpenseEvent(event: {
  type: ExpenseEventType;
  metadata: Prisma.JsonValue | null;
}): string {
  const meta = (event.metadata ?? {}) as ExpenseEventMetadata;
  const statusLabel = (s?: string) =>
    EXPENSE_STATUS_LABELS[s as ExpenseStatus] ?? s;
  const reimbursementLabel = (s?: string) =>
    REIMBURSEMENT_STATUS_LABELS[s as ReimbursementStatus] ?? s;
  switch (event.type) {
    case "EXPENSE_CREATED":
      return "Expense record created";
    case "STATUS_CHANGED":
      return `Status changed from ${statusLabel(meta.from)} to ${statusLabel(meta.to)}`;
    case "REIMBURSEMENT_CHANGED":
      return `Reimbursement changed from ${reimbursementLabel(meta.from)} to ${reimbursementLabel(meta.to)}`;
    case "CONTEXT_LINKED":
      return `Linked ${EXPENSE_CONTEXT_KIND_LABELS[meta.kind ?? "ASSET"]?.toLowerCase() ?? "record"}: ${meta.targetLabel ?? meta.targetId ?? "record"}`;
    case "CONTEXT_UNLINKED":
      return `Unlinked ${EXPENSE_CONTEXT_KIND_LABELS[meta.kind ?? "ASSET"]?.toLowerCase() ?? "record"}: ${meta.targetLabel ?? meta.targetId ?? "record"}`;
    case "ATTACHMENT_ADDED":
      return "Receipt or file added to the expense record";
    case "ATTACHMENT_REMOVED":
      return "File removed from the expense record";
    case "CORRECTION_RECORDED":
      return "Expense record corrected";
    default:
      return event.type;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/** Lock the expense row so serialized mutations chain correctly. */
async function lockExpense(tx: Prisma.TransactionClient, expenseId: string) {
  await tx.$executeRaw`SELECT id FROM "Expense" WHERE id = ${expenseId} FOR UPDATE`;
  const expense = await tx.expense.findUnique({ where: { id: expenseId } });
  if (!expense) {
    // Authz resolves targets first, so a missing row here is a raced
    // delete or a fabricated id — opaque either way.
    throw new CrossOrganizationExpenseError();
  }
  return expense;
}

async function expenseEvent(
  tx: Prisma.TransactionClient,
  expense: { id: string; organizationId: string },
  type: ExpenseEventType,
  actorAuthIdentityId: string,
  metadata?: ExpenseEventMetadata,
  occurredAt?: Date,
) {
  const now = new Date();
  return tx.expenseEvent.create({
    data: {
      organizationId: expense.organizationId,
      expenseId: expense.id,
      type,
      occurredAt: occurredAt ?? now,
      createdAt: now,
      actorAuthIdentityId,
      metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

function sameDate(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

/**
 * Parse the display amount into exact minor units — zod already checked
 * the rough shape; this applies the currency-aware rules. MoneyInputError
 * is translated into the domain's input error so the action layer sees
 * one error vocabulary.
 */
function parseAmount(raw: string, currency: string): number {
  try {
    return parseMoneyAmount(raw, currency);
  } catch (error) {
    if (error instanceof MoneyInputError) {
      throw new ExpenseInputError(error.message);
    }
    throw error;
  }
}

/**
 * Resolve the optional vendor/member selectors for create and
 * correction. Every id must resolve inside the owning organization —
 * a foreign or fabricated id fails opaquely. The vendor must be ACTIVE:
 * an inactive vendor stays on the historical expenses it already has,
 * but new spending is not recorded against it. `allowInactiveVendorId`
 * is the vendor the record already carries — a correction that merely
 * *keeps* it is not new spending and must not fail; assigning an
 * inactive vendor the record did not already have is still rejected.
 */
async function resolveExpenseRelations(
  tx: Prisma.TransactionClient,
  organizationId: string,
  input: {
    vendorId?: string;
    submittedByMemberId?: string;
    paidByMemberId?: string;
  },
  options: { allowInactiveVendorId?: string | null } = {},
) {
  if (input.vendorId) {
    const vendor = await tx.vendor.findFirst({
      where: { id: input.vendorId, organizationId },
      select: { status: true },
    });
    if (!vendor) throw new CrossOrganizationExpenseError();
    if (
      vendor.status !== "ACTIVE" &&
      input.vendorId !== options.allowInactiveVendorId
    ) {
      throw new ExpenseInputError(
        "That vendor is inactive — reactivate it or choose another.",
      );
    }
  }
  for (const memberId of [input.submittedByMemberId, input.paidByMemberId]) {
    if (!memberId) continue;
    const member = await tx.member.findFirst({
      where: { id: memberId, organizationId },
      select: { id: true },
    });
    if (!member) throw new CrossOrganizationExpenseError();
  }
}

/** The rule keeping the paid-by fact consistent with the reimbursement. */
function assertPayerConsistency(
  paidByMemberId: string | null,
  reimbursementStatus: ReimbursementStatus,
) {
  if (reimbursementStatus !== "NOT_REQUIRED" && !paidByMemberId) {
    throw new ExpenseInputError(
      "A reimbursement needs the member who paid out of pocket.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Vendors                                                             */
/* ------------------------------------------------------------------ */

/**
 * Create a vendor. Names are not unique — two branches of the same
 * supplier can legitimately share one; `accountReference` is the
 * disambiguator.
 */
export async function createVendor(
  organizationId: string,
  input: VendorInput,
  actorAuthIdentityId: string,
) {
  const vendor = await prisma.vendor.create({
    data: {
      organizationId,
      name: input.name,
      contactName: input.contactName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      website: input.website ?? null,
      accountReference: input.accountReference ?? null,
      notes: input.notes ?? null,
    },
  });
  log({
    event: "expenses.vendor_created",
    subsystem: "expenses",
    entityType: "Vendor",
    entityId: vendor.id,
    organizationId,
    actorId: actorAuthIdentityId,
  });
  return vendor;
}

/** Update a vendor's contact/reference fields in place. */
export async function updateVendor(
  vendorId: string,
  input: VendorInput,
  actorAuthIdentityId: string,
) {
  const existing = await prisma.vendor.findUnique({ where: { id: vendorId } });
  if (!existing) throw new CrossOrganizationExpenseError();
  const vendor = await prisma.vendor.update({
    where: { id: vendorId },
    data: {
      name: input.name,
      contactName: input.contactName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      website: input.website ?? null,
      accountReference: input.accountReference ?? null,
      notes: input.notes ?? null,
    },
  });
  log({
    event: "expenses.vendor_updated",
    subsystem: "expenses",
    entityType: "Vendor",
    entityId: vendor.id,
    actorId: actorAuthIdentityId,
  });
  return vendor;
}

/**
 * Vendor lifecycle — no deletes. INACTIVE vendors are hidden from new
 * expense choices (the domain rejects them on create/correction) but
 * remain on the historical records they already have.
 */
export async function setVendorStatus(
  vendorId: string,
  status: VendorStatusInput,
  actorAuthIdentityId: string,
) {
  const vendor = await prisma.vendor.update({
    where: { id: vendorId },
    data: { status },
  });
  log({
    event: "expenses.vendor_status_changed",
    subsystem: "expenses",
    entityType: "Vendor",
    entityId: vendor.id,
    actorId: actorAuthIdentityId,
  });
  return vendor;
}

/** Organization vendor list — alphabetical, with expense counts. */
export function listOrganizationVendors(
  organizationId: string,
  options: { status?: VendorStatus } = {},
) {
  return prisma.vendor.findMany({
    where: {
      organizationId,
      ...(options.status ? { status: options.status } : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    include: { _count: { select: { expenses: true } } },
  });
}

/* ------------------------------------------------------------------ */
/* Expense creation and lifecycle                                      */
/* ------------------------------------------------------------------ */

/**
 * Create an expense as DRAFT. The org-scoped reference ("EXP-7") comes
 * from the atomic ExpenseSequence counter inside the creation
 * transaction, so concurrent creations can never mint the same
 * reference. `reimbursementStatus` may start at PENDING when the
 * volunteer already paid out of pocket — REIMBURSED is only reachable
 * through the recorded transition.
 */
export async function createExpense(
  organizationId: string,
  input: ExpenseCreateInput,
  actorAuthIdentityId: string,
) {
  const amountMinor = parseAmount(input.amount, input.currency);
  const expense = await prisma.$transaction(async (tx) => {
    await resolveExpenseRelations(tx, organizationId, input);
    assertPayerConsistency(
      input.paidByMemberId ?? null,
      input.reimbursementStatus,
    );

    const seq = await tx.expenseSequence.upsert({
      where: { organizationId },
      update: { nextNumber: { increment: 1 } },
      create: { organizationId, nextNumber: 1 },
      select: { nextNumber: true },
    });

    const expense = await tx.expense.create({
      data: {
        organizationId,
        sequence: seq.nextNumber,
        reference: `EXP-${seq.nextNumber}`,
        expenseDate: input.expenseDate,
        amountMinor,
        currency: input.currency,
        vendorId: input.vendorId ?? null,
        category: input.category ?? null,
        description: input.description ?? null,
        submittedByMemberId: input.submittedByMemberId ?? null,
        paidByMemberId: input.paidByMemberId ?? null,
        reimbursementStatus: input.reimbursementStatus,
        createdByAuthIdentityId: actorAuthIdentityId,
      },
    });
    await expenseEvent(tx, expense, "EXPENSE_CREATED", actorAuthIdentityId);
    return expense;
  });
  log({
    event: "expenses.created",
    subsystem: "expenses",
    entityType: "Expense",
    entityId: expense.id,
    organizationId,
    actorId: actorAuthIdentityId,
  });
  return expense;
}

/**
 * Allowed record-lifecycle transitions. APPROVED is terminal — an
 * approved record is corrected through the audited correction path, not
 * reopened. REJECTED returns to DRAFT for rework; SUBMITTED returns to
 * DRAFT to withdraw for edits.
 */
const EXPENSE_TRANSITIONS: Record<ExpenseStatus, ExpenseStatus[]> = {
  DRAFT: ["SUBMITTED", "APPROVED", "REJECTED"],
  SUBMITTED: ["APPROVED", "REJECTED", "DRAFT"],
  APPROVED: [],
  REJECTED: ["DRAFT"],
};

/**
 * Transition the expense record lifecycle. Transitioning to the current
 * status is a quiet no-op so a double-submit writes no duplicate
 * history. A rejection requires a human note — the reason is the whole
 * point of rejecting. Approval/rejection stamps reviewedAt/By/Note; a
 * return to DRAFT clears review stamps (the event log keeps them). The
 * row is locked so concurrent transitions serialize and each
 * STATUS_CHANGED event records the actual before/after.
 */
export async function transitionExpenseStatus(
  expenseId: string,
  target: ExpenseTransitionInput,
  actorAuthIdentityId: string,
  note?: string,
) {
  if (target === "REJECTED" && !note) {
    throw new ExpenseInputError(
      "A note is required when rejecting an expense.",
    );
  }
  const result = await prisma.$transaction(async (tx) => {
    const expense = await lockExpense(tx, expenseId);
    if (expense.status === target) {
      return { expense, changed: false };
    }
    if (!EXPENSE_TRANSITIONS[expense.status].includes(target)) {
      throw new ExpenseTransitionError(
        `An expense cannot move from ${expense.status} to ${target}.`,
      );
    }
    const now = new Date();
    const updated = await tx.expense.update({
      where: { id: expense.id },
      data: {
        status: target,
        ...(target === "SUBMITTED" ? { submittedAt: now } : {}),
        ...(target === "APPROVED" || target === "REJECTED"
          ? {
              reviewedAt: now,
              reviewedByAuthIdentityId: actorAuthIdentityId,
              reviewNote: note ?? null,
            }
          : {}),
        // Rework clears the review stamps — the events preserve them.
        ...(target === "DRAFT"
          ? {
              submittedAt: null,
              reviewedAt: null,
              reviewedByAuthIdentityId: null,
              reviewNote: null,
            }
          : {}),
      },
    });
    await expenseEvent(tx, expense, "STATUS_CHANGED", actorAuthIdentityId, {
      from: expense.status,
      to: target,
      ...(note ? { note } : {}),
    });
    return { expense: updated, changed: true };
  });
  if (result.changed) {
    log({
      event: "expenses.status_changed",
      subsystem: "expenses",
      entityType: "Expense",
      entityId: result.expense.id,
      actorId: actorAuthIdentityId,
    });
  }
  return result.expense;
}

/**
 * Record the reimbursement state — a factual axis separate from review.
 * NOT_REQUIRED ↔ PENDING moves freely; →REIMBURSED requires the paying
 * member and stamps reimbursedAt/By/Note; un-marking a REIMBURSED
 * expense back to PENDING requires a note — reversing a recorded fact
 * should say why. Reimbursement is a recorded administrative fact, not
 * payment processing — nothing here moves money.
 */
export async function setExpenseReimbursement(
  expenseId: string,
  input: ExpenseReimbursementInput,
  actorAuthIdentityId: string,
) {
  const result = await prisma.$transaction(async (tx) => {
    const expense = await lockExpense(tx, expenseId);
    const target = input.status;
    if (expense.reimbursementStatus === target) {
      return { expense, changed: false };
    }
    if (target !== "NOT_REQUIRED") {
      assertPayerConsistency(expense.paidByMemberId, target);
    }
    if (expense.reimbursementStatus === "REIMBURSED" && !input.note) {
      throw new ExpenseInputError(
        "A note is required to un-mark a recorded reimbursement.",
      );
    }
    const now = new Date();
    const updated = await tx.expense.update({
      where: { id: expense.id },
      data: {
        reimbursementStatus: target,
        ...(target === "REIMBURSED"
          ? {
              reimbursedAt: now,
              reimbursedByAuthIdentityId: actorAuthIdentityId,
              reimbursementNote: input.note ?? null,
            }
          : {
              // Leaving REIMBURSED clears the stamp — the event log
              // preserves who recorded it and when.
              reimbursedAt: null,
              reimbursedByAuthIdentityId: null,
              reimbursementNote: input.note ?? null,
            }),
      },
    });
    await expenseEvent(
      tx,
      expense,
      "REIMBURSEMENT_CHANGED",
      actorAuthIdentityId,
      {
        from: expense.reimbursementStatus,
        to: target,
        ...(input.note ? { note: input.note } : {}),
      },
    );
    return { expense: updated, changed: true };
  });
  if (result.changed) {
    log({
      event: "expenses.reimbursement_changed",
      subsystem: "expenses",
      entityType: "Expense",
      entityId: result.expense.id,
      actorId: actorAuthIdentityId,
    });
  }
  return result.expense;
}

/* ------------------------------------------------------------------ */
/* Material field corrections                                          */
/* ------------------------------------------------------------------ */

/**
 * Correct the expense's material fields in place — and append a typed
 * before/after ExpenseChange in the same transaction, so a correction
 * cannot commit without its audit snapshot. Once the expense is
 * APPROVED or already REIMBURSED a reason is required; on
 * DRAFT/SUBMITTED/REJECTED it is optional. A correction never changes
 * status on its own. A submission that changes nothing writes no
 * history. The row is locked so concurrent corrections chain
 * before/after correctly.
 */
export async function updateExpense(
  expenseId: string,
  input: ExpenseUpdateInput,
  actorAuthIdentityId: string,
) {
  const amountMinor = parseAmount(input.amount, input.currency);
  const result = await prisma.$transaction(async (tx) => {
    const expense = await lockExpense(tx, expenseId);
    await resolveExpenseRelations(tx, expense.organizationId, input, {
      allowInactiveVendorId: expense.vendorId,
    });
    const next = {
      expenseDate: input.expenseDate,
      amountMinor,
      currency: input.currency,
      vendorId: input.vendorId ?? null,
      category: input.category ?? null,
      description: input.description ?? null,
      submittedByMemberId: input.submittedByMemberId ?? null,
      paidByMemberId: input.paidByMemberId ?? null,
    };
    const materiallyChanged =
      !sameDate(expense.expenseDate, next.expenseDate) ||
      expense.amountMinor !== next.amountMinor ||
      expense.currency !== next.currency ||
      expense.vendorId !== next.vendorId ||
      expense.category !== next.category ||
      expense.description !== next.description ||
      expense.submittedByMemberId !== next.submittedByMemberId ||
      expense.paidByMemberId !== next.paidByMemberId;
    if (!materiallyChanged) {
      return { expense, changeId: null };
    }
    assertPayerConsistency(next.paidByMemberId, expense.reimbursementStatus);
    if (
      (expense.status === "APPROVED" ||
        expense.reimbursementStatus === "REIMBURSED") &&
      !input.reason
    ) {
      throw new ExpenseCorrectionReasonError();
    }
    const change = await tx.expenseChange.create({
      data: {
        organizationId: expense.organizationId,
        expenseId: expense.id,
        reason: input.reason ?? null,
        beforeExpenseDate: expense.expenseDate,
        beforeAmountMinor: expense.amountMinor,
        beforeCurrency: expense.currency,
        beforeVendorId: expense.vendorId,
        beforeCategory: expense.category,
        beforeDescription: expense.description,
        beforeSubmittedByMemberId: expense.submittedByMemberId,
        beforePaidByMemberId: expense.paidByMemberId,
        afterExpenseDate: next.expenseDate,
        afterAmountMinor: next.amountMinor,
        afterCurrency: next.currency,
        afterVendorId: next.vendorId,
        afterCategory: next.category,
        afterDescription: next.description,
        afterSubmittedByMemberId: next.submittedByMemberId,
        afterPaidByMemberId: next.paidByMemberId,
        actorAuthIdentityId,
      },
    });
    const updated = await tx.expense.update({
      where: { id: expense.id },
      data: next,
    });
    await expenseEvent(
      tx,
      expense,
      "CORRECTION_RECORDED",
      actorAuthIdentityId,
      {
        changeId: change.id,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    );
    return { expense: updated, changeId: change.id };
  });
  if (result.changeId) {
    log({
      event: "expenses.corrected",
      subsystem: "expenses",
      entityType: "Expense",
      entityId: result.expense.id,
      actorId: actorAuthIdentityId,
    });
  }
  return result.expense;
}

/* ------------------------------------------------------------------ */
/* Context links — what the purchase was for                           */
/* ------------------------------------------------------------------ */

interface LinkTarget {
  id: string;
  label: string;
}

/**
 * Resolve a context-link target inside the expense's organization and
 * snapshot a human label into the link event — the history sentence
 * stays accurate even if the target is renamed later.
 */
async function resolveLinkTarget(
  tx: Prisma.TransactionClient,
  kind: ExpenseContextLinkKindInput,
  targetId: string,
  organizationId: string,
): Promise<LinkTarget> {
  const scope = { id: targetId, organizationId };
  if (kind === "INCIDENT") {
    const row = await tx.incident.findFirst({
      where: scope,
      select: { reference: true, title: true },
    });
    if (!row) throw new CrossOrganizationExpenseError();
    return { id: targetId, label: `${row.reference} ${row.title}` };
  }
  if (kind === "TRAINING_EVENT") {
    const row = await tx.trainingEvent.findFirst({
      where: scope,
      select: { title: true, date: true },
    });
    if (!row) throw new CrossOrganizationExpenseError();
    return {
      id: targetId,
      label: `${row.title} (${formatDateOnly(row.date)})`,
    };
  }
  if (kind === "ASSET") {
    const row = await tx.asset.findFirst({
      where: scope,
      select: { name: true },
    });
    if (!row) throw new CrossOrganizationExpenseError();
    return { id: targetId, label: row.name };
  }
  if (kind === "MAINTENANCE_RECORD") {
    const row = await tx.maintenanceRecord.findFirst({
      where: scope,
      select: { title: true },
    });
    if (!row) throw new CrossOrganizationExpenseError();
    return { id: targetId, label: row.title };
  }
  const row = await tx.inventoryItem.findFirst({
    where: scope,
    select: { name: true },
  });
  if (!row) throw new CrossOrganizationExpenseError();
  return { id: targetId, label: row.name };
}

async function createContextLinkRow(
  tx: Prisma.TransactionClient,
  kind: ExpenseContextLinkKindInput,
  link: {
    organizationId: string;
    expenseId: string;
    note?: string;
    recordedByAuthIdentityId: string;
  },
  targetId: string,
) {
  const base = {
    organizationId: link.organizationId,
    expenseId: link.expenseId,
    note: link.note ?? null,
    recordedByAuthIdentityId: link.recordedByAuthIdentityId,
  };
  if (kind === "INCIDENT") {
    return tx.expenseIncident.create({
      data: { ...base, incidentId: targetId },
    });
  }
  if (kind === "TRAINING_EVENT") {
    return tx.expenseTrainingEvent.create({
      data: { ...base, trainingEventId: targetId },
    });
  }
  if (kind === "ASSET") {
    return tx.expenseAsset.create({ data: { ...base, assetId: targetId } });
  }
  if (kind === "MAINTENANCE_RECORD") {
    return tx.expenseMaintenanceRecord.create({
      data: { ...base, maintenanceRecordId: targetId },
    });
  }
  return tx.expenseInventoryItem.create({
    data: { ...base, inventoryItemId: targetId },
  });
}

/**
 * Link the expense to an operational record — incident, training event,
 * asset, maintenance record, or inventory item. An expense may hold
 * several links ("oil + filter → the vessel AND its service record").
 * The unique (expenseId, targetId) pair plus the row lock make a
 * concurrent duplicate link a loud domain error, never a double row.
 */
export async function addExpenseContextLink(
  expenseId: string,
  kind: ExpenseContextLinkKindInput,
  targetId: string,
  note: string | undefined,
  actorAuthIdentityId: string,
) {
  const result = await prisma.$transaction(async (tx) => {
    const expense = await lockExpense(tx, expenseId);
    const target = await resolveLinkTarget(
      tx,
      kind,
      targetId,
      expense.organizationId,
    );
    let link;
    try {
      link = await createContextLinkRow(
        tx,
        kind,
        {
          organizationId: expense.organizationId,
          expenseId: expense.id,
          note,
          recordedByAuthIdentityId: actorAuthIdentityId,
        },
        target.id,
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ExpenseDuplicateLinkError();
      throw error;
    }
    await expenseEvent(tx, expense, "CONTEXT_LINKED", actorAuthIdentityId, {
      kind,
      targetId: target.id,
      targetLabel: target.label,
      ...(note ? { note } : {}),
    });
    return { expense, linkId: link.id };
  });
  log({
    event: "expenses.context_linked",
    subsystem: "expenses",
    entityType: "Expense",
    entityId: result.expense.id,
    actorId: actorAuthIdentityId,
  });
  return result.linkId;
}

/** Find a context link row by kind+id and return it with its target id. */
async function findContextLink(
  tx: Prisma.TransactionClient,
  kind: ExpenseContextLinkKindInput,
  linkId: string,
): Promise<{ linkId: string; expenseId: string; targetId: string } | null> {
  const where = { id: linkId };
  if (kind === "INCIDENT") {
    const row = await tx.expenseIncident.findUnique({ where });
    return (
      row && {
        linkId: row.id,
        expenseId: row.expenseId,
        targetId: row.incidentId,
      }
    );
  }
  if (kind === "TRAINING_EVENT") {
    const row = await tx.expenseTrainingEvent.findUnique({ where });
    return (
      row && {
        linkId: row.id,
        expenseId: row.expenseId,
        targetId: row.trainingEventId,
      }
    );
  }
  if (kind === "ASSET") {
    const row = await tx.expenseAsset.findUnique({ where });
    return (
      row && { linkId: row.id, expenseId: row.expenseId, targetId: row.assetId }
    );
  }
  if (kind === "MAINTENANCE_RECORD") {
    const row = await tx.expenseMaintenanceRecord.findUnique({ where });
    return (
      row && {
        linkId: row.id,
        expenseId: row.expenseId,
        targetId: row.maintenanceRecordId,
      }
    );
  }
  const row = await tx.expenseInventoryItem.findUnique({ where });
  return (
    row && {
      linkId: row.id,
      expenseId: row.expenseId,
      targetId: row.inventoryItemId,
    }
  );
}

async function deleteContextLinkRow(
  tx: Prisma.TransactionClient,
  kind: ExpenseContextLinkKindInput,
  linkId: string,
) {
  const where = { id: linkId };
  if (kind === "INCIDENT") return tx.expenseIncident.delete({ where });
  if (kind === "TRAINING_EVENT")
    return tx.expenseTrainingEvent.delete({ where });
  if (kind === "ASSET") return tx.expenseAsset.delete({ where });
  if (kind === "MAINTENANCE_RECORD")
    return tx.expenseMaintenanceRecord.delete({ where });
  return tx.expenseInventoryItem.delete({ where });
}

/**
 * Remove a context link — the row deletes and a CONTEXT_UNLINKED event
 * records what was removed, when, and by whom. The target's label is
 * snapshotted again at removal so the audit sentence stays accurate.
 * A foreign or fabricated link id fails opaquely.
 */
export async function removeExpenseContextLink(
  kind: ExpenseContextLinkKindInput,
  linkId: string,
  actorAuthIdentityId: string,
) {
  const result = await prisma.$transaction(async (tx) => {
    const link = await findContextLink(tx, kind, linkId);
    if (!link) throw new CrossOrganizationExpenseError();
    const expense = await lockExpense(tx, link.expenseId);
    const target = await resolveLinkTarget(
      tx,
      kind,
      link.targetId,
      expense.organizationId,
    );
    await deleteContextLinkRow(tx, kind, link.linkId);
    await expenseEvent(tx, expense, "CONTEXT_UNLINKED", actorAuthIdentityId, {
      kind,
      targetId: link.targetId,
      targetLabel: target.label,
    });
    return expense;
  });
  log({
    event: "expenses.context_unlinked",
    subsystem: "expenses",
    entityType: "Expense",
    entityId: result.id,
    actorId: actorAuthIdentityId,
  });
}

/* ------------------------------------------------------------------ */
/* Read models                                                         */
/* ------------------------------------------------------------------ */

/** List filters supported by the admin expense index. */
export interface ExpenseFilters {
  vendorId?: string;
  from?: Date;
  to?: Date;
  category?: string;
  status?: ExpenseStatus;
  reimbursementStatus?: ReimbursementStatus;
  assetId?: string;
  incidentId?: string;
}

/**
 * Organization expense list — newest expense date first, with vendor
 * names and link counts for the index. Context filters match through
 * the typed link tables; date filters compare the org-local calendar
 * date column directly.
 */
export function listOrganizationExpenses(
  organizationId: string,
  filters: ExpenseFilters = {},
) {
  return prisma.expense.findMany({
    where: {
      organizationId,
      ...(filters.vendorId ? { vendorId: filters.vendorId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.reimbursementStatus
        ? { reimbursementStatus: filters.reimbursementStatus }
        : {}),
      ...(filters.category
        ? { category: { equals: filters.category, mode: "insensitive" } }
        : {}),
      ...(filters.from || filters.to
        ? {
            expenseDate: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
      ...(filters.assetId
        ? { assetLinks: { some: { assetId: filters.assetId } } }
        : {}),
      ...(filters.incidentId
        ? { incidentLinks: { some: { incidentId: filters.incidentId } } }
        : {}),
    },
    orderBy: [{ expenseDate: "desc" }, { sequence: "desc" }],
    include: {
      vendor: { select: { id: true, name: true } },
      paidByMember: { select: { id: true, displayName: true } },
      _count: {
        select: {
          attachments: true,
          incidentLinks: true,
          trainingLinks: true,
          assetLinks: true,
          maintenanceLinks: true,
          inventoryLinks: true,
        },
      },
    },
  });
}

/** Distinct recorded categories for the filter datalist. */
export async function listOrganizationExpenseCategories(
  organizationId: string,
): Promise<string[]> {
  const rows = await prisma.expense.findMany({
    where: { organizationId, category: { not: null } },
    select: { category: true },
    distinct: ["category"],
    orderBy: { category: "asc" },
  });
  return rows.map((r) => r.category!).filter(Boolean);
}

/**
 * One expense with its full administrative detail: material fields,
 * vendor and member display names, every context link with its target
 * label, the system event feed, and the correction audit. Actor display
 * resolves best-effort (member display name in this org → identity
 * email → raw scalar id) — the same policy as incidents.
 */
export async function getExpenseForAdmin(expenseId: string) {
  const expense = await prisma.expense.findUnique({
    where: { id: expenseId },
    include: {
      organization: { select: { id: true, name: true, timezone: true } },
      vendor: { select: { id: true, name: true, status: true } },
      submittedByMember: { select: { id: true, displayName: true } },
      paidByMember: { select: { id: true, displayName: true } },
      incidentLinks: {
        orderBy: { recordedAt: "asc" },
        include: {
          incident: { select: { id: true, reference: true, title: true } },
        },
      },
      trainingLinks: {
        orderBy: { recordedAt: "asc" },
        include: {
          trainingEvent: { select: { id: true, title: true, date: true } },
        },
      },
      assetLinks: {
        orderBy: { recordedAt: "asc" },
        include: { asset: { select: { id: true, name: true } } },
      },
      maintenanceLinks: {
        orderBy: { recordedAt: "asc" },
        include: {
          maintenanceRecord: {
            select: { id: true, title: true, performedOn: true },
          },
        },
      },
      inventoryLinks: {
        orderBy: { recordedAt: "asc" },
        include: { inventoryItem: { select: { id: true, name: true } } },
      },
      events: { orderBy: [{ occurredAt: "asc" }, { id: "asc" }] },
      changes: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] },
    },
  });
  if (!expense) return null;

  const actorIds = [
    ...new Set(
      [
        expense.createdByAuthIdentityId,
        expense.reviewedByAuthIdentityId,
        expense.reimbursedByAuthIdentityId,
        ...expense.events.map((e) => e.actorAuthIdentityId),
        ...expense.changes.map((c) => c.actorAuthIdentityId),
        ...expense.incidentLinks.map((l) => l.recordedByAuthIdentityId),
        ...expense.trainingLinks.map((l) => l.recordedByAuthIdentityId),
        ...expense.assetLinks.map((l) => l.recordedByAuthIdentityId),
        ...expense.maintenanceLinks.map((l) => l.recordedByAuthIdentityId),
        ...expense.inventoryLinks.map((l) => l.recordedByAuthIdentityId),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  // Shared audit-actor policy (#38): member display name in this org,
  // then identity email, then the raw id as the forensic fallback.
  const labels = await resolveActorLabels(expense.organizationId, actorIds);
  const actorName = (id: string | null) => (id ? (labels.get(id) ?? id) : null);

  return {
    ...expense,
    createdByDisplay: actorName(expense.createdByAuthIdentityId),
    reviewedByDisplay: actorName(expense.reviewedByAuthIdentityId),
    reimbursedByDisplay: actorName(expense.reimbursedByAuthIdentityId),
    events: expense.events.map((event) => ({
      ...event,
      actorDisplay: actorName(event.actorAuthIdentityId),
      text: describeExpenseEvent(event),
    })),
    changes: expense.changes.map((change) => ({
      ...change,
      actorDisplay: actorName(change.actorAuthIdentityId),
    })),
  };
}
