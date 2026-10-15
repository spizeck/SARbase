import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrganization } from "@/lib/domain/organization";
import { listMembers } from "@/lib/domain/member";
import { listTrainingEvents } from "@/lib/domain/training";
import { dateOnlySchema } from "@/lib/domain/schemas";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";
import { formatDateOnly } from "@/lib/dates";

import { createTrainingEventAction } from "../../../actions";
import { TrainingEventForm } from "../../../forms";

export const metadata = { title: "Training" };

export const dynamic = "force-dynamic";

export default async function TrainingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{
    unit?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const { orgId } = await params;
  await requireOrgAdminOrNotFound(orgId);
  const {
    unit: trainingUnit,
    from: trainingFrom,
    to: trainingTo,
  } = await searchParams;
  const organization = await getOrganization(orgId);
  if (!organization) notFound();

  // Filter values are untrusted selectors — validated server-side. A
  // unit id that is not one of this organization's units (foreign or
  // fabricated) matches nothing; the sentinel "org" selects
  // organization-wide events (unitId IS NULL). Date params must be real
  // YYYY-MM-DD calendar dates; invalid input is ignored rather than
  // widening or narrowing the result silently.
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

  const [trainingEvents, allMembers] = await Promise.all([
    listTrainingEvents(orgId, {
      includeCancelled: true,
      unitId: trainingUnitId,
      from: trainingFromDate,
      to: trainingToDate,
    }),
    listMembers(orgId),
  ]);

  const trainingQuery = (overrides: Record<string, string | undefined>) => {
    const merged: Record<string, string | undefined> = {
      unit: trainingUnit,
      from: trainingFrom,
      to: trainingTo,
      ...overrides,
    };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) {
      if (value) params.set(key, value);
    }
    const qs = params.toString();
    return `/admin/organizations/${orgId}/training${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <nav aria-label="Breadcrumb" className="text-sm text-neutral-500">
        <Link href="/org" className="hover:underline">
          Organizations
        </Link>
        <span aria-hidden="true"> / </span>
        <Link href={`/org/${orgId}`} className="hover:underline">
          {organization.name}
        </Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page" className="text-neutral-800">
          Training
        </span>
      </nav>

      <h1 className="mt-4 text-lg font-semibold text-neutral-900">Training</h1>
      <p className="mt-1 text-sm text-neutral-600">
        Training events and attendance history. Cancelled events are kept for
        the record but do not count as attended.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <nav
          aria-label="Filter training by unit"
          className="text-sm whitespace-nowrap"
        >
          <Link
            href={trainingQuery({ unit: undefined })}
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
            href={trainingQuery({ unit: "org" })}
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
              href={trainingQuery({ unit: unit.id })}
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
          action={`/admin/organizations/${orgId}/training`}
          className="flex flex-wrap items-end gap-3"
        >
          {trainingUnit && (
            <input type="hidden" name="unit" value={trainingUnit} />
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
              name="from"
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
              name="to"
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
              href={trainingQuery({ from: undefined, to: undefined })}
              className="text-sm text-neutral-500 hover:underline"
            >
              Clear dates
            </Link>
          )}
        </form>
      </div>

      {trainingEvents.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">
          {trainingFiltered
            ? "No training events match the selected filters."
            : "No training events recorded yet."}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-neutral-200 rounded-md border border-neutral-200">
          {trainingEvents.map((event) => (
            <li
              key={event.id}
              className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
            >
              <span>
                <Link
                  href={`/admin/organizations/${orgId}/training/${event.id}`}
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

      <details className="mt-4 rounded-md border border-neutral-200 p-4">
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
    </div>
  );
}
