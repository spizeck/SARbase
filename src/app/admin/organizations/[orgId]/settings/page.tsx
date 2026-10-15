import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrganization } from "@/lib/domain/organization";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";
import { timeZoneOptions } from "@/lib/timezones";

import { updateOrganizationAction } from "../../../actions";
import { OrganizationForm } from "../../../forms";

export const metadata = { title: "Organization settings" };

export const dynamic = "force-dynamic";

export default async function OrganizationSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  // orgId from the URL is an untrusted selector: requireOrgAdminOrNotFound
  // checks the caller's OrganizationAccess rows, then resolves the org.
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
          Settings
        </span>
      </nav>

      <h1 className="mt-4 text-lg font-semibold text-neutral-900">
        Organization settings
      </h1>
      <p className="mt-1 text-sm text-neutral-600">
        The organization&rsquo;s name and reporting timezone.
      </p>

      <div className="mt-4 max-w-sm rounded-md border border-neutral-200 p-4">
        <OrganizationForm
          action={updateOrganizationAction.bind(null, orgId)}
          defaultName={organization.name}
          defaultTimeZone={organization.timezone}
          submitLabel="Save"
          timeZoneOptions={timeZoneOptions()}
        />
      </div>
    </div>
  );
}
