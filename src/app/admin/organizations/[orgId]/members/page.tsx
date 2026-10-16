import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrganization } from "@/lib/domain/organization";
import { listMembers } from "@/lib/domain/member";
import {
  listOrganizationAvailability,
  AVAILABILITY_STATUS_LABELS,
} from "@/lib/domain/availability";
import { OrgCapability } from "@prisma/client";

import {
  isOrgAdmin,
  requireOrgCapabilityOrNotFound,
} from "@/lib/auth/authorize";
import {
  calendarDateInZone,
  formatDateOnly,
  relativeTimeLabel,
} from "@/lib/dates";
import { phoneRegionOptions } from "@/lib/contact";

import { createMemberAction } from "../../../actions";
import { MemberForm } from "../../../forms";

export const metadata = { title: "Members" };

export const dynamic = "force-dynamic";

export default async function MembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ unit?: string }>;
}) {
  const { orgId } = await params;
  const ctx = await requireOrgCapabilityOrNotFound(
    orgId,
    OrgCapability.MEMBERS_MANAGE,
  );
  const { unit: unitFilter } = await searchParams;
  const organization = await getOrganization(orgId);
  if (!organization) notFound();

  // A unit id that is not one of this organization's units (foreign or
  // fabricated) simply isn't found — filtering can never widen scope.
  const filterUnit = unitFilter
    ? organization.units.find((u) => u.id === unitFilter)
    : undefined;
  const members = await listMembers(orgId, { unitId: filterUnit?.id });

  // Current factual availability per member — informational only; the
  // table sorts alphabetically, never by "best" status.
  const today = calendarDateInZone(organization.timezone);
  const availability = await listOrganizationAvailability(orgId, today);

  const memberQuery = (unitId?: string) =>
    `/admin/organizations/${orgId}/members${unitId ? `?unit=${unitId}` : ""}`;

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
          Members
        </span>
      </nav>

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-lg font-semibold text-neutral-900">Members</h1>
        {organization.units.length > 0 && (
          <nav
            aria-label="Filter members by unit"
            className="text-sm whitespace-nowrap"
          >
            <Link
              href={memberQuery()}
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
                href={memberQuery(unit.id)}
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
        <p className="mt-4 text-sm text-neutral-500">
          {filterUnit ? `No members in ${filterUnit.name}.` : "No members yet."}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-md border border-neutral-200">
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
                <th
                  scope="col"
                  className="px-4 py-2 text-left font-medium text-neutral-700"
                >
                  Availability
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {members.map((member) => {
                const memberAvailability = availability.get(member.id);
                return (
                  <tr key={member.id}>
                    <td className="px-4 py-2">
                      <Link
                        href={`/admin/organizations/${orgId}/members/${member.id}`}
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
                    <td className="px-4 py-2 text-neutral-600">
                      {
                        AVAILABILITY_STATUS_LABELS[
                          memberAvailability?.status ?? "UNKNOWN"
                        ]
                      }
                      {memberAvailability?.latest?.until &&
                        !memberAvailability.expired &&
                        memberAvailability.status !== "UNKNOWN" && (
                          <span className="text-neutral-500">
                            {" "}
                            until{" "}
                            {formatDateOnly(memberAvailability.latest.until)}
                          </span>
                        )}
                      {memberAvailability?.latest && (
                        <span className="block text-xs text-neutral-400">
                          {memberAvailability.expired ? "expired — " : ""}
                          updated{" "}
                          {relativeTimeLabel(
                            memberAvailability.latest.createdAt,
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 rounded-md border border-neutral-200 p-4">
        <h2 className="text-sm font-medium text-neutral-800">New member</h2>
        <div className="mt-2">
          <MemberForm
            action={createMemberAction.bind(null, orgId)}
            showEmergencyContact={isOrgAdmin(ctx, orgId)}
            submitLabel="Add member"
            regions={phoneRegionOptions()}
          />
        </div>
      </div>
    </div>
  );
}
