import Link from "next/link";
import { notFound } from "next/navigation";

import { getMember } from "@/lib/domain/member";
import { listUnits } from "@/lib/domain/unit";
import {
  listMemberQualifications,
  listQualificationDefinitions,
  expiryLabel,
} from "@/lib/domain/qualification";
import { calendarDateInZone, formatDateOnly } from "@/lib/dates";
import { requireAuth, isOrgAdmin } from "@/lib/auth/authorize";

import {
  updateMemberAction,
  setMemberStatusAction,
  setMemberUnitsAction,
  linkIdentityToMemberAction,
  unlinkIdentityFromMemberAction,
  createMemberQualificationAction,
  updateMemberQualificationAction,
} from "../../actions";
import {
  MemberForm,
  MemberUnitsForm,
  LinkIdentityForm,
  MemberQualificationForm,
} from "../../forms";

export const metadata = { title: "Member" };

export const dynamic = "force-dynamic";

export default async function MemberPage({
  params,
}: {
  params: Promise<{ memberId: string }>;
}) {
  const ctx = await requireAuth();
  const { memberId } = await params;
  // memberId is an untrusted selector — resolve the record, then check
  // ADMIN access to the member's REAL organizationId, not a supplied one.
  const member = await getMember(memberId);
  if (!member || !isOrgAdmin(ctx, member.organizationId)) notFound();

  const orgId = member.organizationId;
  const units = await listUnits(orgId);
  const assignedUnitIds = member.memberUnits.map((mu) => mu.unitId);
  const isActive = member.status === "ACTIVE";

  const today = calendarDateInZone(member.organization.timezone);
  const qualifications = await listMemberQualifications(member.id);
  const activeDefinitions = await listQualificationDefinitions(orgId);

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
            action={updateMemberAction.bind(null, member.id)}
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
            action={setMemberUnitsAction.bind(null, member.id)}
            units={units}
            assignedUnitIds={assignedUnitIds}
          />
        </div>
      </section>

      <section aria-labelledby="qualifications-heading" className="mt-8">
        <h2 id="qualifications-heading" className="text-lg font-medium">
          Qualifications &amp; certifications
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          Certificates and qualification records held by this member. Renewals
          are added as new records so history is preserved.
        </p>
        {qualifications.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {qualifications.map((record) => (
              <li
                key={record.id}
                className="rounded-md border border-neutral-200 p-3"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-neutral-900">
                    {record.definition.name}
                  </span>
                  <span className="text-xs text-neutral-600">
                    {expiryLabel(record.expiresOn, today)}
                  </span>
                </div>
                <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-neutral-600 sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-neutral-500">Issued</dt>
                    <dd>{formatDateOnly(record.issuedOn) ?? "Not recorded"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-neutral-500">Expires</dt>
                    <dd>{formatDateOnly(record.expiresOn) ?? "No expiry"}</dd>
                  </div>
                  {record.issuer && (
                    <div>
                      <dt className="text-xs text-neutral-500">Issuer</dt>
                      <dd>{record.issuer}</dd>
                    </div>
                  )}
                  {record.reference && (
                    <div>
                      <dt className="text-xs text-neutral-500">Reference</dt>
                      <dd>{record.reference}</dd>
                    </div>
                  )}
                </dl>
                {record.notes && (
                  <p className="mt-1 text-sm text-neutral-600">
                    {record.notes}
                  </p>
                )}
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-neutral-600 hover:text-neutral-900">
                    Correct record
                  </summary>
                  <div className="mt-2">
                    <MemberQualificationForm
                      action={updateMemberQualificationAction.bind(
                        null,
                        record.id,
                      )}
                      definitionName={record.definition.name}
                      defaults={{
                        issuedOn: formatDateOnly(record.issuedOn),
                        expiresOn: formatDateOnly(record.expiresOn),
                        issuer: record.issuer,
                        reference: record.reference,
                        notes: record.notes,
                      }}
                      submitLabel="Save correction"
                    />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-neutral-500">
            No qualification records yet.
          </p>
        )}
        {activeDefinitions.length > 0 ? (
          <div className="mt-3 rounded-md border border-neutral-200 p-4">
            <h3 className="text-sm font-medium text-neutral-800">
              Add qualification record
            </h3>
            <div className="mt-2">
              <MemberQualificationForm
                action={createMemberQualificationAction.bind(null, member.id)}
                definitions={activeDefinitions.map((d) => ({
                  id: d.id,
                  name: d.name,
                }))}
                submitLabel="Add record"
              />
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-neutral-500">
            Define qualifications on the organization page before adding member
            records.
          </p>
        )}
      </section>

      <section
        aria-labelledby="login-heading"
        className="mt-6 rounded-md border border-neutral-200 p-4"
      >
        <h2 id="login-heading" className="text-sm font-medium text-neutral-800">
          Login account
        </h2>
        {member.authIdentityId ? (
          <div className="mt-2">
            <p className="text-sm text-neutral-600">
              This member record is linked to a sign-in identity. Unlinking
              removes that identity&apos;s member context — it does not remove
              the identity&apos;s organization access grants.
            </p>
            <form
              action={unlinkIdentityFromMemberAction.bind(null, member.id)}
              className="mt-3"
            >
              <button
                type="submit"
                className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
              >
                Unlink login identity
              </button>
            </form>
          </div>
        ) : (
          <div className="mt-2">
            <p className="mt-1 text-sm text-neutral-600">
              No sign-in identity linked. To grant this member login access,
              have them sign in once, then link their identity here by its email
              address.
            </p>
            <div className="mt-3">
              <LinkIdentityForm
                action={linkIdentityToMemberAction.bind(null, member.id)}
              />
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
