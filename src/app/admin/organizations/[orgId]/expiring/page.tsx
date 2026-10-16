import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrganization } from "@/lib/domain/organization";
import {
  listExpiringQualifications,
  expiryLabel,
} from "@/lib/domain/qualification";
import { OrgCapability } from "@prisma/client";

import {
  hasOrgCapability,
  requireOrgCapabilityOrNotFound,
} from "@/lib/auth/authorize";
import { calendarDateInZone } from "@/lib/dates";

export const metadata = { title: "Expiring certifications" };

export const dynamic = "force-dynamic";

export default async function ExpiringCertificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ expiring?: string }>;
}) {
  const { orgId } = await params;
  const ctx = await requireOrgCapabilityOrNotFound(
    orgId,
    OrgCapability.QUALIFICATIONS_MANAGE,
  );
  const { expiring } = await searchParams;
  const organization = await getOrganization(orgId);
  if (!organization) notFound();

  // Factual reporting window only — 30/60/90 is presentation, not policy.
  const expiryWindow = [30, 60, 90].includes(Number(expiring))
    ? Number(expiring)
    : 30;
  // "Today" is the organization's own local calendar date.
  const today = calendarDateInZone(organization.timezone);
  // Member pages need MEMBERS_MANAGE — degrade names to text for
  // qualification-only managers (issue #90).
  const canViewMembers = hasOrgCapability(
    ctx,
    orgId,
    OrgCapability.MEMBERS_MANAGE,
  );
  const expiringRecords = await listExpiringQualifications(orgId, {
    withinDays: expiryWindow,
    today,
    includeExpired: true,
  });

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
          Expiring certifications
        </span>
      </nav>

      <div className="mt-4 flex items-baseline justify-between gap-4">
        <h1 className="text-lg font-semibold text-neutral-900">
          Expiring certifications
        </h1>
        <nav aria-label="Expiry window" className="text-sm whitespace-nowrap">
          {[30, 60, 90].map((days) => (
            <Link
              key={days}
              href={`/admin/organizations/${orgId}/expiring?expiring=${days}`}
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
        <p className="mt-4 text-sm text-neutral-500">
          No records expire within {expiryWindow} days.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-neutral-200 rounded-md border border-neutral-200">
          {expiringRecords.map((record) => (
            <li
              key={record.id}
              className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
            >
              <span>
                {canViewMembers ? (
                  <Link
                    href={`/admin/organizations/${orgId}/members/${record.member.id}`}
                    className="font-medium text-neutral-900 hover:underline"
                  >
                    {record.member.displayName}
                  </Link>
                ) : (
                  <span className="font-medium text-neutral-900">
                    {record.member.displayName}
                  </span>
                )}
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
    </div>
  );
}
