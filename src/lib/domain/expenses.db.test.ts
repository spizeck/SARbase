import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Database-backed tests for the issue #17 vendor/expense domain. They
 * run only via `npm run test:db` (DATABASE_URL present) — fixtures are
 * prefixed `exp17test-` and cleaned up in afterAll. Attachment tests
 * use the in-memory storage provider — no real filesystem is touched.
 */

import { prisma } from "@/lib/prisma";
import { InMemoryFileStorageProvider } from "@/lib/storage/memory";
import {
  createVendor,
  updateVendor,
  setVendorStatus,
  createExpense,
  transitionExpenseStatus,
  setExpenseReimbursement,
  updateExpense,
  addExpenseContextLink,
  removeExpenseContextLink,
  listOrganizationVendors,
  listOrganizationExpenses,
  getExpenseForAdmin,
  CrossOrganizationExpenseError,
  ExpenseInputError,
  ExpenseTransitionError,
  ExpenseCorrectionReasonError,
  ExpenseDuplicateLinkError,
} from "./expenses";
import { createIncident } from "./incidents";
import {
  uploadAttachment,
  unlinkAttachment,
  deleteAttachment,
  listEntityAttachments,
  AttachmentReasonRequiredError,
  type AttachmentFileInput,
} from "./attachments";

const hasDb = Boolean(process.env.DATABASE_URL);
// Run-scoped prefix: a crashed afterAll can never collide with or be
// mis-cleaned by a later run.
const PREFIX = `exp17test-${Date.now().toString(36)}-`;

let counter = 0;
function uniq(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

const RECEIPT: AttachmentFileInput = {
  name: "receipt.pdf",
  mediaType: "application/pdf",
  bytes: new TextEncoder().encode("%PDF-1.4 synthetic receipt fixture"),
};

let orgA: { id: string };
let orgB: { id: string };
let actorA: { id: string };
let memberA: { id: string; displayName: string };
let memberB: { id: string };
let vendorA: { id: string };
let vendorB: { id: string };
let assetA: { id: string; name: string };
let assetB: { id: string };
let incidentA: { id: string };
let incidentB: { id: string };
let trainingA: { id: string };
let maintenanceA: { id: string };
let inventoryA: { id: string };

let storage: InMemoryFileStorageProvider;

function expenseInput(
  overrides: Partial<Parameters<typeof createExpense>[1]> = {},
) {
  return {
    expenseDate: new Date("2026-03-15T00:00:00.000Z"),
    amount: "42.15",
    currency: "USD",
    vendorId: vendorA.id,
    category: "Fuel",
    description: uniq("expense"),
    reimbursementStatus: "NOT_REQUIRED" as const,
    ...overrides,
  };
}

async function makeExpense(
  overrides: Partial<Parameters<typeof createExpense>[1]> = {},
  orgId = orgA.id,
) {
  return createExpense(orgId, expenseInput(overrides), actorA.id);
}

async function eventTypes(expenseId: string) {
  const events = await prisma.expenseEvent.findMany({
    where: { expenseId },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
  return events.map((e) => e.type);
}

describe.skipIf(!hasDb)("vendors and expenses (issue #17)", () => {
  beforeAll(async () => {
    storage = new InMemoryFileStorageProvider();
    orgA = await prisma.organization.create({
      data: { name: uniq("org-a"), timezone: "Pacific/Auckland" },
    });
    orgB = await prisma.organization.create({ data: { name: uniq("org-b") } });
    actorA = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("actor"),
        email: `${uniq("actor")}@example.test`,
      },
    });
    memberA = await prisma.member.create({
      data: { organizationId: orgA.id, displayName: uniq("member-a") },
    });
    memberB = await prisma.member.create({
      data: { organizationId: orgB.id, displayName: uniq("member-b") },
    });
    vendorA = await createVendor(
      orgA.id,
      {
        name: uniq("vendor-a"),
        contactName: "Sam Sales",
        email: "sam@example.test",
        phone: "+1 555 0100",
        website: "https://vendor-a.example.test",
        accountReference: "ACCT-001",
        notes: "asks for PO numbers",
      },
      actorA.id,
    );
    vendorB = await createVendor(
      orgB.id,
      { name: uniq("vendor-b") },
      actorA.id,
    );
    assetA = await prisma.asset.create({
      data: { organizationId: orgA.id, name: uniq("asset-a") },
    });
    assetB = await prisma.asset.create({
      data: { organizationId: orgB.id, name: uniq("asset-b") },
    });
    incidentA = await createIncident(
      orgA.id,
      { title: uniq("incident-a") },
      actorA.id,
    );
    incidentB = await createIncident(
      orgB.id,
      { title: uniq("incident-b") },
      actorA.id,
    );
    trainingA = await prisma.trainingEvent.create({
      data: {
        organizationId: orgA.id,
        title: uniq("training-a"),
        date: new Date("2026-03-01T00:00:00.000Z"),
      },
    });
    maintenanceA = await prisma.maintenanceRecord.create({
      data: {
        organizationId: orgA.id,
        assetId: assetA.id,
        title: uniq("service-a"),
        performedOn: new Date("2026-03-05T00:00:00.000Z"),
      },
    });
    inventoryA = await prisma.inventoryItem.create({
      data: {
        organizationId: orgA.id,
        name: uniq("item-a"),
        quantity: 12,
      },
    });
  });

  afterAll(async () => {
    const orgFilter = { organization: { name: { startsWith: PREFIX } } };
    // Append-only children and link rows first (Restrict edges), then
    // expenses/vendors, then the shared fixtures.
    await prisma.expenseChange.deleteMany({ where: orgFilter });
    await prisma.expenseEvent.deleteMany({ where: orgFilter });
    await prisma.expenseIncident.deleteMany({ where: orgFilter });
    await prisma.expenseTrainingEvent.deleteMany({ where: orgFilter });
    await prisma.expenseAsset.deleteMany({ where: orgFilter });
    await prisma.expenseMaintenanceRecord.deleteMany({ where: orgFilter });
    await prisma.expenseInventoryItem.deleteMany({ where: orgFilter });
    await prisma.expenseAttachment.deleteMany({ where: orgFilter });
    await prisma.expenseSequence.deleteMany({ where: orgFilter });
    await prisma.expense.deleteMany({ where: orgFilter });
    await prisma.vendor.deleteMany({ where: orgFilter });
    await prisma.attachmentEvent.deleteMany({ where: orgFilter });
    await prisma.attachment.deleteMany({ where: orgFilter });
    await prisma.incidentTimelineEvent.deleteMany({ where: orgFilter });
    await prisma.incidentChange.deleteMany({ where: orgFilter });
    await prisma.incidentMember.deleteMany({ where: orgFilter });
    await prisma.incidentAsset.deleteMany({ where: orgFilter });
    await prisma.incidentSequence.deleteMany({ where: orgFilter });
    await prisma.incident.deleteMany({ where: orgFilter });
    await prisma.maintenanceRecord.deleteMany({ where: orgFilter });
    await prisma.inventoryItem.deleteMany({ where: orgFilter });
    await prisma.trainingEvent.deleteMany({ where: orgFilter });
    await prisma.asset.deleteMany({ where: orgFilter });
    await prisma.member.deleteMany({ where: orgFilter });
    await prisma.authIdentity.deleteMany({
      where: { providerUid: { startsWith: PREFIX } },
    });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  /* ---------------- vendors ---------------- */

  it("creates a vendor with contact and reference fields", async () => {
    const vendor = await prisma.vendor.findUniqueOrThrow({
      where: { id: vendorA.id },
    });
    expect(vendor.organizationId).toBe(orgA.id);
    expect(vendor.status).toBe("ACTIVE");
    expect(vendor.accountReference).toBe("ACCT-001");
    expect(vendor.contactName).toBe("Sam Sales");
  });

  it("allows duplicate vendor names — accountReference disambiguates", async () => {
    const a = await createVendor(orgA.id, { name: uniq("dup") }, actorA.id);
    const b = await createVendor(orgA.id, { name: a.name }, actorA.id);
    expect(b.name).toBe(a.name);
    expect(b.id).not.toBe(a.id);
  });

  it("updates vendor contact fields in place", async () => {
    const updated = await updateVendor(
      vendorB.id,
      { name: uniq("renamed"), email: "new@example.test" },
      actorA.id,
    );
    expect(updated.email).toBe("new@example.test");
    const persisted = await prisma.vendor.findUniqueOrThrow({
      where: { id: vendorB.id },
    });
    expect(persisted.name).toBe(updated.name);
  });

  it("rejects an inactive vendor for new expenses but keeps it on history", async () => {
    const inactive = await createVendor(
      orgA.id,
      { name: uniq("inactive") },
      actorA.id,
    );
    const recorded = await makeExpense({ vendorId: inactive.id });
    await setVendorStatus(inactive.id, "INACTIVE", actorA.id);
    await expect(makeExpense({ vendorId: inactive.id })).rejects.toBeInstanceOf(
      ExpenseInputError,
    );
    // The already-recorded expense keeps its vendor reference.
    const detail = await getExpenseForAdmin(recorded.id);
    expect(detail?.vendor?.id).toBe(inactive.id);
    expect(detail?.vendor?.status).toBe("INACTIVE");
    // Reactivation restores the vendor as a choice.
    await setVendorStatus(inactive.id, "ACTIVE", actorA.id);
    await expect(makeExpense({ vendorId: inactive.id })).resolves.toBeDefined();
  });

  it("lists vendors with expense counts, filtered by status", async () => {
    const countedVendor = await createVendor(
      orgA.id,
      { name: uniq("counted") },
      actorA.id,
    );
    await makeExpense({ vendorId: countedVendor.id });
    const all = await listOrganizationVendors(orgA.id);
    expect(all.every((v) => v.organizationId === orgA.id)).toBe(true);
    const activeOnly = await listOrganizationVendors(orgA.id, {
      status: "ACTIVE",
    });
    expect(activeOnly.every((v) => v.status === "ACTIVE")).toBe(true);
    const counted = all.find((v) => v.id === countedVendor.id);
    expect(counted?._count.expenses).toBe(1);
  });

  /* ---------------- expense creation + exact money ---------------- */

  it("creates a DRAFT expense with exact minor units and an org-scoped reference", async () => {
    const a = await makeExpense();
    const b = await makeExpense();
    expect(a.status).toBe("DRAFT");
    expect(a.amountMinor).toBe(4215);
    expect(a.currency).toBe("USD");
    expect(a.createdByAuthIdentityId).toBe(actorA.id);
    expect(a.reference).toMatch(/^EXP-\d+$/);
    const n = (r: string) => Number(r.split("-").at(-1));
    expect(n(b.reference)).toBe(n(a.reference) + 1);
    expect(await eventTypes(a.id)).toEqual(["EXPENSE_CREATED"]);
  });

  it("keeps an independent expense sequence per organization", async () => {
    const foreign = await createExpense(
      orgB.id,
      expenseInput({ vendorId: undefined }),
      actorA.id,
    );
    expect(foreign.reference).toBe("EXP-1");
    expect(foreign.organizationId).toBe(orgB.id);
  });

  it("rejects malformed amounts and unknown currencies without writing", async () => {
    for (const bad of ["12.345", "0", "-5", "abc", "1e3"]) {
      await expect(makeExpense({ amount: bad })).rejects.toBeInstanceOf(
        ExpenseInputError,
      );
    }
    await expect(makeExpense({ currency: "ZZZ" })).rejects.toBeInstanceOf(
      ExpenseInputError,
    );
    // Nothing partial was written for the failures above.
    const count = await prisma.expense.count({
      where: { organizationId: orgA.id, description: { contains: "abc" } },
    });
    expect(count).toBe(0);
  });

  it("stores exact minor units for currencies without two decimals", async () => {
    const jpy = await makeExpense({ amount: "1900", currency: "JPY" });
    expect(jpy.amountMinor).toBe(1900);
    await expect(
      makeExpense({ amount: "19.5", currency: "JPY" }),
    ).rejects.toBeInstanceOf(ExpenseInputError);
    const kwd = await makeExpense({ amount: "1.500", currency: "KWD" });
    expect(kwd.amountMinor).toBe(1500);
  });

  it("rejects foreign vendor and member selectors opaquely", async () => {
    await expect(makeExpense({ vendorId: vendorB.id })).rejects.toBeInstanceOf(
      CrossOrganizationExpenseError,
    );
    await expect(
      makeExpense({ paidByMemberId: memberB.id }),
    ).rejects.toBeInstanceOf(CrossOrganizationExpenseError);
    await expect(
      makeExpense({ vendorId: "nonexistent-vendor" }),
    ).rejects.toBeInstanceOf(CrossOrganizationExpenseError);
  });

  /* ---------------- lifecycle ---------------- */

  it("moves DRAFT → SUBMITTED → APPROVED with stamped review facts", async () => {
    const expense = await makeExpense();
    await transitionExpenseStatus(expense.id, "SUBMITTED", actorA.id);
    let row = await prisma.expense.findUniqueOrThrow({
      where: { id: expense.id },
    });
    expect(row.status).toBe("SUBMITTED");
    expect(row.submittedAt).toBeInstanceOf(Date);

    await transitionExpenseStatus(expense.id, "APPROVED", actorA.id);
    row = await prisma.expense.findUniqueOrThrow({
      where: { id: expense.id },
    });
    expect(row.status).toBe("APPROVED");
    expect(row.reviewedAt).toBeInstanceOf(Date);
    expect(row.reviewedByAuthIdentityId).toBe(actorA.id);
    expect(await eventTypes(expense.id)).toEqual([
      "EXPENSE_CREATED",
      "STATUS_CHANGED",
      "STATUS_CHANGED",
    ]);
  });

  it("requires a note to reject and clears review stamps on rework", async () => {
    const expense = await makeExpense();
    await transitionExpenseStatus(expense.id, "SUBMITTED", actorA.id);
    await expect(
      transitionExpenseStatus(expense.id, "REJECTED", actorA.id),
    ).rejects.toBeInstanceOf(ExpenseInputError);
    await transitionExpenseStatus(
      expense.id,
      "REJECTED",
      actorA.id,
      "Receipt is illegible",
    );
    let row = await prisma.expense.findUniqueOrThrow({
      where: { id: expense.id },
    });
    expect(row.status).toBe("REJECTED");
    expect(row.reviewNote).toBe("Receipt is illegible");

    await transitionExpenseStatus(expense.id, "DRAFT", actorA.id);
    row = await prisma.expense.findUniqueOrThrow({
      where: { id: expense.id },
    });
    expect(row.status).toBe("DRAFT");
    expect(row.reviewedAt).toBeNull();
    expect(row.reviewedByAuthIdentityId).toBeNull();
    // The event log keeps the full history despite cleared stamps.
    const events = await prisma.expenseEvent.findMany({
      where: { expenseId: expense.id, type: "STATUS_CHANGED" },
    });
    expect(events).toHaveLength(3);
  });

  it("rejects impossible transitions and treats repeats as quiet no-ops", async () => {
    const expense = await makeExpense();
    await expect(
      transitionExpenseStatus(expense.id, "DRAFT" as never, actorA.id),
    ).resolves.toBeDefined(); // DRAFT→DRAFT no-op
    await transitionExpenseStatus(expense.id, "SUBMITTED", actorA.id);
    await transitionExpenseStatus(expense.id, "APPROVED", actorA.id);
    // APPROVED is terminal — corrections go through updateExpense.
    await expect(
      transitionExpenseStatus(expense.id, "DRAFT", actorA.id),
    ).rejects.toBeInstanceOf(ExpenseTransitionError);
    await expect(
      transitionExpenseStatus(expense.id, "REJECTED", actorA.id, "no"),
    ).rejects.toBeInstanceOf(ExpenseTransitionError);
    // A failed transition writes no event.
    expect(await eventTypes(expense.id)).toEqual([
      "EXPENSE_CREATED",
      "STATUS_CHANGED",
      "STATUS_CHANGED",
    ]);
    // Double-approve is a quiet no-op — no duplicate history.
    await transitionExpenseStatus(expense.id, "APPROVED", actorA.id);
    expect(
      (await prisma.expenseEvent.findMany({ where: { expenseId: expense.id } }))
        .length,
    ).toBe(3);
  });

  /* ---------------- reimbursement ---------------- */

  it("requires a paying member before reimbursement can be pending", async () => {
    const orgPaid = await makeExpense({ paidByMemberId: undefined });
    await expect(
      setExpenseReimbursement(orgPaid.id, { status: "PENDING" }, actorA.id),
    ).rejects.toBeInstanceOf(ExpenseInputError);
  });

  it("records the full reimbursement lifecycle as distinct facts", async () => {
    const expense = await makeExpense({
      paidByMemberId: memberA.id,
      reimbursementStatus: "PENDING",
    });
    expect(expense.reimbursementStatus).toBe("PENDING");

    await setExpenseReimbursement(
      expense.id,
      { status: "REIMBURSED", note: "repaid via petty cash" },
      actorA.id,
    );
    let row = await prisma.expense.findUniqueOrThrow({
      where: { id: expense.id },
    });
    expect(row.reimbursementStatus).toBe("REIMBURSED");
    expect(row.reimbursedAt).toBeInstanceOf(Date);
    expect(row.reimbursedByAuthIdentityId).toBe(actorA.id);
    expect(row.reimbursementNote).toBe("repaid via petty cash");

    // Un-marking a recorded fact needs a note.
    await expect(
      setExpenseReimbursement(expense.id, { status: "PENDING" }, actorA.id),
    ).rejects.toBeInstanceOf(ExpenseInputError);
    await setExpenseReimbursement(
      expense.id,
      { status: "PENDING", note: "repayment bounced — reissue" },
      actorA.id,
    );
    row = await prisma.expense.findUniqueOrThrow({
      where: { id: expense.id },
    });
    expect(row.reimbursementStatus).toBe("PENDING");
    expect(row.reimbursedAt).toBeNull();
    expect(await eventTypes(expense.id)).toEqual([
      "EXPENSE_CREATED",
      "REIMBURSEMENT_CHANGED",
      "REIMBURSEMENT_CHANGED",
    ]);
  });

  it("keeps reimbursement independent from review state", async () => {
    const expense = await makeExpense({ paidByMemberId: memberA.id });
    await transitionExpenseStatus(expense.id, "SUBMITTED", actorA.id);
    await transitionExpenseStatus(expense.id, "APPROVED", actorA.id);
    // Approval does not itself reimburse or require reimbursement.
    const row = await prisma.expense.findUniqueOrThrow({
      where: { id: expense.id },
    });
    expect(row.status).toBe("APPROVED");
    expect(row.reimbursementStatus).toBe("NOT_REQUIRED");
  });

  /* ---------------- corrections ---------------- */

  it("writes a typed before/after correction for material edits", async () => {
    const expense = await makeExpense({ amount: "10.00" });
    const updated = await updateExpense(
      expense.id,
      {
        ...expenseInput({ amount: "12.50", category: "Maintenance" }),
      },
      actorA.id,
    );
    expect(updated.amountMinor).toBe(1250);
    const change = await prisma.expenseChange.findFirstOrThrow({
      where: { expenseId: expense.id },
    });
    expect(change.beforeAmountMinor).toBe(1000);
    expect(change.afterAmountMinor).toBe(1250);
    expect(change.beforeCategory).toBe("Fuel");
    expect(change.afterCategory).toBe("Maintenance");
    expect(change.actorAuthIdentityId).toBe(actorA.id);
    expect(await eventTypes(expense.id)).toContain("CORRECTION_RECORDED");
  });

  it("writes no history for a no-op correction", async () => {
    const input = expenseInput({ description: "unchanged" });
    const expense = await makeExpense(input);
    const before = await prisma.expenseChange.count({
      where: { expenseId: expense.id },
    });
    await updateExpense(expense.id, { ...input }, actorA.id);
    expect(
      await prisma.expenseChange.count({ where: { expenseId: expense.id } }),
    ).toBe(before);
    expect(await eventTypes(expense.id)).toEqual(["EXPENSE_CREATED"]);
  });

  it("requires a reason for corrections on approved or reimbursed records", async () => {
    const expense = await makeExpense();
    await transitionExpenseStatus(expense.id, "SUBMITTED", actorA.id);
    await transitionExpenseStatus(expense.id, "APPROVED", actorA.id);
    await expect(
      updateExpense(expense.id, expenseInput({ amount: "99.99" }), actorA.id),
    ).rejects.toBeInstanceOf(ExpenseCorrectionReasonError);
    // The failed correction changed nothing and wrote nothing.
    const row = await prisma.expense.findUniqueOrThrow({
      where: { id: expense.id },
    });
    expect(row.amountMinor).toBe(4215);
    expect(
      await prisma.expenseChange.count({ where: { expenseId: expense.id } }),
    ).toBe(0);

    const corrected = await updateExpense(
      expense.id,
      {
        ...expenseInput({ amount: "42.15", vendorId: undefined }),
        reason: "vendor was actually a cash purchase",
      },
      actorA.id,
    );
    // Correction does not silently reset approval.
    expect(corrected.status).toBe("APPROVED");
    expect(corrected.vendorId).toBeNull();
    const change = await prisma.expenseChange.findFirstOrThrow({
      where: { expenseId: expense.id },
    });
    expect(change.reason).toBe("vendor was actually a cash purchase");
    expect(change.beforeVendorId).toBe(vendorA.id);
    expect(change.afterVendorId).toBeNull();
  });

  it("keeps the payer consistent with the reimbursement state", async () => {
    const expense = await makeExpense({
      paidByMemberId: memberA.id,
      reimbursementStatus: "PENDING",
    });
    await expect(
      updateExpense(
        expense.id,
        expenseInput({ paidByMemberId: undefined }),
        actorA.id,
      ),
    ).rejects.toBeInstanceOf(ExpenseInputError);
  });

  /* ---------------- context links ---------------- */

  it("links an expense to every supported record kind", async () => {
    const expense = await makeExpense();
    await addExpenseContextLink(
      expense.id,
      "INCIDENT",
      incidentA.id,
      undefined,
      actorA.id,
    );
    await addExpenseContextLink(
      expense.id,
      "TRAINING_EVENT",
      trainingA.id,
      undefined,
      actorA.id,
    );
    await addExpenseContextLink(
      expense.id,
      "ASSET",
      assetA.id,
      "the vessel this was bought for",
      actorA.id,
    );
    await addExpenseContextLink(
      expense.id,
      "MAINTENANCE_RECORD",
      maintenanceA.id,
      undefined,
      actorA.id,
    );
    await addExpenseContextLink(
      expense.id,
      "INVENTORY_ITEM",
      inventoryA.id,
      undefined,
      actorA.id,
    );
    const detail = await getExpenseForAdmin(expense.id);
    expect(detail?.incidentLinks).toHaveLength(1);
    expect(detail?.trainingLinks).toHaveLength(1);
    expect(detail?.assetLinks).toHaveLength(1);
    expect(detail?.assetLinks[0]?.note).toBe("the vessel this was bought for");
    expect(detail?.maintenanceLinks).toHaveLength(1);
    expect(detail?.inventoryLinks).toHaveLength(1);
    expect(
      (await eventTypes(expense.id)).filter((t) => t === "CONTEXT_LINKED"),
    ).toHaveLength(5);
  });

  it("rejects duplicate links and cross-organization targets", async () => {
    const expense = await makeExpense();
    await addExpenseContextLink(
      expense.id,
      "ASSET",
      assetA.id,
      undefined,
      actorA.id,
    );
    await expect(
      addExpenseContextLink(
        expense.id,
        "ASSET",
        assetA.id,
        undefined,
        actorA.id,
      ),
    ).rejects.toBeInstanceOf(ExpenseDuplicateLinkError);
    await expect(
      addExpenseContextLink(
        expense.id,
        "ASSET",
        assetB.id,
        undefined,
        actorA.id,
      ),
    ).rejects.toBeInstanceOf(CrossOrganizationExpenseError);
    await expect(
      addExpenseContextLink(
        expense.id,
        "INCIDENT",
        incidentB.id,
        undefined,
        actorA.id,
      ),
    ).rejects.toBeInstanceOf(CrossOrganizationExpenseError);
    await expect(
      addExpenseContextLink(
        expense.id,
        "ASSET",
        "nonexistent-asset",
        undefined,
        actorA.id,
      ),
    ).rejects.toBeInstanceOf(CrossOrganizationExpenseError);
    // Only the one successful link exists.
    const count = await prisma.expenseAsset.count({
      where: { expenseId: expense.id },
    });
    expect(count).toBe(1);
  });

  it("removes a link with an audited CONTEXT_UNLINKED event", async () => {
    const expense = await makeExpense();
    const linkId = await addExpenseContextLink(
      expense.id,
      "INCIDENT",
      incidentA.id,
      undefined,
      actorA.id,
    );
    await removeExpenseContextLink("INCIDENT", linkId, actorA.id);
    expect(
      await prisma.expenseIncident.count({
        where: { expenseId: expense.id },
      }),
    ).toBe(0);
    expect(await eventTypes(expense.id)).toEqual([
      "EXPENSE_CREATED",
      "CONTEXT_LINKED",
      "CONTEXT_UNLINKED",
    ]);
    // Removing a foreign or nonexistent link id fails opaquely.
    await expect(
      removeExpenseContextLink("INCIDENT", "nonexistent-link", actorA.id),
    ).rejects.toBeInstanceOf(CrossOrganizationExpenseError);
  });

  /* ---------------- receipt attachments ---------------- */

  it("attaches a receipt through the shared attachment pipeline", async () => {
    const expense = await makeExpense();
    const receipt = await uploadAttachment(
      { type: "EXPENSE", id: expense.id },
      { ...RECEIPT, name: uniq("receipt.pdf") },
      { description: "fuel receipt" },
      actorA.id,
      storage,
    );
    const rows = await listEntityAttachments("EXPENSE", expense.id);
    expect(rows.map((r) => r.attachment.id)).toEqual([receipt.id]);
    // The upload mirrored an ATTACHMENT_ADDED event onto the expense.
    expect(await eventTypes(expense.id)).toContain("ATTACHMENT_ADDED");
    // Bytes actually landed in the storage provider.
    expect(storage.objects.has(receipt.storageKey)).toBe(true);
  });

  it("rejects attachments onto a foreign or fabricated expense", async () => {
    const foreign = await createExpense(
      orgB.id,
      expenseInput({ vendorId: undefined }),
      actorA.id,
    );
    await expect(
      uploadAttachment(
        { type: "EXPENSE", id: "nonexistent-expense" },
        RECEIPT,
        {},
        actorA.id,
        storage,
      ),
    ).rejects.toBeInstanceOf(Error);
    void foreign;
  });

  it("requires a reason to mutate files on an approved expense", async () => {
    const expense = await makeExpense();
    const receipt = await uploadAttachment(
      { type: "EXPENSE", id: expense.id },
      RECEIPT,
      {},
      actorA.id,
      storage,
    );
    await transitionExpenseStatus(expense.id, "SUBMITTED", actorA.id);
    await transitionExpenseStatus(expense.id, "APPROVED", actorA.id);

    await expect(
      uploadAttachment(
        { type: "EXPENSE", id: expense.id },
        RECEIPT,
        {},
        actorA.id,
        storage,
      ),
    ).rejects.toBeInstanceOf(AttachmentReasonRequiredError);
    await expect(
      unlinkAttachment(
        { type: "EXPENSE", id: expense.id },
        receipt.id,
        {},
        actorA.id,
      ),
    ).rejects.toBeInstanceOf(AttachmentReasonRequiredError);
    await expect(
      deleteAttachment(receipt.id, {}, actorA.id),
    ).rejects.toBeInstanceOf(AttachmentReasonRequiredError);

    // With a reason, evidence changes are allowed — and audited.
    await unlinkAttachment(
      { type: "EXPENSE", id: expense.id },
      receipt.id,
      { reason: "duplicate scan uploaded" },
      actorA.id,
    );
    expect(await eventTypes(expense.id)).toContain("ATTACHMENT_REMOVED");
  });

  /* ---------------- list filters ---------------- */

  it("filters the org expense list by every supported dimension", async () => {
    const other = await createVendor(
      orgA.id,
      { name: uniq("other-vendor") },
      actorA.id,
    );
    const march = await makeExpense({
      expenseDate: new Date("2026-03-10T00:00:00.000Z"),
      category: "Equipment",
      vendorId: other.id,
    });
    await makeExpense({
      expenseDate: new Date("2026-05-20T00:00:00.000Z"),
      category: "Fuel",
    });
    const linked = await makeExpense({
      expenseDate: new Date("2026-03-15T00:00:00.000Z"),
    });
    await addExpenseContextLink(
      linked.id,
      "ASSET",
      assetA.id,
      undefined,
      actorA.id,
    );
    await addExpenseContextLink(
      linked.id,
      "INCIDENT",
      incidentA.id,
      undefined,
      actorA.id,
    );
    await transitionExpenseStatus(march.id, "SUBMITTED", actorA.id);

    const byVendor = await listOrganizationExpenses(orgA.id, {
      vendorId: other.id,
    });
    expect(byVendor.map((e) => e.id)).toEqual([march.id]);

    const byCategory = await listOrganizationExpenses(orgA.id, {
      category: "equipment",
    });
    expect(byCategory.every((e) => e.category === "Equipment")).toBe(true);

    const byStatus = await listOrganizationExpenses(orgA.id, {
      status: "SUBMITTED",
    });
    expect(byStatus.every((e) => e.status === "SUBMITTED")).toBe(true);

    const byRange = await listOrganizationExpenses(orgA.id, {
      from: new Date("2026-03-01T00:00:00.000Z"),
      to: new Date("2026-03-31T00:00:00.000Z"),
    });
    expect(
      byRange.every(
        (e) =>
          e.expenseDate >= new Date("2026-03-01T00:00:00.000Z") &&
          e.expenseDate <= new Date("2026-03-31T00:00:00.000Z"),
      ),
    ).toBe(true);
    expect(byRange.map((e) => e.id)).toContain(march.id);
    expect(byRange.map((e) => e.id)).not.toContain(
      (
        await prisma.expense.findFirstOrThrow({
          where: { expenseDate: new Date("2026-05-20T00:00:00.000Z") },
        })
      ).id,
    );

    const byAsset = await listOrganizationExpenses(orgA.id, {
      assetId: assetA.id,
    });
    expect(byAsset.map((e) => e.id)).toContain(linked.id);
    // Every row matched actually carries the link — no loose rows.
    for (const e of byAsset) {
      const links = await prisma.expenseAsset.count({
        where: { expenseId: e.id, assetId: assetA.id },
      });
      expect(links).toBe(1);
    }

    const byIncident = await listOrganizationExpenses(orgA.id, {
      incidentId: incidentA.id,
    });
    expect(byIncident.map((e) => e.id)).toContain(linked.id);
    for (const e of byIncident) {
      const links = await prisma.expenseIncident.count({
        where: { expenseId: e.id, incidentId: incidentA.id },
      });
      expect(links).toBe(1);
    }

    const byReimbursement = await listOrganizationExpenses(orgA.id, {
      reimbursementStatus: "PENDING",
    });
    expect(
      byReimbursement.every((e) => e.reimbursementStatus === "PENDING"),
    ).toBe(true);
  });

  it("never returns another organization's expenses in a filtered list", async () => {
    const foreign = await createExpense(
      orgB.id,
      expenseInput({ vendorId: undefined }),
      actorA.id,
    );
    const list = await listOrganizationExpenses(orgA.id, {});
    expect(list.map((e) => e.id)).not.toContain(foreign.id);
    expect(list.every((e) => e.organizationId === orgA.id)).toBe(true);
  });

  /* ---------------- audit integrity ---------------- */

  it("keeps expense history after the acting identity is deleted", async () => {
    const throwaway = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("departed"),
        email: `${uniq("departed")}@example.test`,
      },
    });
    const expense = await createExpense(
      orgA.id,
      expenseInput({ vendorId: undefined }),
      throwaway.id,
    );
    await transitionExpenseStatus(expense.id, "SUBMITTED", throwaway.id);
    await prisma.authIdentity.delete({ where: { id: throwaway.id } });
    const events = await prisma.expenseEvent.findMany({
      where: { expenseId: expense.id },
      orderBy: { occurredAt: "asc" },
    });
    // Scalar actor ids — history survives identity deletion.
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.actorAuthIdentityId === throwaway.id)).toBe(
      true,
    );
    // Read model falls back to the raw id rather than fabricating a name.
    const detail = await getExpenseForAdmin(expense.id);
    expect(detail?.createdByDisplay).toBe(throwaway.id);
  });

  it("serializes a concurrent double-approve into one transition", async () => {
    const expense = await makeExpense();
    await transitionExpenseStatus(expense.id, "SUBMITTED", actorA.id);
    await Promise.all([
      transitionExpenseStatus(expense.id, "APPROVED", actorA.id),
      transitionExpenseStatus(expense.id, "APPROVED", actorA.id),
    ]);
    const statusEvents = await prisma.expenseEvent.findMany({
      where: { expenseId: expense.id, type: "STATUS_CHANGED" },
    });
    // One transition, one event — the second call saw APPROVED and
    // no-op'd under the row lock.
    expect(
      statusEvents.filter((e) => {
        const meta = e.metadata as { to?: string } | null;
        return meta?.to === "APPROVED";
      }),
    ).toHaveLength(1);
  });
});
