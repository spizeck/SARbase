import Link from "next/link";
import { notFound } from "next/navigation";

import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";
import { calendarDateInZone } from "@/lib/dates";
import { getOrganization } from "@/lib/domain/organization";
import {
  listOrganizationExpenseCategories,
  listOrganizationVendors,
} from "@/lib/domain/expenses";
import { EXPORT_DATASETS, type DatasetDef } from "@/lib/exports/datasets";
import { formatMoney } from "@/lib/money";
import {
  getAnnualSummary,
  participantHoursLabel,
} from "@/lib/reporting/summary";

export const metadata = { title: "Reports" };

export const dynamic = "force-dynamic";

const inputClass =
  "mt-1 rounded-md border border-neutral-300 px-2 py-1 text-sm";
const labelClass = "block text-xs font-medium text-neutral-700";
const buttonClass =
  "rounded-md border border-neutral-300 px-3 py-1 text-sm font-medium text-neutral-700 hover:bg-neutral-50";

function minutesLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <tr>
      <th
        scope="row"
        className="py-1.5 pr-4 text-left text-sm font-normal text-neutral-600"
      >
        {label}
      </th>
      <td className="py-1.5 text-right text-sm font-medium text-neutral-900">
        {value}
      </td>
    </tr>
  );
}

function ExportRow({
  orgId,
  dataset,
  units,
  vendors,
  categories,
}: {
  orgId: string;
  dataset: DatasetDef;
  units: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
  categories: string[];
}) {
  const url = `/api/organizations/${orgId}/exports/${dataset.key}`;
  const f = dataset.filters;
  const hasFilters = f.size > 0;
  if (!hasFilters) {
    return (
      <li className="flex items-center justify-between gap-3 px-4 py-2">
        <div>
          <span className="text-sm font-medium text-neutral-900">
            {dataset.label}
          </span>
          <span className="text-sm text-neutral-600">
            {" "}
            — {dataset.description}
          </span>
        </div>
        <a href={url} download className={buttonClass}>
          CSV
        </a>
      </li>
    );
  }
  return (
    <li className="px-4 py-2">
      <form
        method="get"
        action={url}
        className="flex flex-wrap items-end gap-x-4 gap-y-2"
      >
        <div className="min-w-40">
          <span className="text-sm font-medium text-neutral-900">
            {dataset.label}
          </span>
          <p className="text-xs text-neutral-600">{dataset.description}</p>
        </div>
        {f.has("date") && (
          <>
            <div>
              <label htmlFor={`${dataset.key}-from`} className={labelClass}>
                From
              </label>
              <input
                id={`${dataset.key}-from`}
                name="from"
                type="date"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor={`${dataset.key}-to`} className={labelClass}>
                To
              </label>
              <input
                id={`${dataset.key}-to`}
                name="to"
                type="date"
                className={inputClass}
              />
            </div>
          </>
        )}
        {f.has("unit") && units.length > 0 && (
          <div>
            <label htmlFor={`${dataset.key}-unit`} className={labelClass}>
              Unit
            </label>
            <select
              id={`${dataset.key}-unit`}
              name="unit"
              defaultValue=""
              className={inputClass}
            >
              <option value="">All</option>
              <option value="org">Organization-wide</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {f.has("vendor") && (
          <div>
            <label htmlFor={`${dataset.key}-vendor`} className={labelClass}>
              Vendor
            </label>
            <select
              id={`${dataset.key}-vendor`}
              name="vendor"
              defaultValue=""
              className={inputClass}
            >
              <option value="">All</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {f.has("status") && (
          <div>
            <label htmlFor={`${dataset.key}-status`} className={labelClass}>
              Status
            </label>
            <select
              id={`${dataset.key}-status`}
              name="status"
              defaultValue=""
              className={inputClass}
            >
              <option value="">All</option>
              {["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"].map((s) => (
                <option key={s} value={s}>
                  {s.toLowerCase()}
                </option>
              ))}
            </select>
          </div>
        )}
        {f.has("reimbursementStatus") && (
          <div>
            <label htmlFor={`${dataset.key}-reimb`} className={labelClass}>
              Reimbursement
            </label>
            <select
              id={`${dataset.key}-reimb`}
              name="reimbursementStatus"
              defaultValue=""
              className={inputClass}
            >
              <option value="">All</option>
              {["NOT_REQUIRED", "PENDING", "REIMBURSED"].map((s) => (
                <option key={s} value={s}>
                  {s.toLowerCase().replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
        )}
        {f.has("currency") && (
          <div>
            <label htmlFor={`${dataset.key}-currency`} className={labelClass}>
              Currency
            </label>
            <input
              id={`${dataset.key}-currency`}
              name="currency"
              type="text"
              maxLength={3}
              placeholder="USD"
              className={`${inputClass} w-16 uppercase`}
            />
          </div>
        )}
        {f.has("category") && (
          <div>
            <label htmlFor={`${dataset.key}-category`} className={labelClass}>
              Category
            </label>
            <input
              id={`${dataset.key}-category`}
              name="category"
              type="text"
              list={`${dataset.key}-categories`}
              className={inputClass}
            />
            <datalist id={`${dataset.key}-categories`}>
              {categories.map((cat) => (
                <option key={cat} value={cat} />
              ))}
            </datalist>
          </div>
        )}
        <button type="submit" className={buttonClass}>
          Download CSV
        </button>
      </form>
    </li>
  );
}

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ year?: string; unit?: string }>;
}) {
  const { orgId } = await params;
  await requireOrgAdminOrNotFound(orgId);
  const { year: yearParam, unit: unitParam } = await searchParams;

  const organization = await getOrganization(orgId);
  if (!organization) notFound();

  // The summary year means the organization's LOCAL calendar year.
  const currentYear = calendarDateInZone(
    organization.timezone,
  ).getUTCFullYear();
  const parsed = Number.parseInt(yearParam ?? "", 10);
  const year =
    Number.isInteger(parsed) && parsed >= 1900 && parsed <= 2100
      ? parsed
      : currentYear;

  const summary = await getAnnualSummary(orgId, year, unitParam || null);
  if (!summary) notFound();

  const vendors = await listOrganizationVendors(orgId);
  const categories = await listOrganizationExpenseCategories(orgId);

  const groups = new Map<string, DatasetDef[]>();
  for (const d of EXPORT_DATASETS) {
    const list = groups.get(d.group) ?? [];
    list.push(d);
    groups.set(d.group, list);
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
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
          Reports
        </span>
      </nav>

      <section aria-labelledby="summary-heading" className="mt-6">
        <h1
          id="summary-heading"
          className="text-2xl font-semibold tracking-tight"
        >
          Annual activity summary
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Factual counts and totals recorded in {year} — the organization&apos;s
          local calendar year ({organization.timezone}). Descriptive only:
          SARbase does not score, rank, or evaluate.
        </p>

        <form
          method="get"
          action={`/admin/organizations/${orgId}/reports`}
          className="mt-4 flex flex-wrap items-end gap-3"
        >
          <div>
            <label htmlFor="year" className={labelClass}>
              Year
            </label>
            <input
              id="year"
              name="year"
              type="number"
              min={1900}
              max={2100}
              defaultValue={year}
              className={`${inputClass} w-24`}
            />
          </div>
          {organization.units.length > 0 && (
            <div>
              <label htmlFor="unit" className={labelClass}>
                Unit (training only)
              </label>
              <select
                id="unit"
                name="unit"
                defaultValue={unitParam ?? ""}
                className={inputClass}
              >
                <option value="">All</option>
                {organization.units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button type="submit" className={buttonClass}>
            Apply
          </button>
        </form>
        {summary.unitFilterUnmatched && (
          <p className="mt-2 text-sm text-neutral-500">
            The selected unit no longer exists — the training section shows no
            rows.
          </p>
        )}
        {summary.unitName && (
          <p className="mt-2 text-sm text-neutral-500">
            Training figures are scoped to unit “{summary.unitName}”; all other
            sections remain organization-wide.
          </p>
        )}
      </section>

      <section aria-labelledby="training-heading" className="mt-8">
        <h2 id="training-heading" className="text-lg font-medium">
          Training
        </h2>
        <table className="mt-2 w-full">
          <tbody>
            <Stat
              label="Completed training events"
              value={summary.training.completedEvents}
            />
            <Stat
              label="Cancelled training events (not counted as attended)"
              value={summary.training.cancelledEvents}
            />
            <Stat
              label="Recorded event duration"
              value={minutesLabel(summary.training.totalEventMinutes)}
            />
            <Stat
              label="Recorded attendances"
              value={summary.training.recordedAttendances}
            />
            <Stat
              label="Recorded training participant-hours"
              value={`${participantHoursLabel(
                summary.training.participantMinutes,
              )} h (${summary.training.participantMinutes} participant-minutes)`}
            />
          </tbody>
        </table>
        {summary.training.eventsWithoutDuration > 0 && (
          <p className="mt-1 text-xs text-neutral-500">
            {summary.training.eventsWithoutDuration} completed event
            {summary.training.eventsWithoutDuration === 1 ? "" : "s"} recorded
            no duration and contribute no participant-hours.
          </p>
        )}
      </section>

      <section aria-labelledby="incidents-heading" className="mt-8">
        <h2 id="incidents-heading" className="text-lg font-medium">
          Incidents
        </h2>
        <table className="mt-2 w-full">
          <tbody>
            <Stat
              label="Incident records created"
              value={summary.incidents.total}
            />
            {summary.incidents.byStatus.map((s) => (
              <Stat
                key={s.status}
                label={`Status: ${s.status.toLowerCase()}`}
                value={s.count}
              />
            ))}
            <Stat
              label="Recorded participant entries"
              value={summary.incidents.participantRecords}
            />
            <Stat
              label="Recorded asset entries"
              value={summary.incidents.assetRecords}
            />
          </tbody>
        </table>
      </section>

      <section aria-labelledby="maintenance-heading" className="mt-8">
        <h2 id="maintenance-heading" className="text-lg font-medium">
          Maintenance
        </h2>
        <table className="mt-2 w-full">
          <tbody>
            <Stat
              label="Maintenance records performed"
              value={summary.maintenance.maintenanceRecords}
            />
            <Stat
              label="Inspection records performed"
              value={summary.maintenance.inspectionRecords}
            />
            <Stat
              label="Defects reported"
              value={summary.maintenance.defectsReported}
            />
            <Stat
              label="Defects resolved"
              value={summary.maintenance.defectsResolved}
            />
          </tbody>
        </table>
        {summary.maintenance.byAsset.length > 0 && (
          <table className="mt-3 w-full">
            <tbody>
              {summary.maintenance.byAsset.map((a) => (
                <Stat
                  key={a.assetId}
                  label={`Records on ${a.assetName}`}
                  value={a.count}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="expenses-heading" className="mt-8">
        <h2 id="expenses-heading" className="text-lg font-medium">
          Expenses
        </h2>
        <table className="mt-2 w-full">
          <tbody>
            <Stat label="Expenses recorded" value={summary.expenses.total} />
            {summary.expenses.byStatus.map((s) => (
              <Stat
                key={s.status}
                label={`Status: ${s.status.toLowerCase()}`}
                value={s.count}
              />
            ))}
            {summary.expenses.byReimbursement.map((s) => (
              <Stat
                key={s.status}
                label={`Reimbursement: ${s.status
                  .toLowerCase()
                  .replace(/_/g, " ")}`}
                value={s.count}
              />
            ))}
          </tbody>
        </table>
        {summary.expenses.approvedTotalsByCurrency.length > 0 && (
          <>
            <h3 className="mt-3 text-sm font-medium text-neutral-800">
              Approved expenses by currency
            </h3>
            <table className="mt-1 w-full">
              <tbody>
                {summary.expenses.approvedTotalsByCurrency.map((r) => (
                  <Stat
                    key={r.currency}
                    label={`${r.currency} (${r.count} expense${
                      r.count === 1 ? "" : "s"
                    })`}
                    value={formatMoney(r.amountMinor, r.currency)}
                  />
                ))}
              </tbody>
            </table>
          </>
        )}
        {summary.expenses.categoryTotalsByCurrency.length > 0 && (
          <>
            <h3 className="mt-3 text-sm font-medium text-neutral-800">
              Recorded expenses by category and currency (all statuses)
            </h3>
            <table className="mt-1 w-full">
              <tbody>
                {summary.expenses.categoryTotalsByCurrency.map((r) => (
                  <Stat
                    key={`${r.category}-${r.currency}`}
                    label={`${r.category ?? "Uncategorized"} (${r.currency})`}
                    value={formatMoney(r.amountMinor, r.currency)}
                  />
                ))}
              </tbody>
            </table>
          </>
        )}
        <p className="mt-2 text-xs text-neutral-500">
          Totals are exact minor-unit sums per currency and are never combined
          across currencies.
        </p>
      </section>

      <section aria-labelledby="exports-heading" className="mt-10">
        <h2 id="exports-heading" className="text-lg font-medium">
          Data exports
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          CSV downloads of the organization&apos;s structured records. Stable
          ids in every file let exported datasets be re-joined — see{" "}
          <span className="font-mono text-xs">docs/reporting.md</span>. Every
          export is audited.
        </p>
        {[...groups.entries()].map(([group, datasets]) => (
          <section key={group} aria-label={group} className="mt-6">
            <h3 className="text-sm font-medium text-neutral-800">{group}</h3>
            <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200">
              {datasets.map((d) => (
                <ExportRow
                  key={d.key}
                  orgId={orgId}
                  dataset={d}
                  units={organization.units}
                  vendors={vendors}
                  categories={categories}
                />
              ))}
            </ul>
          </section>
        ))}
      </section>
    </main>
  );
}
