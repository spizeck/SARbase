import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrganization } from "@/lib/domain/organization";
import { listMembers } from "@/lib/domain/member";
import {
  listQualificationDefinitions,
  listExpiringQualifications,
  expiryLabel,
  todayUtc,
} from "@/lib/domain/qualification";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";

import {
  updateOrganizationAction,
  createUnitAction,
  updateUnitAction,
  createMemberAction,
  createQualificationDefinitionAction,
  updateQualificationDefinitionAction,
  setQualificationDefinitionStatusAction,
} from "../../actions";
import {
  OrganizationForm,
  UnitCreateForm,
  UnitRenameForm,
  MemberForm,
  QualificationDefinitionForm,
} from "../../forms";

export const metadata = { title: "Organization" };

export const dynamic = "force-dynamic";

export default async function OrganizationPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ unit?: string; expiring?: string }>;
}) {
  const { orgId } = await params;
  // orgId from the URL is an untrusted selector: requireOrgAdminOrNotFound
  // checks the caller's OrganizationAccess rows, then resolves the org.
  await requireOrgAdminOrNotFound(orgId);
  const { unit: unitFilter, expiring } = await searchParams;

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
  const today = todayUtc();
  const expiringRecords = await listExpiringQualifications(orgId, {
    withinDays: expiryWindow,
    today,
    includeExpired: true,
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
                href={`/admin/organizations/${orgId}?expiring=${days}`}
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
