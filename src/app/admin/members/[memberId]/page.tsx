import Link from "next/link";
import { notFound } from "next/navigation";

import { getMember } from "@/lib/domain/member";
import { listUnits } from "@/lib/domain/unit";
import { adminSurfaceEnabled } from "@/lib/admin-gate";

import {
  updateMemberAction,
  setMemberStatusAction,
  setMemberUnitsAction,
} from "../../actions";
import { MemberForm, MemberUnitsForm } from "../../forms";

export const metadata = { title: "Member" };

export const dynamic = "force-dynamic";

export default async function MemberPage({
  params,
}: {
  params: Promise<{ memberId: string }>;
}) {
  // Temporary bootstrap gate — removed by issue #6 (see lib/admin-gate).
  if (!adminSurfaceEnabled()) notFound();

  const { memberId } = await params;
  const member = await getMember(memberId);
  if (!member) notFound();

  const orgId = member.organizationId;
  const units = await listUnits(orgId);
  const assignedUnitIds = member.memberUnits.map((mu) => mu.unitId);
  const isActive = member.status === "ACTIVE";

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <nav aria-label="Breadcrumb" className="text-sm text-neutral-500">
        <Link href="/admin" className="hover:underline">
          Administration
        </Link>
        <span aria-hidden="true"> / </span>
        <Link
          href={`/admin/organizations/${orgId}`}
          className="hover:underline"
        >
          {member.organization.name}
        </Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page" className="text-neutral-800">
          {member.displayName}
        </span>
      </nav>

      <div className="mt-6 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          {member.displayName}
        </h1>
        <span
          className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
            isActive
              ? "bg-green-100 text-green-800"
              : "bg-neutral-100 text-neutral-600"
          }`}
        >
          {isActive ? "Active" : "Inactive"}
        </span>
      </div>

      <section
        aria-labelledby="status-heading"
        className="mt-4 rounded-md border border-neutral-200 p-4"
      >
        <h2
          id="status-heading"
          className="text-sm font-medium text-neutral-800"
        >
          Membership status
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          {isActive
            ? "Deactivating preserves this record and its history; the member stops appearing as active."
            : "Reactivating restores this member to active status. The record and its history were preserved."}
        </p>
        <form
          action={setMemberStatusAction.bind(
            null,
            member.id,
            orgId,
            isActive ? "INACTIVE" : "ACTIVE",
          )}
          className="mt-3"
        >
          <button
            type="submit"
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
          >
            {isActive ? "Deactivate member" : "Reactivate member"}
          </button>
        </form>
      </section>

      <section
        aria-labelledby="details-heading"
        className="mt-6 rounded-md border border-neutral-200 p-4"
      >
        <h2
          id="details-heading"
          className="text-sm font-medium text-neutral-800"
        >
          Contact details
        </h2>
        <div className="mt-2">
          <MemberForm
            action={updateMemberAction.bind(null, member.id, orgId)}
            defaults={{
              displayName: member.displayName,
              email: member.email,
              phone: member.phone,
            }}
            submitLabel="Save changes"
          />
        </div>
      </section>

      <section
        aria-labelledby="units-heading"
        className="mt-6 rounded-md border border-neutral-200 p-4"
      >
        <h2 id="units-heading" className="text-sm font-medium text-neutral-800">
          Units
        </h2>
        <div className="mt-2">
          <MemberUnitsForm
            action={setMemberUnitsAction.bind(null, member.id, orgId)}
            units={units}
            assignedUnitIds={assignedUnitIds}
          />
        </div>
      </section>
    </main>
  );
}
