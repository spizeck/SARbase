import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrganization } from "@/lib/domain/organization";
import { listMembers } from "@/lib/domain/member";
import { adminSurfaceEnabled } from "@/lib/admin-gate";

import {
  updateOrganizationAction,
  createUnitAction,
  updateUnitAction,
  createMemberAction,
} from "../../actions";
import {
  OrganizationForm,
  UnitCreateForm,
  UnitRenameForm,
  MemberForm,
} from "../../forms";

export const metadata = { title: "Organization" };

export const dynamic = "force-dynamic";

export default async function OrganizationPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ unit?: string }>;
}) {
  // Temporary bootstrap gate — removed by issue #6 (see lib/admin-gate).
  if (!adminSurfaceEnabled()) notFound();

  const { orgId } = await params;
  const { unit: unitFilter } = await searchParams;

  const organization = await getOrganization(orgId);
  if (!organization) notFound();

  const filterUnit = unitFilter
    ? organization.units.find((u) => u.id === unitFilter)
    : undefined;
  const members = await listMembers(orgId, {
    unitId: filterUnit?.id,
  });

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
            Rename organization
          </h2>
          <div className="mt-2">
            <OrganizationForm
              action={updateOrganizationAction.bind(null, orgId)}
              defaultName={organization.name}
              submitLabel="Save"
            />
          </div>
        </div>
      </section>

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
                  action={updateUnitAction.bind(null, unit.id, orgId)}
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

      <section aria-labelledby="members-heading" className="mt-10">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="members-heading" className="text-lg font-medium">
            Members
          </h2>
          {organization.units.length > 0 && (
            <nav aria-label="Filter members by unit" className="text-sm">
              <Link
                href={`/admin/organizations/${orgId}`}
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
                  href={`/admin/organizations/${orgId}?unit=${unit.id}`}
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
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200">
                {members.map((member) => (
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
                  </tr>
                ))}
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
