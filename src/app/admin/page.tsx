import Link from "next/link";
import { notFound } from "next/navigation";

import { listOrganizations } from "@/lib/domain/organization";
import { adminSurfaceEnabled } from "@/lib/admin-gate";

import { createOrganizationAction } from "./actions";
import { OrganizationForm } from "./forms";

export const metadata = { title: "Administration" };

// Reads live records — never prerender at build time.
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  // Temporary bootstrap gate — removed by issue #6 (see lib/admin-gate).
  if (!adminSurfaceEnabled()) notFound();

  const organizations = await listOrganizations();

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Administration</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Manage organizations, units, and member records. Internal administration
        only — authentication and authorization are enforced in a later release.
      </p>

      <section aria-labelledby="organizations-heading" className="mt-8">
        <h2 id="organizations-heading" className="text-lg font-medium">
          Organizations
        </h2>
        {organizations.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            No organizations yet. Create one below.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {organizations.map((org) => (
              <li key={org.id}>
                <Link
                  href={`/admin/organizations/${org.id}`}
                  className="flex items-center justify-between px-4 py-3 text-sm hover:bg-neutral-50"
                >
                  <span className="font-medium text-neutral-900">
                    {org.name}
                  </span>
                  <span className="text-neutral-500">
                    {org._count.units} unit{org._count.units === 1 ? "" : "s"},{" "}
                    {org._count.members} member
                    {org._count.members === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="create-organization-heading"
        className="mt-8 rounded-md border border-neutral-200 p-4"
      >
        <h2 id="create-organization-heading" className="text-lg font-medium">
          New organization
        </h2>
        <div className="mt-3">
          <OrganizationForm
            action={createOrganizationAction}
            submitLabel="Create organization"
          />
        </div>
      </section>
    </main>
  );
}
