import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrganization } from "@/lib/domain/organization";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";

import { createUnitAction, updateUnitAction } from "../../../actions";
import { UnitCreateForm, UnitRenameForm } from "../../../forms";

export const metadata = { title: "Units" };

export const dynamic = "force-dynamic";

export default async function UnitsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  await requireOrgAdminOrNotFound(orgId);
  const organization = await getOrganization(orgId);
  if (!organization) notFound();

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
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
          Units
        </span>
      </nav>

      <h1 className="mt-4 text-lg font-semibold text-neutral-900">Units</h1>
      <p className="mt-1 text-sm text-neutral-600">
        Internal groupings such as stations, bases, or teams. Optional — an
        organization may have none.
      </p>

      {organization.units.length > 0 && (
        <ul className="mt-4 space-y-2">
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

      <div className="mt-4 rounded-md border border-neutral-200 p-4">
        <UnitCreateForm action={createUnitAction.bind(null, orgId)} />
      </div>
    </div>
  );
}
