import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";
import { dateOnlySchema } from "@/lib/domain/schemas";
import {
  listOrganizationExpenses,
  listOrganizationExpenseCategories,
  listOrganizationVendors,
  EXPENSE_STATUS_LABELS,
  REIMBURSEMENT_STATUS_LABELS,
  type ExpenseFilters,
} from "@/lib/domain/expenses";
import { formatDateOnly } from "@/lib/dates";
import { formatMoney } from "@/lib/money";

import { createExpenseAction } from "../../../actions";
import { ExpenseFieldsForm } from "../../../expense-forms";

export const metadata = { title: "Expenses" };

export const dynamic = "force-dynamic";

const statusBadgeClass: Record<string, string> = {
  DRAFT: "bg-amber-100 text-amber-800",
  SUBMITTED: "bg-blue-100 text-blue-800",
  APPROVED: "bg-green-100 text-green-800",
  REJECTED: "bg-neutral-100 text-neutral-600",
};

const reimbursementBadgeClass: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800",
  REIMBURSED: "bg-green-100 text-green-800",
};

const EXPENSE_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
] as const;
const REIMBURSEMENT_STATUSES = [
  "NOT_REQUIRED",
  "PENDING",
  "REIMBURSED",
] as const;

export default async function OrganizationExpensesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{
    vendor?: string;
    from?: string;
    to?: string;
    category?: string;
    status?: string;
    reimbursement?: string;
    asset?: string;
    incident?: string;
  }>;
}) {
  const { orgId } = await params;
  // orgId from the URL is an untrusted selector — the grant comes from
  // the caller's OrganizationAccess rows. Financial records are
  // sensitive; the entire surface is ADMIN-only by design.
  await requireOrgAdminOrNotFound(orgId);

  const {
    vendor: vendorFilter,
    from,
    to,
    category,
    status,
    reimbursement,
    asset,
    incident,
  } = await searchParams;

  // Every filter control rebuilds the URL through this helper so
  // unrelated query parameters survive each other's changes.
  const pageQuery = (overrides: Record<string, string | undefined>) => {
    const merged: Record<string, string | undefined> = {
      vendor: vendorFilter,
      from,
      to,
      category,
      status,
      reimbursement,
      asset,
      incident,
      ...overrides,
    };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) {
      if (value) params.set(key, value);
    }
    const qs = params.toString();
    return `/admin/organizations/${orgId}/expenses${qs ? `?${qs}` : ""}`;
  };

  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId },
  });

  // Filter selectors are validated server-side. A vendor id outside
  // this organization can never match (expenses are org-scoped); an
  // invalid date or enum is ignored rather than silently narrowing the
  // result. Date filters compare the org-local calendar-date column.
  const parsedFrom = dateOnlySchema.safeParse(from);
  const parsedTo = dateOnlySchema.safeParse(to);
  const filters: ExpenseFilters = {
    vendorId: vendorFilter || undefined,
    from: parsedFrom.success ? parsedFrom.data : undefined,
    to: parsedTo.success ? parsedTo.data : undefined,
    category: category || undefined,
    status: EXPENSE_STATUSES.includes(status as never)
      ? (status as ExpenseFilters["status"])
      : undefined,
    reimbursementStatus: REIMBURSEMENT_STATUSES.includes(reimbursement as never)
      ? (reimbursement as ExpenseFilters["reimbursementStatus"])
      : undefined,
    assetId: asset || undefined,
    incidentId: incident || undefined,
  };
  const filtered = Boolean(
    filters.vendorId ||
    filters.from ||
    filters.to ||
    filters.category ||
    filters.status ||
    filters.reimbursementStatus ||
    filters.assetId ||
    filters.incidentId,
  );

  const [expenses, vendors, members, categories] = await Promise.all([
    listOrganizationExpenses(orgId, filters),
    listOrganizationVendors(orgId, { status: "ACTIVE" }),
    prisma.member.findMany({
      where: { organizationId: orgId, status: "ACTIVE" },
      orderBy: { displayName: "asc" },
      select: { id: true, displayName: true },
    }),
    listOrganizationExpenseCategories(orgId),
  ]);

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
        <span aria-current="page" className="text-neutral-800">
          Expenses
        </span>
      </nav>

      <section aria-labelledby="expenses-heading" className="mt-6">
        <h1
          id="expenses-heading"
          className="text-2xl font-semibold tracking-tight"
        >
          Expenses
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          What was bought, for how much, from whom, for what — and whether a
          volunteer who paid out of pocket has been reimbursed. SARbase records
          financial facts; it is not accounting software and records no
          payments.
        </p>
      </section>

      <form
        method="get"
        action={`/admin/organizations/${orgId}/expenses`}
        className="mt-4 flex flex-wrap items-end gap-3 rounded-md border border-neutral-200 p-3"
        aria-label="Filter expenses"
      >
        <div>
          <label
            htmlFor="filter-vendor"
            className="block text-xs font-medium text-neutral-700"
          >
            Vendor
          </label>
          <select
            id="filter-vendor"
            name="vendor"
            defaultValue={vendorFilter ?? ""}
            className="mt-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
          >
            <option value="">All vendors</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="filter-from"
            className="block text-xs font-medium text-neutral-700"
          >
            From
          </label>
          <input
            id="filter-from"
            name="from"
            type="date"
            defaultValue={from ?? ""}
            className="mt-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label
            htmlFor="filter-to"
            className="block text-xs font-medium text-neutral-700"
          >
            To
          </label>
          <input
            id="filter-to"
            name="to"
            type="date"
            defaultValue={to ?? ""}
            className="mt-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label
            htmlFor="filter-category"
            className="block text-xs font-medium text-neutral-700"
          >
            Category
          </label>
          <input
            id="filter-category"
            name="category"
            type="text"
            maxLength={60}
            defaultValue={category ?? ""}
            list="expense-filter-categories"
            className="mt-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
          />
          <datalist id="expense-filter-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <div>
          <label
            htmlFor="filter-status"
            className="block text-xs font-medium text-neutral-700"
          >
            Status
          </label>
          <select
            id="filter-status"
            name="status"
            defaultValue={status ?? ""}
            className="mt-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
          >
            <option value="">All</option>
            {EXPENSE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {EXPENSE_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="filter-reimbursement"
            className="block text-xs font-medium text-neutral-700"
          >
            Reimbursement
          </label>
          <select
            id="filter-reimbursement"
            name="reimbursement"
            defaultValue={reimbursement ?? ""}
            className="mt-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
          >
            <option value="">All</option>
            {REIMBURSEMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {REIMBURSEMENT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        {(asset || incident) && (
          <>
            {asset && <input type="hidden" name="asset" value={asset} />}
            {incident && (
              <input type="hidden" name="incident" value={incident} />
            )}
          </>
        )}
        <button
          type="submit"
          className="rounded-md border border-neutral-300 px-3 py-1 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          Filter
        </button>
        {filtered && (
          <Link
            href={`/admin/organizations/${orgId}/expenses`}
            className="text-sm text-neutral-500 hover:underline"
          >
            Clear
          </Link>
        )}
      </form>
      {(asset || incident) && (
        <p className="mt-2 text-xs text-neutral-500">
          Showing expenses linked to a specific {asset ? "asset" : "incident"} —{" "}
          <Link
            href={pageQuery({ asset: undefined, incident: undefined })}
            className="underline"
          >
            clear record filter
          </Link>
        </p>
      )}

      {expenses.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">
          {filtered
            ? "No expenses match the selected filters."
            : "No expenses recorded yet."}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-neutral-200 rounded-md border border-neutral-200">
          {expenses.map((expense) => {
            const linkCount =
              expense._count.incidentLinks +
              expense._count.trainingLinks +
              expense._count.assetLinks +
              expense._count.maintenanceLinks +
              expense._count.inventoryLinks;
            return (
              <li key={expense.id} className="px-4 py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <Link
                    href={`/admin/organizations/${orgId}/expenses/${expense.id}`}
                    className="font-medium text-neutral-900 hover:underline"
                  >
                    <span className="mr-2 font-mono text-xs text-neutral-500">
                      {expense.reference}
                    </span>
                    {formatMoney(expense.amountMinor, expense.currency)}
                    {expense.vendor ? ` · ${expense.vendor.name}` : ""}
                    {expense.category ? ` · ${expense.category}` : ""}
                  </Link>
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClass[expense.status] ?? "bg-neutral-100 text-neutral-600"}`}
                    >
                      {EXPENSE_STATUS_LABELS[expense.status]}
                    </span>
                    {expense.reimbursementStatus !== "NOT_REQUIRED" && (
                      <span
                        className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${reimbursementBadgeClass[expense.reimbursementStatus] ?? "bg-neutral-100 text-neutral-600"}`}
                      >
                        {REIMBURSEMENT_STATUS_LABELS[
                          expense.reimbursementStatus
                        ] ?? expense.reimbursementStatus}
                      </span>
                    )}
                  </span>
                </div>
                <p className="mt-1 text-xs text-neutral-500">
                  {formatDateOnly(expense.expenseDate)}
                  {expense.paidByMember
                    ? ` · paid personally by ${expense.paidByMember.displayName}`
                    : ""}
                  {` · ${expense._count.attachments} file${expense._count.attachments === 1 ? "" : "s"}`}
                  {linkCount > 0
                    ? ` · linked to ${linkCount} record${linkCount === 1 ? "" : "s"}`
                    : ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      <section
        aria-labelledby="create-expense-heading"
        className="mt-10 rounded-md border border-neutral-200 p-4"
      >
        <h2
          id="create-expense-heading"
          className="text-sm font-medium text-neutral-800"
        >
          New expense
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Created as a draft — submit it for review from the expense record.
          Amounts are stored exactly as minor units (42.15 → 4215); every
          expense has one currency, never converted.
        </p>
        <div className="mt-3">
          <ExpenseFieldsForm
            action={createExpenseAction.bind(null, orgId)}
            vendors={vendors}
            members={members}
            categories={categories}
            includeReimbursement
            submitLabel="Create expense"
          />
        </div>
      </section>
    </main>
  );
}
