import Link from "next/link";
import { notFound } from "next/navigation";

import {
  isOrgAdmin,
  isOrgStaff,
  linkedMembersWithAccess,
  orgCapabilities,
  requireOrgAccessOrNotFound,
} from "@/lib/auth/authorize";
import { getOrganization } from "@/lib/domain/organization";
import { calendarDateInZone } from "@/lib/dates";

import { AdminDashboard, MemberDashboard } from "./dashboard-views";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

export default async function OrganizationDashboardPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  // Untrusted URL selector — the verified session's grants decide.
  const ctx = await requireOrgAccessOrNotFound(orgId);
  const organization = await getOrganization(orgId);
  if (!organization) notFound();

  const admin = isOrgAdmin(ctx, orgId);
  const staff = isOrgStaff(ctx, orgId);
  const capabilities = orgCapabilities(ctx, orgId);
  const myMember = linkedMembersWithAccess(ctx).find(
    (m) => m.organizationId === orgId,
  );
  const adminRoot = `/admin/organizations/${orgId}`;
  const orgToday = calendarDateInZone(organization.timezone);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">
            {organization.name}
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            {organization.timezone}
            {admin ? " · Administrator" : staff ? " · Manager" : ""}
          </p>
        </div>
        {admin && (
          <Link
            href={`${adminRoot}/settings`}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 hover:text-neutral-900"
          >
            Organization settings
          </Link>
        )}
      </div>

      {staff ? (
        <AdminDashboard
          orgId={orgId}
          adminRoot={adminRoot}
          timezone={organization.timezone}
          orgToday={orgToday}
          capabilities={capabilities}
          isAdmin={admin}
        />
      ) : (
        <MemberDashboard
          member={myMember}
          timezone={organization.timezone}
          orgToday={orgToday}
        />
      )}
    </div>
  );
}
