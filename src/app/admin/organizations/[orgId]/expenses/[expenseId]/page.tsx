import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/lib/prisma";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";
import {
  getExpenseForAdmin,
  listOrganizationVendors,
  listOrganizationExpenseCategories,
  EXPENSE_STATUS_LABELS,
  REIMBURSEMENT_STATUS_LABELS,
  EXPENSE_CONTEXT_KIND_LABELS,
} from "@/lib/domain/expenses";
import { formatDateOnly, formatInstantInZone } from "@/lib/dates";
import { formatMoney, amountMinorToDecimal } from "@/lib/money";

import {
  updateExpenseAction,
  transitionExpenseAction,
  rejectExpenseAction,
  setExpenseReimbursementAction,
  addExpenseLinkAction,
  removeExpenseLinkAction,
} from "../../../../actions";
import { AttachmentSection } from "../../../../attachment-section";
import {
  ExpenseFieldsForm,
  ExpenseTransitionButton,
  ExpenseRejectForm,
  ExpenseReimbursementForm,
  ExpenseLinkForm,
  RemoveExpenseLinkButton,
  type ExpenseLinkTarget,
} from "../../../../expense-forms";

export const metadata = { title: "Expense" };

export const dynamic = "force-dynamic";

const statusBadgeClass: Record<string, string> = {
  DRAFT: "bg-amber-100 text-amber-800",
  SUBMITTED: "bg-blue-100 text-blue-800",
  APPROVED: "bg-green-100 text-green-800",
  REJECTED: "bg-neutral-100 text-neutral-600",
};

const reimbursementBadgeClass: Record<string, string> = {
  NOT_REQUIRED: "bg-neutral-100 text-neutral-600",
  PENDING: "bg-amber-100 text-amber-800",
  REIMBURSED: "bg-green-100 text-green-800",
};

export default async function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; expenseId: string }>;
}) {
  const { orgId, expenseId } = await params;

  // Resolve the record first; the organization it carries — never the
  // URL — decides which grant is required. A foreign-org expense id is
  // indistinguishable from a nonexistent one (notFound, not 403).
  const detail = await getExpenseForAdmin(expenseId);
  if (!detail || detail.organizationId !== orgId) notFound();
  await requireOrgAdminOrNotFound(detail.organizationId);

  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId },
  });

  // Selector lists for the correction and link forms. Everything is
  // org-scoped by construction and re-validated inside the transaction.
  const [
    vendors,
    members,
    categories,
    incidents,
    trainings,
    assets,
    maintenance,
    inventory,
  ] = await Promise.all([
    listOrganizationVendors(orgId, { status: "ACTIVE" }),
    prisma.member.findMany({
      where: { organizationId: orgId, status: "ACTIVE" },
      orderBy: { displayName: "asc" },
      select: { id: true, displayName: true },
    }),
    listOrganizationExpenseCategories(orgId),
    prisma.incident.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, reference: true, title: true },
    }),
    prisma.trainingEvent.findMany({
      where: { organizationId: orgId },
      orderBy: { date: "desc" },
      take: 100,
      select: { id: true, title: true, date: true },
    }),
    prisma.asset.findMany({
      where: { organizationId: orgId, status: { not: "RETIRED" } },
      orderBy: { name: "asc" },
      take: 200,
      select: { id: true, name: true },
    }),
    prisma.maintenanceRecord.findMany({
      where: { organizationId: orgId },
      orderBy: { performedOn: "desc" },
      take: 100,
      select: { id: true, title: true },
    }),
    prisma.inventoryItem.findMany({
      where: { organizationId: orgId, status: "ACTIVE" },
      orderBy: { name: "asc" },
      take: 200,
      select: { id: true, name: true },
    }),
  ]);

  // Name lookups so audit diffs show vendor/member names, not ids.
  const vendorNameById = new Map(vendors.map((v) => [v.id, v.name]));
  const memberNameById = new Map(members.map((m) => [m.id, m.displayName]));
  // A change may reference a now-inactive vendor or member — fall back
  // to a second, unfiltered lookup for display only.
  const [allVendors, allMembers] = await Promise.all([
    prisma.vendor.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true },
    }),
    prisma.member.findMany({
      where: { organizationId: orgId },
      select: { id: true, displayName: true },
    }),
  ]);
  for (const v of allVendors) vendorNameById.set(v.id, v.name);
  for (const m of allMembers) memberNameById.set(m.id, m.displayName);

  // The correction form's selects offer ACTIVE vendors/members — but
  // must also carry the record's CURRENT values even when those have
  // since gone inactive, or the form would silently clear them on any
  // unrelated edit. The domain independently allows keeping an
  // already-attached inactive vendor while still rejecting NEW
  // assignments of one.
  const vendorOptions = vendors.map((v) => ({ id: v.id, name: v.name }));
  if (detail.vendor && !vendorOptions.some((v) => v.id === detail.vendor!.id)) {
    vendorOptions.push({
      id: detail.vendor.id,
      name: `${detail.vendor.name} (inactive)`,
    });
  }
  const memberOptions = members.map((m) => ({
    id: m.id,
    displayName: m.displayName,
  }));
  for (const current of [detail.submittedByMember, detail.paidByMember]) {
    if (current && !memberOptions.some((m) => m.id === current.id)) {
      memberOptions.push({
        id: current.id,
        displayName: `${current.displayName} (inactive)`,
      });
    }
  }

  // The linked-target selects. Labels carry each record's natural
  // reference so an operator can tell similar rows apart.
  const linkOptions: ExpenseLinkTarget[] = [
    ...incidents.map((i) => ({
      kind: "INCIDENT",
      id: i.id,
      label: `${i.reference} — ${i.title}`,
    })),
    ...trainings.map((t) => ({
      kind: "TRAINING_EVENT",
      id: t.id,
      label: `${t.title} (${formatDateOnly(t.date)})`,
    })),
    ...assets.map((a) => ({
      kind: "ASSET",
      id: a.id,
      label: a.name,
    })),
    ...maintenance.map((m) => ({
      kind: "MAINTENANCE_RECORD",
      id: m.id,
      label: m.title,
    })),
    ...inventory.map((i) => ({
      kind: "INVENTORY_ITEM",
      id: i.id,
      label: i.name,
    })),
  ];

  // Transitions offered must follow the lifecycle graph — the domain
  // re-validates every edge anyway; this only shapes the UI.
  const transitions: {
    target: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";
    label: string;
  }[] = [];
  if (detail.status === "DRAFT") {
    transitions.push({ target: "SUBMITTED", label: "Submit for review" });
  }
  if (detail.status === "SUBMITTED") {
    transitions.push({ target: "APPROVED", label: "Approve" });
    transitions.push({ target: "DRAFT", label: "Return to draft" });
  }
  if (detail.status === "REJECTED") {
    transitions.push({ target: "DRAFT", label: "Reopen as draft" });
  }

  // Material edits on an approved or already-reimbursed expense must
  // carry a reason — the correction is audited, never silent.
  const correctionRequiresReason =
    detail.status === "APPROVED" || detail.reimbursementStatus === "REIMBURSED";

  // Receipt unlink/delete on an approved or reimbursed record demands a
  // recorded reason — financial evidence never silently disappears.
  const attachmentsRequireReason = correctionRequiresReason;

  // Current context links, flattened from the typed link tables.
  const contextLinks = [
    ...detail.incidentLinks.map((l) => ({
      key: `incident-${l.id}`,
      linkId: l.id,
      kind: "INCIDENT" as const,
      targetId: l.incidentId,
      label: `${l.incident.reference} — ${l.incident.title}`,
      note: l.note,
    })),
    ...detail.trainingLinks.map((l) => ({
      key: `training-${l.id}`,
      linkId: l.id,
      kind: "TRAINING_EVENT" as const,
      targetId: l.trainingEventId,
      label: `${l.trainingEvent.title} (${formatDateOnly(l.trainingEvent.date)})`,
      note: l.note,
    })),
    ...detail.assetLinks.map((l) => ({
      key: `asset-${l.id}`,
      linkId: l.id,
      kind: "ASSET" as const,
      targetId: l.assetId,
      label: l.asset.name,
      note: l.note,
    })),
    ...detail.maintenanceLinks.map((l) => ({
      key: `maintenance-${l.id}`,
      linkId: l.id,
      kind: "MAINTENANCE_RECORD" as const,
      targetId: l.maintenanceRecordId,
      label: l.maintenanceRecord.title,
      note: l.note,
    })),
    ...detail.inventoryLinks.map((l) => ({
      key: `inventory-${l.id}`,
      linkId: l.id,
      kind: "INVENTORY_ITEM" as const,
      targetId: l.inventoryItemId,
      label: l.inventoryItem.name,
      note: l.note,
    })),
  ];

  const existingLinkKeys = new Set(
    contextLinks.map((l) => `${l.kind}:${l.targetId}`),
  );
  const availableLinkOptions = linkOptions.filter(
    (o) => !existingLinkKeys.has(`${o.kind}:${o.id}`),
  );

  // Interleave events and corrections into one audit stream, newest
  // first.
  const auditRows = [
    ...detail.events.map((e) => ({
      id: `event-${e.id}`,
      at: e.occurredAt,
      kind: "event" as const,
      event: e,
    })),
    ...detail.changes.map((c) => ({
      id: `change-${c.id}`,
      at: c.createdAt,
      kind: "change" as const,
      change: c,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  // Render a correction's typed before/after columns as readable diffs.
  type Change = (typeof detail.changes)[number];
  const changeDiffs = (change: Change): string[] => {
    const rows: string[] = [];
    const dash = "—";
    const vendorName = (id: string | null) =>
      id ? (vendorNameById.get(id) ?? "removed vendor") : dash;
    const memberName = (id: string | null) =>
      id ? (memberNameById.get(id) ?? "removed member") : dash;
    if (
      change.beforeExpenseDate.getTime() !== change.afterExpenseDate.getTime()
    ) {
      rows.push(
        `date: ${formatDateOnly(change.beforeExpenseDate)} → ${formatDateOnly(change.afterExpenseDate)}`,
      );
    }
    if (
      change.beforeAmountMinor !== change.afterAmountMinor ||
      change.beforeCurrency !== change.afterCurrency
    ) {
      rows.push(
        `amount: ${formatMoney(change.beforeAmountMinor, change.beforeCurrency)} → ${formatMoney(change.afterAmountMinor, change.afterCurrency)}`,
      );
    }
    if (change.beforeVendorId !== change.afterVendorId) {
      rows.push(
        `vendor: ${vendorName(change.beforeVendorId)} → ${vendorName(change.afterVendorId)}`,
      );
    }
    if (change.beforeCategory !== change.afterCategory) {
      rows.push(
        `category: ${change.beforeCategory ?? dash} → ${change.afterCategory ?? dash}`,
      );
    }
    if (change.beforeDescription !== change.afterDescription) {
      rows.push("description updated");
    }
    if (change.beforeSubmittedByMemberId !== change.afterSubmittedByMemberId) {
      rows.push(
        `submitted by: ${memberName(change.beforeSubmittedByMemberId)} → ${memberName(change.afterSubmittedByMemberId)}`,
      );
    }
    if (change.beforePaidByMemberId !== change.afterPaidByMemberId) {
      rows.push(
        `paid by: ${memberName(change.beforePaidByMemberId)} → ${memberName(change.afterPaidByMemberId)}`,
      );
    }
    return rows;
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <nav aria-label="Breadcrumb" className="text-sm text-neutral-500">
        <Link href="/admin" className="hover:underline">
          Administration
        </Link>
        <span aria-hidden="true"> / </span>
        <Link
          href={`/admin/organizations/${orgId}`}
          className="hover:underline"
        >
          {organization.name}
        </Link>
        <span aria-hidden="true"> / </span>
        <Link
          href={`/admin/organizations/${orgId}/expenses`}
          className="hover:underline"
        >
          Expenses
        </Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page" className="text-neutral-800">
          {detail.reference}
        </span>
      </nav>

      <section aria-labelledby="expense-heading" className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1
            id="expense-heading"
            className="text-2xl font-semibold tracking-tight"
          >
            {detail.reference}
          </h1>
          <span className="flex items-center gap-1.5">
            <span
              className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClass[detail.status]}`}
            >
              {EXPENSE_STATUS_LABELS[detail.status]}
            </span>
            <span
              className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${reimbursementBadgeClass[detail.reimbursementStatus]}`}
            >
              {REIMBURSEMENT_STATUS_LABELS[detail.reimbursementStatus]}
            </span>
          </span>
        </div>

        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium text-neutral-500">Amount</dt>
            <dd className="font-medium text-neutral-900">
              {formatMoney(detail.amountMinor, detail.currency)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-neutral-500">
              Expense date
            </dt>
            <dd>{formatDateOnly(detail.expenseDate)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-neutral-500">Vendor</dt>
            <dd>
              {detail.vendor ? (
                <>
                  {detail.vendor.name}
                  {detail.vendor.status === "INACTIVE" && (
                    <span className="ml-1 text-xs text-neutral-500">
                      (inactive)
                    </span>
                  )}
                </>
              ) : (
                <span className="text-neutral-400">—</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-neutral-500">Category</dt>
            <dd>
              {detail.category ?? <span className="text-neutral-400">—</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-neutral-500">
              Submitted by
            </dt>
            <dd>
              {detail.submittedByMember?.displayName ?? (
                <span className="text-neutral-400">—</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-neutral-500">Paid by</dt>
            <dd>
              {detail.paidByMember ? (
                `${detail.paidByMember.displayName} (personally)`
              ) : (
                <span className="text-neutral-400">Organization</span>
              )}
            </dd>
          </div>
          {detail.description && (
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium text-neutral-500">
                What it was for
              </dt>
              <dd>{detail.description}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs font-medium text-neutral-500">Recorded</dt>
            <dd className="text-neutral-600">
              {formatInstantInZone(detail.createdAt, organization.timezone)}
              {detail.createdByDisplay ? ` by ${detail.createdByDisplay}` : ""}
            </dd>
          </div>
          {detail.submittedAt && (
            <div>
              <dt className="text-xs font-medium text-neutral-500">
                Submitted
              </dt>
              <dd className="text-neutral-600">
                {formatInstantInZone(detail.submittedAt, organization.timezone)}
              </dd>
            </div>
          )}
          {detail.reviewedAt && (
            <div>
              <dt className="text-xs font-medium text-neutral-500">Reviewed</dt>
              <dd className="text-neutral-600">
                {formatInstantInZone(detail.reviewedAt, organization.timezone)}
                {detail.reviewedByDisplay
                  ? ` by ${detail.reviewedByDisplay}`
                  : ""}
                {detail.reviewNote ? ` — ${detail.reviewNote}` : ""}
              </dd>
            </div>
          )}
          {detail.reimbursedAt && (
            <div>
              <dt className="text-xs font-medium text-neutral-500">
                Reimbursed
              </dt>
              <dd className="text-neutral-600">
                {formatInstantInZone(
                  detail.reimbursedAt,
                  organization.timezone,
                )}
                {detail.reimbursedByDisplay
                  ? ` by ${detail.reimbursedByDisplay}`
                  : ""}
                {detail.reimbursementNote
                  ? ` — ${detail.reimbursementNote}`
                  : ""}
              </dd>
            </div>
          )}
        </dl>
      </section>

      {(transitions.length > 0 || detail.status === "SUBMITTED") && (
        <section
          aria-labelledby="review-heading"
          className="mt-8 rounded-md border border-neutral-200 p-4"
        >
          <h2
            id="review-heading"
            className="text-sm font-medium text-neutral-800"
          >
            Review
          </h2>
          <p className="mt-1 text-xs text-neutral-500">
            Approval records a review decision — it is not payment. Rejection
            keeps the record and requires a reason.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {transitions.map((t) => (
              <ExpenseTransitionButton
                key={t.target}
                action={transitionExpenseAction.bind(null, detail.id, t.target)}
                label={t.label}
              />
            ))}
            {detail.status === "SUBMITTED" && (
              <ExpenseRejectForm
                action={rejectExpenseAction.bind(null, detail.id)}
              />
            )}
          </div>
        </section>
      )}

      <section
        aria-labelledby="reimbursement-heading"
        className="mt-8 rounded-md border border-neutral-200 p-4"
      >
        <h2
          id="reimbursement-heading"
          className="text-sm font-medium text-neutral-800"
        >
          Reimbursement
        </h2>
        {detail.paidByMember ? (
          <p className="mt-1 text-xs text-neutral-500">
            {detail.paidByMember.displayName} paid personally. Marking
            reimbursed records the administrative fact that repayment happened —
            SARbase never processes the payment.
          </p>
        ) : (
          <p className="mt-1 text-xs text-neutral-500">
            The organization paid this expense directly. Set a paying member on
            the record if a volunteer actually paid out of pocket and needs
            reimbursing.
          </p>
        )}
        <div className="mt-3">
          <ExpenseReimbursementForm
            action={setExpenseReimbursementAction.bind(null, detail.id)}
            current={detail.reimbursementStatus}
          />
        </div>
      </section>

      <section
        aria-labelledby="links-heading"
        className="mt-8 rounded-md border border-neutral-200 p-4"
      >
        <h2 id="links-heading" className="text-sm font-medium text-neutral-800">
          Related records
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          What this purchase was for — an expense can relate to several
          operational records at once.
        </p>
        {contextLinks.length > 0 && (
          <ul className="mt-3 space-y-1.5 text-sm">
            {contextLinks.map((link) => (
              <li
                key={link.key}
                className="flex items-center justify-between gap-3"
              >
                <span>
                  <span className="mr-2 inline-block rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-medium text-neutral-600">
                    {EXPENSE_CONTEXT_KIND_LABELS[link.kind]}
                  </span>
                  {link.label}
                  {link.note && (
                    <span className="ml-2 text-xs text-neutral-500">
                      — {link.note}
                    </span>
                  )}
                </span>
                <RemoveExpenseLinkButton
                  action={removeExpenseLinkAction.bind(
                    null,
                    link.kind,
                    link.linkId,
                  )}
                />
              </li>
            ))}
          </ul>
        )}
        {availableLinkOptions.length > 0 && (
          <div className="mt-3">
            <ExpenseLinkForm
              action={addExpenseLinkAction.bind(null, detail.id)}
              options={availableLinkOptions}
            />
          </div>
        )}
      </section>

      <AttachmentSection
        entityType="EXPENSE"
        entityId={detail.id}
        organizationId={orgId}
        requireReason={attachmentsRequireReason}
        heading="Receipts and supporting files"
      />

      <section
        aria-labelledby="correct-heading"
        className="mt-10 rounded-md border border-neutral-200 p-4"
      >
        <h2
          id="correct-heading"
          className="text-sm font-medium text-neutral-800"
        >
          {correctionRequiresReason ? "Correct this record" : "Edit expense"}
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          {correctionRequiresReason
            ? "This expense has been approved or reimbursed — corrections need a recorded reason and write a before/after audit entry. Approval and reimbursement state are not reset."
            : "Draft and submitted records can be edited freely; material changes are still audited."}
        </p>
        <div className="mt-3">
          <ExpenseFieldsForm
            action={updateExpenseAction.bind(null, detail.id)}
            defaults={{
              expenseDate: formatDateOnly(detail.expenseDate),
              amount: amountMinorToDecimal(detail.amountMinor, detail.currency),
              currency: detail.currency,
              vendorId: detail.vendorId,
              category: detail.category,
              description: detail.description,
              submittedByMemberId: detail.submittedByMemberId,
              paidByMemberId: detail.paidByMemberId,
            }}
            vendors={vendorOptions}
            members={memberOptions}
            categories={categories}
            requireReason={correctionRequiresReason}
            submitLabel={
              correctionRequiresReason ? "Record correction" : "Save changes"
            }
          />
        </div>
      </section>

      <section aria-labelledby="audit-heading" className="mt-10">
        <h2 id="audit-heading" className="text-sm font-medium text-neutral-800">
          History
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Append-only record of every transition, correction, link, and file
          change. Actors are recorded by identity id so history survives account
          changes.
        </p>
        {auditRows.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">No history yet.</p>
        ) : (
          <ol className="mt-3 space-y-2 border-l-2 border-neutral-200 pl-4">
            {auditRows.map((row) => (
              <li key={row.id} className="text-sm">
                {row.kind === "event" ? (
                  <>
                    <span className="font-medium text-neutral-800">
                      {row.event.text}
                    </span>
                    <span className="block text-xs text-neutral-500">
                      {formatInstantInZone(row.at, organization.timezone)}
                      {row.event.actorDisplay
                        ? ` · ${row.event.actorDisplay}`
                        : ""}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="font-medium text-neutral-800">
                      Correction
                      {row.change.reason ? ` — ${row.change.reason}` : ""}
                    </span>
                    {changeDiffs(row.change).map((diff) => (
                      <span
                        key={diff}
                        className="block text-xs text-neutral-600"
                      >
                        {diff}
                      </span>
                    ))}
                    <span className="block text-xs text-neutral-500">
                      {formatInstantInZone(row.at, organization.timezone)}
                      {row.change.actorDisplay
                        ? ` · ${row.change.actorDisplay}`
                        : ""}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
