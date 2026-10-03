import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrganization } from "@/lib/domain/organization";
import { listMembers } from "@/lib/domain/member";
import {
  listQualificationDefinitions,
  listExpiringQualifications,
  expiryLabel,
} from "@/lib/domain/qualification";
import { listTrainingEvents } from "@/lib/domain/training";
import { dateOnlySchema } from "@/lib/domain/schemas";
import {
  listOrganizationAvailability,
  AVAILABILITY_STATUS_LABELS,
} from "@/lib/domain/availability";
import {
  calendarDateInZone,
  formatDateOnly,
  relativeTimeLabel,
} from "@/lib/dates";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";

import {
  updateOrganizationAction,
  createUnitAction,
  updateUnitAction,
  createMemberAction,
  createQualificationDefinitionAction,
  updateQualificationDefinitionAction,
  setQualificationDefinitionStatusAction,
  createTrainingEventAction,
} from "../../actions";
import {
  OrganizationForm,
  UnitCreateForm,
  UnitRenameForm,
  MemberForm,
  QualificationDefinitionForm,
  TrainingEventForm,
} from "../../forms";

export const metadata = { title: "Organization" };

export const dynamic = "force-dynamic";

export default async function OrganizationPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{
    unit?: string;
    expiring?: string;
    trainingUnit?: string;
    trainingFrom?: string;
    trainingTo?: string;
  }>;
}) {
  const { orgId } = await params;
  // orgId from the URL is an untrusted selector: requireOrgAdminOrNotFound
  // checks the caller's OrganizationAccess rows, then resolves the org.
  await requireOrgAdminOrNotFound(orgId);
  const {
    unit: unitFilter,
    expiring,
    trainingUnit,
    trainingFrom,
    trainingTo,
  } = await searchParams;

  // Every filter control on this page rebuilds the URL through this
  // helper so unrelated query parameters (member unit filter, expiry
  // window, training filters) survive each other's changes instead of
  // being clobbered.
  const pageQuery = (overrides: Record<string, string | undefined>) => {
    const merged: Record<string, string | undefined> = {
      unit: unitFilter,
      expiring,
      trainingUnit,
      trainingFrom,
      trainingTo,
      ...overrides,
    };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) {
      if (value) params.set(key, value);
    }
    const qs = params.toString();
    return `/admin/organizations/${orgId}${qs ? `?${qs}` : ""}`;
  };

  const organization = await getOrganization(orgId);
  if (!organization) notFound();

  const filterUnit = unitFilter
    ? organization.units.find((u) => u.id === unitFilter)
    : undefined;
  const members = await listMembers(orgId, {
    unitId: filterUnit?.id,
  });

  const definitions = await listQualificationDefinitions(orgId, {
    includeInactive: true,
  });
  // Factual reporting window only — 30/60/90 is presentation, not policy.
  const expiryWindow = [30, 60, 90].includes(Number(expiring))
    ? Number(expiring)
    : 30;
  // "Today" is the organization's own local calendar date.
  const today = calendarDateInZone(organization.timezone);
  // Current factual availability per member (issue #12) — informational
  // only; the table sorts alphabetically, never by "best" status.
  const availability = await listOrganizationAvailability(orgId, today);
  const expiringRecords = await listExpiringQualifications(orgId, {
    withinDays: expiryWindow,
    today,
    includeExpired: true,
  });

  // Training history filters (issue #9): unit and date range. Values
  // are validated server-side — a unit id that is not one of this
  // organization's units (foreign or fabricated) matches nothing, so
  // filtering can never expose cross-org data; the sentinel "org"
  // selects organization-wide events (unitId IS NULL). Date params
  // must be real YYYY-MM-DD calendar dates; invalid input is ignored
  // rather than widening or narrowing the result silently.
  const trainingUnitId =
    trainingUnit === "org"
      ? null
      : trainingUnit && trainingUnit.trim().length > 0
        ? trainingUnit
        : undefined;
  const parsedFrom = dateOnlySchema.safeParse(trainingFrom);
  const parsedTo = dateOnlySchema.safeParse(trainingTo);
  const trainingFromDate = parsedFrom.success ? parsedFrom.data : undefined;
  const trainingToDate = parsedTo.success ? parsedTo.data : undefined;
  const trainingFiltered = Boolean(
    trainingUnitId !== undefined || trainingFromDate || trainingToDate,
  );

  const trainingEvents = await listTrainingEvents(orgId, {
    includeCancelled: true,
    unitId: trainingUnitId,
    from: trainingFromDate,
    to: trainingToDate,
  });
  const allMembers = await listMembers(orgId);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <nav aria-label="Breadcrumb" className="text-sm text-neutral-500">
        <Link href="/admin" className="hover:underline">
          Administration
        </Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page" className="text-neutral-800">
          {organization.name}
        </span>
      </nav>

      <section aria-labelledby="details-heading" className="mt-6">
        <h1
          id="details-heading"
          className="text-2xl font-semibold tracking-tight"
        >
          {organization.name}
        </h1>
        <div className="mt-4 max-w-sm rounded-md border border-neutral-200 p-4">
          <h2 className="text-sm font-medium text-neutral-800">
            Organization settings
          </h2>
          <div className="mt-2">
            <OrganizationForm
              action={updateOrganizationAction.bind(null, orgId)}
              defaultName={organization.name}
              defaultTimeZone={organization.timezone}
              submitLabel="Save"
            />
          </div>
        </div>
      </section>

      <nav
        aria-label="Assets and inventory"
        className="mt-6 flex flex-wrap gap-2 text-sm"
      >
        <Link
          href={`/admin/organizations/${orgId}/assets`}
          className="rounded-md border border-neutral-300 px-3 py-1.5 font-medium text-neutral-800 hover:bg-neutral-50"
        >
          Assets
        </Link>
        <Link
          href={`/admin/organizations/${orgId}/inventory`}
          className="rounded-md border border-neutral-300 px-3 py-1.5 font-medium text-neutral-800 hover:bg-neutral-50"
        >
          Inventory
        </Link>
        <Link
          href={`/admin/organizations/${orgId}/locations`}
          className="rounded-md border border-neutral-300 px-3 py-1.5 font-medium text-neutral-800 hover:bg-neutral-50"
        >
          Storage locations
        </Link>
        <Link
          href={`/admin/organizations/${orgId}/maintenance`}
          className="rounded-md border border-neutral-300 px-3 py-1.5 font-medium text-neutral-800 hover:bg-neutral-50"
        >
          Maintenance
        </Link>
        <Link
          href={`/admin/organizations/${orgId}/notifications`}
          className="rounded-md border border-neutral-300 px-3 py-1.5 font-medium text-neutral-800 hover:bg-neutral-50"
        >
          Notifications
        </Link>
        <Link
          href={`/admin/organizations/${orgId}/callouts`}
          className="rounded-md border border-neutral-300 px-3 py-1.5 font-medium text-neutral-800 hover:bg-neutral-50"
        >
          Callouts
        </Link>
        <Link
          href={`/admin/organizations/${orgId}/incidents`}
          className="rounded-md border border-neutral-300 px-3 py-1.5 font-medium text-neutral-800 hover:bg-neutral-50"
        >
          Incidents
        </Link>
        <Link
          href={`/admin/organizations/${orgId}/documents`}
          className="rounded-md border border-neutral-300 px-3 py-1.5 font-medium text-neutral-800 hover:bg-neutral-50"
        >
          Documents
        </Link>
        <Link
          href={`/admin/organizations/${orgId}/vendors`}
          className="rounded-md border border-neutral-300 px-3 py-1.5 font-medium text-neutral-800 hover:bg-neutral-50"
        >
          Vendors
        </Link>
        <Link
          href={`/admin/organizations/${orgId}/expenses`}
          className="rounded-md border border-neutral-300 px-3 py-1.5 font-medium text-neutral-800 hover:bg-neutral-50"
        >
          Expenses
        </Link>
      </nav>

      <section aria-labelledby="units-heading" className="mt-10">
        <h2 id="units-heading" className="text-lg font-medium">
          Units
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          Internal groupings such as stations, bases, or teams. Optional — an
          organization may have none.
        </p>
        {organization.units.length > 0 && (
          <ul className="mt-3 space-y-2">
            {organization.units.map((unit) => (
              <li
                key={unit.id}
                className="rounded-md border border-neutral-200 p-3"
              >
                <UnitRenameForm
                  action={updateUnitAction.bind(null, unit.id)}
                  defaultName={unit.name}
                  unitId={unit.id}
                />
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 rounded-md border border-neutral-200 p-4">
          <UnitCreateForm action={createUnitAction.bind(null, orgId)} />
        </div>
      </section>

      <section aria-labelledby="qualifications-heading" className="mt-10">
        <h2 id="qualifications-heading" className="text-lg font-medium">
          Qualifications
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          The qualifications and certifications this organization tracks.
          Deactivating stops new assignments; existing member records are
          preserved.
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
                      {def._count.memberQualifications} record
                      {def._count.memberQualifications === 1 ? "" : "s"}
                    </span>
                    {def.status === "INACTIVE" && (
                      <span className="ml-2 inline-block rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
                        Inactive
                      </span>
                    )}
                  </div>
                  <form
                    action={setQualificationDefinitionStatusAction.bind(
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
                    <QualificationDefinitionForm
                      action={updateQualificationDefinitionAction.bind(
                        null,
                        def.id,
                      )}
                      defaults={{
                        name: def.name,
                        description: def.description,
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
            New qualification
          </h3>
          <div className="mt-2">
            <QualificationDefinitionForm
              action={createQualificationDefinitionAction.bind(null, orgId)}
              submitLabel="Add qualification"
            />
          </div>
        </div>
      </section>

      <section aria-labelledby="expiring-heading" className="mt-10">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="expiring-heading" className="text-lg font-medium">
            Expiring certifications
          </h2>
          <nav aria-label="Expiry window" className="text-sm whitespace-nowrap">
            {[30, 60, 90].map((days) => (
              <Link
                key={days}
                href={pageQuery({ expiring: String(days) })}
                aria-current={expiryWindow === days ? "true" : undefined}
                className={`ml-3 ${
                  expiryWindow === days
                    ? "font-medium text-neutral-900"
                    : "text-neutral-500 hover:underline"
                }`}
              >
                {days}d
              </Link>
            ))}
          </nav>
        </div>
        <p className="mt-1 text-sm text-neutral-600">
          Records expired or expiring within {expiryWindow} days — a factual
          reporting window, not a renewal policy.
        </p>
        {expiringRecords.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            No records expire within {expiryWindow} days.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {expiringRecords.map((record) => (
              <li
                key={record.id}
                className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
              >
                <span>
                  <Link
                    href={`/admin/members/${record.member.id}`}
                    className="font-medium text-neutral-900 hover:underline"
                  >
                    {record.member.displayName}
                  </Link>
                  <span className="text-neutral-600">
                    {" "}
                    — {record.definition.name}
                  </span>
                </span>
                <span className="text-neutral-600">
                  {expiryLabel(record.expiresOn, today, expiryWindow)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="training-heading" className="mt-10">
        <h2 id="training-heading" className="text-lg font-medium">
          Training
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          Training events and attendance history. Cancelled events are kept for
          the record but do not count as attended.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <nav
            aria-label="Filter training by unit"
            className="text-sm whitespace-nowrap"
          >
            <Link
              href={pageQuery({ trainingUnit: undefined })}
              aria-current={!trainingUnit ? "true" : undefined}
              className={
                !trainingUnit
                  ? "font-medium text-neutral-900"
                  : "text-neutral-500 hover:underline"
              }
            >
              All units
            </Link>
            <Link
              href={pageQuery({ trainingUnit: "org" })}
              aria-current={trainingUnit === "org" ? "true" : undefined}
              className={`ml-3 ${
                trainingUnit === "org"
                  ? "font-medium text-neutral-900"
                  : "text-neutral-500 hover:underline"
              }`}
            >
              Organization-wide
            </Link>
            {organization.units.map((unit) => (
              <Link
                key={unit.id}
                href={pageQuery({ trainingUnit: unit.id })}
                aria-current={trainingUnit === unit.id ? "true" : undefined}
                className={`ml-3 ${
                  trainingUnit === unit.id
                    ? "font-medium text-neutral-900"
                    : "text-neutral-500 hover:underline"
                }`}
              >
                {unit.name}
              </Link>
            ))}
          </nav>

          <form
            method="get"
            action={`/admin/organizations/${orgId}`}
            className="flex flex-wrap items-end gap-3"
          >
            {unitFilter && (
              <input type="hidden" name="unit" value={unitFilter} />
            )}
            {expiring && (
              <input type="hidden" name="expiring" value={expiring} />
            )}
            {trainingUnit && (
              <input type="hidden" name="trainingUnit" value={trainingUnit} />
            )}
            <div>
              <label
                htmlFor="training-from"
                className="block text-xs font-medium text-neutral-700"
              >
                From
              </label>
              <input
                id="training-from"
                name="trainingFrom"
                type="date"
                defaultValue={
                  trainingFromDate ? formatDateOnly(trainingFromDate)! : ""
                }
                className="mt-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label
                htmlFor="training-to"
                className="block text-xs font-medium text-neutral-700"
              >
                To
              </label>
              <input
                id="training-to"
                name="trainingTo"
                type="date"
                defaultValue={
                  trainingToDate ? formatDateOnly(trainingToDate)! : ""
                }
                className="mt-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
              />
            </div>
            <button
              type="submit"
              className="rounded-md border border-neutral-300 px-3 py-1 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Filter
            </button>
            {(trainingFrom || trainingTo) && (
              <Link
                href={pageQuery({
                  trainingFrom: undefined,
                  trainingTo: undefined,
                })}
                className="text-sm text-neutral-500 hover:underline"
              >
                Clear dates
              </Link>
            )}
          </form>
        </div>

        {trainingEvents.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            {trainingFiltered
              ? "No training events match the selected filters."
              : "No training events recorded yet."}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {trainingEvents.map((event) => (
              <li
                key={event.id}
                className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
              >
                <span>
                  <Link
                    href={`/admin/training/${event.id}`}
                    className="font-medium text-neutral-900 hover:underline"
                  >
                    {event.title}
                  </Link>
                  <span className="text-neutral-500">
                    {event.unit ? ` · ${event.unit.name}` : ""}
                  </span>
                </span>
                <span className="flex items-center gap-3 text-neutral-600">
                  <span>
                    {event._count.attendances} attendee
                    {event._count.attendances === 1 ? "" : "s"}
                  </span>
                  <span>{formatDateOnly(event.date)}</span>
                  {event.status === "CANCELLED" && (
                    <span className="inline-block rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
                      Cancelled
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <details className="mt-3 rounded-md border border-neutral-200 p-4">
          <summary className="cursor-pointer text-sm font-medium text-neutral-800">
            Record a training event
          </summary>
          <div className="mt-3">
            <TrainingEventForm
              action={createTrainingEventAction.bind(null, orgId)}
              units={organization.units}
              members={allMembers.map((m) => ({
                id: m.id,
                displayName: m.displayName,
              }))}
              submitLabel="Save event"
            />
          </div>
        </details>
      </section>

      <section aria-labelledby="members-heading" className="mt-10">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="members-heading" className="text-lg font-medium">
            Members
          </h2>
          {organization.units.length > 0 && (
            <nav aria-label="Filter members by unit" className="text-sm">
              <Link
                href={pageQuery({ unit: undefined })}
                aria-current={!filterUnit ? "true" : undefined}
                className={
                  filterUnit
                    ? "text-neutral-500 hover:underline"
                    : "font-medium text-neutral-900"
                }
              >
                All
              </Link>
              {organization.units.map((unit) => (
                <Link
                  key={unit.id}
                  href={pageQuery({ unit: unit.id })}
                  aria-current={filterUnit?.id === unit.id ? "true" : undefined}
                  className={`ml-3 ${
                    filterUnit?.id === unit.id
                      ? "font-medium text-neutral-900"
                      : "text-neutral-500 hover:underline"
                  }`}
                >
                  {unit.name}
                </Link>
              ))}
            </nav>
          )}
        </div>

        {members.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            {filterUnit
              ? `No members in ${filterUnit.name}.`
              : "No members yet."}
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-md border border-neutral-200">
            <table className="min-w-full divide-y divide-neutral-200 text-sm">
              <thead className="bg-neutral-50">
                <tr>
                  <th
                    scope="col"
                    className="px-4 py-2 text-left font-medium text-neutral-700"
                  >
                    Name
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2 text-left font-medium text-neutral-700"
                  >
                    Units
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2 text-left font-medium text-neutral-700"
                  >
                    Status
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2 text-left font-medium text-neutral-700"
                  >
                    Availability
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200">
                {members.map((member) => {
                  const memberAvailability = availability.get(member.id);
                  return (
                    <tr key={member.id}>
                      <td className="px-4 py-2">
                        <Link
                          href={`/admin/members/${member.id}`}
                          className="font-medium text-neutral-900 hover:underline"
                        >
                          {member.displayName}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-neutral-600">
                        {member.memberUnits
                          .map((mu) => mu.unit.name)
                          .join(", ") || "—"}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                            member.status === "ACTIVE"
                              ? "bg-green-100 text-green-800"
                              : "bg-neutral-100 text-neutral-600"
                          }`}
                        >
                          {member.status === "ACTIVE" ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-neutral-600">
                        {
                          AVAILABILITY_STATUS_LABELS[
                            memberAvailability?.status ?? "UNKNOWN"
                          ]
                        }
                        {memberAvailability?.latest?.until &&
                          !memberAvailability.expired &&
                          memberAvailability.status !== "UNKNOWN" && (
                            <span className="text-neutral-500">
                              {" "}
                              until{" "}
                              {formatDateOnly(memberAvailability.latest.until)}
                            </span>
                          )}
                        {memberAvailability?.latest && (
                          <span className="block text-xs text-neutral-400">
                            {memberAvailability.expired ? "expired — " : ""}
                            updated{" "}
                            {relativeTimeLabel(
                              memberAvailability.latest.createdAt,
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 rounded-md border border-neutral-200 p-4">
          <h3 className="text-sm font-medium text-neutral-800">New member</h3>
          <div className="mt-2">
            <MemberForm
              action={createMemberAction.bind(null, orgId)}
              submitLabel="Add member"
            />
          </div>
        </div>
      </section>
    </main>
  );
}
