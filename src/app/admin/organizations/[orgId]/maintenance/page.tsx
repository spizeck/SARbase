import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrganization } from "@/lib/domain/organization";
import {
  listInspectionDefinitions,
  listDueInspections,
  listDueMaintenance,
  listOpenDefects,
  organizationToday,
  dateDueLabel,
} from "@/lib/domain/maintenance";
import { formatDateOnly } from "@/lib/dates";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";

import {
  createInspectionDefinitionAction,
  updateInspectionDefinitionAction,
  setInspectionDefinitionStatusAction,
} from "../../../actions";
import { InspectionDefinitionForm } from "../../../maintenance-forms";

export const metadata = { title: "Maintenance" };

export const dynamic = "force-dynamic";

const DEFECT_CHIP = "inline-block rounded-full px-2 py-0.5 text-xs font-medium";

/**
 * Organization maintenance overview — factual due/defect state.
 *
 * Everything here is a recorded fact: due dates, day counts, meter
 * thresholds, open defects. Nothing says an asset is safe, unsafe, or
 * deployable — admins read facts and decide. There are no reminder
 * jobs; this page is the deterministic query-derived view that
 * notification delivery (issue #13) will later consume.
 */
export default async function MaintenancePage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  // Untrusted URL selector — grant is checked against the real org.
  await requireOrgAdminOrNotFound(orgId);
  const organization = await getOrganization(orgId);
  if (!organization) notFound();

  const today = await organizationToday(orgId);
  const [definitions, dueInspections, dueMaintenance, openDefects] =
    await Promise.all([
      listInspectionDefinitions(orgId, { includeInactive: true }),
      listDueInspections(orgId, today),
      listDueMaintenance(orgId, today),
      listOpenDefects(orgId),
    ]);

  const inspectionOverdue = dueInspections.filter(
    (e) => e.due.state === "overdue",
  );
  const inspectionUpcoming = dueInspections.filter(
    (e) => e.due.state === "due_today" || e.due.state === "due_soon",
  );
  const maintenanceDue = dueMaintenance.filter(
    (e) =>
      (e.due &&
        (e.due.state === "overdue" ||
          e.due.state === "due_today" ||
          e.due.state === "due_soon")) ||
      (e.kind === "plan" && e.meter?.state === "threshold_reached"),
  );

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
          Maintenance
        </span>
      </nav>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight">
        Maintenance &amp; inspections
      </h1>
      <p className="mt-1 text-sm text-neutral-600">
        Recorded due dates, meter thresholds, and open defects for this
        organization — factual state only, not an operational readiness
        assessment. Dates use the organization&rsquo;s local calendar (today:{" "}
        {formatDateOnly(today)}).
      </p>

      <section aria-labelledby="due-heading" className="mt-8">
        <h2 id="due-heading" className="text-lg font-medium">
          Due and overdue
        </h2>

        {inspectionOverdue.length > 0 && (
          <>
            <h3 className="mt-4 text-sm font-medium text-red-800">
              {inspectionOverdue.length} overdue inspection
              {inspectionOverdue.length === 1 ? "" : "s"}
            </h3>
            <ul className="mt-2 space-y-1 text-sm">
              {inspectionOverdue.map((e) => (
                <li key={`${e.assetId}:${e.definitionId}`}>
                  <Link
                    href={`/admin/assets/${e.assetId}`}
                    className="font-medium text-neutral-800 hover:underline"
                  >
                    {e.assetName}
                  </Link>{" "}
                  — {e.definitionName}: {dateDueLabel(e.nextDueOn, today)}
                </li>
              ))}
            </ul>
          </>
        )}

        {inspectionUpcoming.length > 0 && (
          <>
            <h3 className="mt-4 text-sm font-medium text-neutral-800">
              {inspectionUpcoming.length} upcoming inspection
              {inspectionUpcoming.length === 1 ? "" : "s"}
            </h3>
            <ul className="mt-2 space-y-1 text-sm">
              {inspectionUpcoming.map((e) => (
                <li key={`${e.assetId}:${e.definitionId}`}>
                  <Link
                    href={`/admin/assets/${e.assetId}`}
                    className="font-medium text-neutral-800 hover:underline"
                  >
                    {e.assetName}
                  </Link>{" "}
                  — {e.definitionName}: {dateDueLabel(e.nextDueOn, today)}
                </li>
              ))}
            </ul>
          </>
        )}

        {maintenanceDue.length > 0 && (
          <>
            <h3 className="mt-4 text-sm font-medium text-neutral-800">
              {maintenanceDue.length} maintenance item
              {maintenanceDue.length === 1 ? "" : "s"} due or past due
            </h3>
            <ul className="mt-2 space-y-1 text-sm">
              {maintenanceDue.map((e) => (
                <li key={e.kind === "plan" ? e.planId : e.recordId}>
                  <Link
                    href={`/admin/assets/${e.assetId}`}
                    className="font-medium text-neutral-800 hover:underline"
                  >
                    {e.assetName}
                  </Link>{" "}
                  — {e.kind === "plan" ? e.planName : e.title}:{" "}
                  {e.kind === "plan" && e.meter?.state === "threshold_reached"
                    ? `Threshold ${e.meter.dueReading} ${e.meterUnit} reached — current reading ${e.meter.currentReading}`
                    : e.due
                      ? dateDueLabel(e.nextDueOn, today)
                      : "Due"}
                </li>
              ))}
            </ul>
          </>
        )}

        {inspectionOverdue.length === 0 &&
          inspectionUpcoming.length === 0 &&
          maintenanceDue.length === 0 && (
            <p className="mt-3 text-sm text-neutral-600">
              No due or overdue items recorded.
            </p>
          )}
      </section>

      <section aria-labelledby="defects-heading" className="mt-10">
        <h2 id="defects-heading" className="text-lg font-medium">
          Open defects
        </h2>
        {openDefects.length > 0 ? (
          <>
            <h3 className="mt-4 text-sm font-medium text-amber-800">
              {openDefects.length} open defect
              {openDefects.length === 1 ? "" : "s"}
            </h3>
            <ul className="mt-2 space-y-2">
              {openDefects.map((d) => (
                <li
                  key={d.id}
                  className="rounded-md border border-neutral-200 p-3 text-sm"
                >
                  <Link
                    href={`/admin/assets/${d.asset.id}`}
                    className="font-medium text-neutral-800 hover:underline"
                  >
                    {d.asset.name}
                  </Link>{" "}
                  — {d.title}
                  <span
                    className={`ml-2 ${DEFECT_CHIP} bg-amber-100 text-amber-800`}
                  >
                    Open
                  </span>
                  <div className="mt-1 text-xs text-neutral-500">
                    Reported {formatDateOnly(d.reportedOn)}
                    {(d.reportedByMember?.displayName ?? d.reporterName) &&
                      ` by ${d.reportedByMember?.displayName ?? d.reporterName}`}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-3 text-sm text-neutral-600">
            No open defects recorded.
          </p>
        )}
      </section>

      <section aria-labelledby="definitions-heading" className="mt-10">
        <h2 id="definitions-heading" className="text-lg font-medium">
          Inspection types
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          What this organization tracks — e.g. a monthly vessel visual
          inspection or an annual extinguisher check. Deactivating a type
          preserves its history but stops new records.
        </p>
        {definitions.length > 0 && (
          <ul className="mt-3 space-y-2">
            {definitions.map((def) => (
              <li
                key={def.id}
                className="rounded-md border border-neutral-200 p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <span className="text-sm font-medium text-neutral-900">
                      {def.name}
                    </span>
                    <span className="ml-2 text-xs text-neutral-500">
                      {def._count.records} record
                      {def._count.records === 1 ? "" : "s"}
                      {def.recurrenceType === "CALENDAR_DAYS" &&
                        ` — every ${def.intervalValue} days`}
                      {def.recurrenceType === "CALENDAR_MONTHS" &&
                        ` — every ${def.intervalValue} months`}
                    </span>
                    {def.status === "INACTIVE" && (
                      <span className="ml-2 inline-block rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
                        Inactive
                      </span>
                    )}
                  </div>
                  <form
                    action={setInspectionDefinitionStatusAction.bind(
                      null,
                      def.id,
                      def.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
                    )}
                  >
                    <button
                      type="submit"
                      className="rounded-md border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                    >
                      {def.status === "ACTIVE" ? "Deactivate" : "Reactivate"}
                    </button>
                  </form>
                </div>
                {def.description && (
                  <p className="mt-1 text-sm text-neutral-600">
                    {def.description}
                  </p>
                )}
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-neutral-600 hover:text-neutral-900">
                    Edit
                  </summary>
                  <div className="mt-2">
                    <InspectionDefinitionForm
                      action={updateInspectionDefinitionAction.bind(
                        null,
                        def.id,
                      )}
                      formId={def.id}
                      defaults={{
                        name: def.name,
                        description: def.description,
                        recurrenceType: def.recurrenceType as
                          "NONE" | "CALENDAR_DAYS" | "CALENDAR_MONTHS",
                        intervalValue: def.intervalValue,
                      }}
                      submitLabel="Save changes"
                    />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 rounded-md border border-neutral-200 p-4">
          <h3 className="text-sm font-medium text-neutral-800">
            Add an inspection type
          </h3>
          <div className="mt-2">
            <InspectionDefinitionForm
              action={createInspectionDefinitionAction.bind(null, orgId)}
              formId="new"
              submitLabel="Add inspection type"
            />
          </div>
        </div>
      </section>
    </main>
  );
}
