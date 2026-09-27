import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { requireAuth, adminOrganizationIds } from "@/lib/auth/authorize";

import { createOrganizationAction } from "./actions";
import { OrganizationForm } from "./forms";

export const metadata = { title: "Administration" };

// Reads live records and auth state — never prerender.
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const ctx = await requireAuth();
  const adminOrgIds = adminOrganizationIds(ctx);

  // Scoped listing: only organizations this account administers.
  const organizations = await prisma.organization.findMany({
    where: { id: { in: adminOrgIds } },
    orderBy: { name: "asc" },
    include: { _count: { select: { units: true, members: true } } },
  });

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Administration</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Manage organizations, units, and member records you administer.
      </p>

      <section aria-labelledby="organizations-heading" className="mt-8">
        <h2 id="organizations-heading" className="text-lg font-medium">
          Organizations
        </h2>
        {organizations.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            You do not administer any organizations yet. Create one below, or
            ask an existing administrator to grant you access.
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
        <p className="mt-1 text-sm text-neutral-600">
          You become its administrator.
        </p>
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
