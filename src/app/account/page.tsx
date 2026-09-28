import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/auth/authorize";
import { signOutAction } from "@/app/login/actions";
import {
  listMemberQualifications,
  expiryLabel,
  formatDateOnly,
  todayUtc,
} from "@/lib/domain/qualification";

export const metadata = { title: "Account" };

export const dynamic = "force-dynamic";

/**
 * Minimal authenticated landing page: proves the identity, linked Member
 * context, organization scope, and role — no member self-service yet.
 */
export default async function AccountPage() {
  const ctx = await requireAuth();

  const orgIds = [
    ...new Set([
      ...ctx.access.map((a) => a.organizationId),
      ...ctx.members.map((m) => m.organizationId),
    ]),
  ];
  const orgs = orgIds.length
    ? await prisma.organization.findMany({ where: { id: { in: orgIds } } })
    : [];
  const orgName = (id: string) =>
    orgs.find((o) => o.id === id)?.name ?? "Unknown organization";

  const adminOrgs = ctx.access.filter((a) => a.role === "ADMIN");

  // Qualification records for the caller's own linked member records only —
  // member ids come from ctx.members (server-resolved), never from the client.
  const today = todayUtc();
  const ownQualifications = await Promise.all(
    ctx.members.map(async (member) => ({
      member,
      records: await listMemberQualifications(member.id),
    })),
  );

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
        <form action={signOutAction}>
          <button
            type="submit"
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
          >
            Sign out
          </button>
        </form>
      </div>

      <section aria-labelledby="identity-heading" className="mt-6">
        <h2
          id="identity-heading"
          className="text-sm font-medium text-neutral-500"
        >
          Signed in as
        </h2>
        <p className="mt-1 text-sm text-neutral-900">
          {ctx.identity.email ?? "Account without email"}
        </p>
      </section>

      <section aria-labelledby="memberships-heading" className="mt-8">
        <h2 id="memberships-heading" className="text-lg font-medium">
          Member records
        </h2>
        {ctx.members.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600">
            This sign-in is not linked to a member record yet. An organization
            administrator can link it.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {ctx.members.map((member) => (
              <li key={member.id} className="px-4 py-3 text-sm">
                <span className="font-medium text-neutral-900">
                  {member.displayName}
                </span>
                <span className="text-neutral-500">
                  {" "}
                  — {orgName(member.organizationId)} (
                  {member.status === "ACTIVE" ? "active" : "inactive"})
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {ownQualifications.some((g) => g.records.length > 0) && (
        <section aria-labelledby="qualifications-heading" className="mt-8">
          <h2 id="qualifications-heading" className="text-lg font-medium">
            My qualifications &amp; certifications
          </h2>
          {ownQualifications.map(({ member, records }) =>
            records.length === 0 ? null : (
              <div key={member.id} className="mt-3">
                <h3 className="text-sm font-medium text-neutral-500">
                  {orgName(member.organizationId)}
                </h3>
                <ul className="mt-1 divide-y divide-neutral-200 rounded-md border border-neutral-200">
                  {records.map((record) => (
                    <li key={record.id} className="px-4 py-3 text-sm">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-medium text-neutral-900">
                          {record.definition.name}
                        </span>
                        <span className="text-xs text-neutral-600">
                          {expiryLabel(record.expiresOn, today)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-neutral-500">
                        Issued{" "}
                        {formatDateOnly(record.issuedOn) ?? "not recorded"}
                        {record.issuer ? ` · ${record.issuer}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </section>
      )}

      <section aria-labelledby="access-heading" className="mt-8">
        <h2 id="access-heading" className="text-lg font-medium">
          Organization access
        </h2>
        {ctx.access.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600">
            No organization access has been granted to this account.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {ctx.access.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between px-4 py-3 text-sm"
              >
                <span className="font-medium text-neutral-900">
                  {orgName(a.organizationId)}
                </span>
                <span className="text-neutral-500">
                  {a.role === "ADMIN" ? "Administrator" : "Member"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {adminOrgs.length > 0 && (
        <p className="mt-8">
          <Link
            href="/admin"
            className="text-sm font-medium text-neutral-900 underline underline-offset-4 hover:text-neutral-600"
          >
            Go to administration
          </Link>
        </p>
      )}
    </main>
  );
}
