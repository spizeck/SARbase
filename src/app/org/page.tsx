import Link from "next/link";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/prisma";
import { isOrgAdmin, requireAuth } from "@/lib/auth/authorize";

export const metadata = { title: "Organizations" };
export const dynamic = "force-dynamic";

/**
 * Organization chooser — the post-sign-in landing. Every organization
 * the verified identity can access, labelled by role; each row opens
 * that organization's own dashboard. Membership list comes from
 * OrganizationAccess rows on the verified session — never from input.
 */
export default async function OrganizationsPage() {
  const ctx = await requireAuth();
  const organizations = await prisma.organization.findMany({
    where: { id: { in: ctx.access.map((a) => a.organizationId) } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, timezone: true },
  });

  const [only] = organizations;
  if (organizations.length === 1 && only) {
    redirect(`/org/${only.id}`);
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="text-xl font-semibold text-neutral-900">
        Your organizations
      </h1>

      {organizations.length === 0 ? (
        <div className="mt-6 rounded-lg border border-neutral-200 p-6">
          <p className="text-sm text-neutral-600">
            This account does not belong to an organization yet. Membership is
            granted by an organization administrator — once invited and
            accepted, the organization appears here.
          </p>
          <p className="mt-4 text-sm">
            <Link
              href="/account"
              className="font-medium text-neutral-900 underline underline-offset-2 hover:text-neutral-600"
            >
              Go to your account
            </Link>
          </p>
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-neutral-200 rounded-lg border border-neutral-200">
          {organizations.map((org) => (
            <li key={org.id}>
              <Link
                href={`/org/${org.id}`}
                className="flex items-center justify-between gap-4 px-4 py-3.5 hover:bg-neutral-50 focus:bg-neutral-50"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-neutral-900">
                    {org.name}
                  </span>
                  <span className="mt-0.5 block text-xs text-neutral-500">
                    {org.timezone}
                  </span>
                </span>
                <span className="shrink-0 rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs font-medium text-neutral-600">
                  {isOrgAdmin(ctx, org.id) ? "Admin" : "Member"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-6 text-sm text-neutral-500">
        <Link
          href="/account"
          className="underline underline-offset-2 hover:text-neutral-700"
        >
          Account settings
        </Link>
      </p>
    </main>
  );
}
