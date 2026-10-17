import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrganization } from "@/lib/domain/organization";
import {
  getQualificationCoverage,
  expiryLabel,
  formatDateOnly,
} from "@/lib/domain/qualification";
import { OrgCapability } from "@prisma/client";

import {
  hasOrgCapability,
  requireOrgCapabilityOrNotFound,
} from "@/lib/auth/authorize";

export const metadata = { title: "Qualification coverage" };

export const dynamic = "force-dynamic";

export default async function QualificationCoveragePage({
  params,
}: {
  params: Promise<{ orgId: string; definitionId: string }>;
}) {
  const { orgId, definitionId } = await params;
  const ctx = await requireOrgCapabilityOrNotFound(
    orgId,
    OrgCapability.QUALIFICATIONS_MANAGE,
  );
  const organization = await getOrganization(orgId);
  if (!organization) notFound();

  // Member detail pages need MEMBERS_MANAGE — degrade names to text for
  // qualification-only managers (issue #90).
  const canViewMembers = hasOrgCapability(
    ctx,
    orgId,
    OrgCapability.MEMBERS_MANAGE,
  );

  const coverage = await getQualificationCoverage(orgId, definitionId);
  if (!coverage) notFound();

  const { definition, today, rows } = coverage;
  const withRecord = rows.filter((r) => r.latestRecord !== null);
  const withoutRecord = rows.length - withRecord.length;

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
        <Link
          href={`/admin/organizations/${orgId}/qualifications`}
          className="hover:underline"
        >
          Qualifications
        </Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page" className="text-neutral-800">
          {definition.name}
        </span>
      </nav>

      <h1 className="mt-4 text-lg font-semibold text-neutral-900">
        {definition.name} — coverage
      </h1>
      <p className="mt-1 text-sm text-neutral-600">
        Latest recorded qualification per active member. {withRecord.length} of{" "}
        {rows.length} active member
        {rows.length === 1 ? "" : "s"} have a record
        {withoutRecord > 0 ? `; ${withoutRecord} have none` : ""}. No record is
        missing information, not a judgement of competence.
      </p>
      <p className="mt-1 text-sm text-neutral-600">
        <Link
          href={`/admin/organizations/${orgId}/expiring`}
          className="text-neutral-800 underline"
        >
          Expiring certifications
        </Link>{" "}
        lists all records nearing expiry across definitions.
      </p>

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">
          This organization has no active members.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-neutral-200 rounded-md border border-neutral-200">
          {rows.map((row) => (
            <li
              key={row.member.id}
              className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
            >
              <div>
                {canViewMembers ? (
                  <Link
                    href={`/admin/organizations/${orgId}/members/${row.member.id}`}
                    className="font-medium text-neutral-900 hover:underline"
                  >
                    {row.member.displayName}
                  </Link>
                ) : (
                  <span className="font-medium text-neutral-900">
                    {row.member.displayName}
                  </span>
                )}
                {row.units.length > 0 && (
                  <span className="text-neutral-600">
                    {" "}
                    — {row.units.join(", ")}
                  </span>
                )}
              </div>
              <div className="text-right text-neutral-600">
                {row.latestRecord ? (
                  <>
                    <span className="block">
                      {expiryLabel(row.latestRecord.expiresOn, today)}
                    </span>
                    {row.latestRecord.issuedOn && (
                      <span className="block text-xs">
                        Issued {formatDateOnly(row.latestRecord.issuedOn)}
                        {row.recordCount > 1
                          ? ` · ${row.recordCount} records`
                          : ""}
                      </span>
                    )}
                  </>
                ) : (
                  <span>No record</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
